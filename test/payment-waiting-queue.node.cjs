'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentWaitingQueue, PaymentQueueFullError, queueFeedback, FULL_MESSAGE } = require('../src/payments/payment-waiting-queue');
const { CardBusyError, CardPreparationError, FundingAwaitingError } = require('../src/orbitcard/orbitcard-card-policy');
const locks = require('./helpers/payment-locks.cjs');
const session = { accessToken: 'synthetic', user: { email: 'fixture@example.test' }, account: {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
    const db = options.db || locks(), activeJobs = new Set();
    let now = 1000, max = 1;
    const sleeps = [];
    const store = { acquirePaymentLock: db.acquirePaymentLock, getMaxConcurrentActivations: async () => max };
    const queue = createPaymentWaitingQueue({ store, activeJobs, now: () => now,
        sleep: async ms => { sleeps.push(ms); now += ms; await options.onSleep?.({ activeJobs, queue }); }, ...options });
    const cfg = { executionGuard: { async assertOwned() {} }, paymentGuard: { async assertAllowed() {} } };
    return { db, activeJobs, store, queue, cfg, sleeps, advance: ms => { now += ms; }, setMax: value => { max = value; } };
}

test('one waiting ticket is reserved before asynchronous lock acquisition across callers and instances', async () => {
    const db = locks(), first = fixture({db}), other = fixture({db});
    const results = await Promise.allSettled(Array.from({length: 12}, (_, i) => first.queue.acquire('job-' + i)));
    const winners = results.filter(result => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason instanceof PaymentQueueFullError));
    await assert.rejects(other.queue.acquire('another-instance'), PaymentQueueFullError);
    assert.equal(other.queue.isFull(), false, 'a failed remote claim cannot leak the local waiting reservation');
    await winners[0].value.release(); await winners[0].value.release();
    const next = await other.queue.acquire('next'); await next.release();
    assert.equal(db.owners.size, 0);
});

test('capacity wait survives completion and authorization synchronization until a real card reservation', async () => {
    let attempts = 0, notices = 0;
    const f = fixture({onSleep: ({activeJobs}) => activeJobs.delete('first')});
    f.activeJobs.add('first'); f.activeJobs.add('waiting');
    const ticket = await f.queue.acquire('waiting');
    assert.equal(f.queue.activeCount(), 1); assert.equal(f.queue.count, 1);
    await f.queue.waitForCapacity(ticket, {session, cfg:f.cfg});
    assert.equal(f.queue.activeCount(), 1, 'selecting the next card occupies the foreground slot');
    assert.equal(f.queue.isFull(), true, 'a foreground opening alone must not free the waiting ticket');
    const result = await f.queue.allocate({key:'waiting',session,cfg:f.cfg,
        onWait: async () => { notices++; }, allocate: async () => {
            attempts++;
            await assert.rejects(f.queue.acquire('late-arrival'), PaymentQueueFullError);
            if (attempts < 3) throw new CardBusyError('authorization synchronization');
            return 42;
        }});
    assert.equal(result,42); assert.equal(attempts,3); assert.equal(notices,1);
    assert.equal(f.queue.isFull(),false); assert.equal(f.queue.activeCount(),1); assert.equal(f.db.owners.size,0);
});

test('waiting cancellation settles real CDK transactions without creating a card or a subscription', async t => {
    const oldKey=process.env.ORBITCARD_API_KEY, oldSecret=process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='synthetic';
    t.after(()=>{for(const [name,value] of [['ORBITCARD_API_KEY',oldKey],['ORBITCARD_API_SECRET',oldSecret]]) {
        if(value===undefined)delete process.env[name];else process.env[name]=value;
    }});
    for(const reason of ['timeout','shutdown','expired-session']) {
        const f=require('./helpers/card-db.cjs')(); let now=0,resume;
        const activeJobs=new Set(['first']), input=structuredClone(session);
        f.db.cdks.push({cdk_code:'CODE-WAIT',type:'自助',is_active:1,plan_type:'plus',used_at:null});
        Object.assign(f.store,{
            verifyCdkDetails:async()=>structuredClone(f.db.cdks[0]),getRunningTaskByCdk:async()=>null,
            getMaintenanceModeState:async()=>({}),getMaxConcurrentActivations:async()=>1,
            getGptApiConfig:async()=>({enabled:true,base_url:f.base,api_key:'key'})
        });
        const queue=createPaymentWaitingQueue({store:f.store,activeJobs,now:()=>now,waitMs:5000,
            sleep:()=>new Promise(resolve=>{resume=resolve;})});
        const handler=require('../src/payments/activation-service')({store:f.store,activeJobs,waitingQueue:queue,
            ensureStoreReady:async()=>{},log(){},runWorker:()=>assert.fail('waiting task cannot submit')});
        const res={status(code){this.code=code;return this;},json(data){this.data=data;}};
        await handler({body:{cdk:'CODE-WAIT',session:input}},res);await flush();
        assert.equal(res.data.queued,true);assert.ok(f.db.cdks[0].used_at);
        if(reason==='timeout')now=5000;
        if(reason==='shutdown')queue.close();
        if(reason==='expired-session')input.expires='2000-01-01';
        resume();await flush();await flush();
        assert.equal(f.db.tasks[0].orbitcard_state,'rejected');assert.equal(f.db.cdks[0].used_at,null);
        assert.equal(f.db.fundings.length,0);assert.equal(f.db.issues.length,0);assert.equal(f.db.uses.length,0);
        assert.equal(queue.isFull(),false);assert.equal(activeJobs.size,1);
        assert.ok(await f.store.acquirePaymentLock('cdk:code-wait').then(async guard=>{if(guard)await guard.release();return Boolean(guard);}));
    }
});

test('restart recovery releases an unsubmitted waiter but preserves a retry CDK support lock', async () => {
    for(const retry of [false,true]) {
        const f=require('./helpers/card-db.cjs')(), activeJobs=new Set();
        const task=await f.claim();f.db.tasks[0].orbitcard_state='preparing';
        f.db.tasks[0].message='支付卡繁忙，排队等待';
        if(retry)f.db.tasks[0].orbitcard_retry_attempt_no=2;
        f.store.getGptApiConfig=async()=>({enabled:true,base_url:f.base,api_key:'key'});
        const recovery=require('../src/payments/order-recovery')({store:f.store,activeJobs,audit(){},
            query:{refresh:async()=>assert.fail('unsubmitted waiting order has no subscription')}});
        await recovery.refreshTask(await f.store.getTaskStatus(task.jobKey));
        assert.equal(f.db.tasks[0].orbitcard_state,retry?'support_locked':'rejected');
        assert.equal(Boolean(f.db.cdks[0].used_at),retry);
    }
});

test('a busy card creates exactly one waiter while another already-admitted task may keep its own selection', async () => {
    let resume;
    const f = fixture({sleep: () => new Promise(resolve => { resume = resolve; })});
    f.setMax(3); f.activeJobs.add('a'); f.activeJobs.add('b'); f.activeJobs.add('c');
    let busy = true;
    const waiting = f.queue.allocate({key:'b',session,cfg:f.cfg,allocate:async()=> {
        if (busy) throw new CardBusyError('busy'); return 42;
    }});
    await flush(); assert.equal(f.queue.count,1);
    // An already-admitted worker, including the card's owner, must not be rejected
    // merely because a later request has entered the capacity queue.
    assert.equal(await f.queue.allocate({key:'a',session,cfg:f.cfg,allocate:async()=>99}),99);
    await assert.rejects(f.queue.allocate({key:'c',session,cfg:f.cfg,allocate:async()=>{throw new CardBusyError('busy');}}),PaymentQueueFullError);
    busy=false; resume(); assert.equal(await waiting,42); assert.equal(f.queue.isFull(),false);
});

test('unknown card data and funding waits are never retried as card contention', async () => {
    for (const error of [new CardPreparationError('unknown data'), new FundingAwaitingError('original funding')]) {
        const f = fixture(); f.activeJobs.add('job');
        const ticket = await f.queue.acquire('job'); let attempts=0;
        await assert.rejects(f.queue.allocate({key:'job',session,cfg:f.cfg,allocate:async()=>{attempts++;throw error;}}), error);
        assert.equal(attempts,1); assert.equal(f.sleeps.length,0); assert.equal(f.queue.isFull(),false);
        await ticket.release(); assert.equal(f.db.owners.size,0);
    }
});

test('busy waiting has one total deadline, releases its slot, and does not call payment after timeout', async () => {
    const f = fixture({waitMs:10000}); f.activeJobs.add('job'); let attempts=0;
    await assert.rejects(f.queue.allocate({key:'job',session,cfg:f.cfg,allocate:async()=>{attempts++;throw new CardBusyError('busy');}}),
        error=>error.code==='PAYMENT_QUEUE_TIMEOUT');
    assert.equal(attempts,2); assert.deepEqual(f.sleeps,[5000,5000]); assert.equal(f.queue.isFull(),false);
});

test('expired credentials, cancellation and lost execution ownership stop before selecting or submitting', async () => {
    for (const reason of ['expired','shutdown','ownership']) {
        const f = fixture(); f.activeJobs.add('job');
        await f.queue.acquire('job');
        const input = structuredClone(session);
        if(reason==='expired')input.expires='2000-01-01';
        if(reason==='shutdown')f.queue.close();
        if(reason==='ownership')f.cfg.executionGuard.assertOwned=async()=>{throw Error('execution lost');};
        await assert.rejects(f.queue.allocate({key:'job',session:input,cfg:f.cfg,allocate:async()=>assert.fail('must not select')}));
        assert.equal(f.queue.isFull(),false);assert.equal(f.db.owners.size,0);
    }
});

test('queue feedback survives a persisted task message without interpreting ordinary provider errors', () => {
    assert.deepEqual(queueFeedback(new PaymentQueueFullError()),{error_code:'PAYMENT_QUEUE_FULL',retry_after_seconds:600});
    assert.deepEqual(queueFeedback('支付准备失败：'+FULL_MESSAGE+'；本次充值未提交'),{error_code:'PAYMENT_QUEUE_FULL',retry_after_seconds:600});
    assert.deepEqual(queueFeedback('HTTP 429 from provider'),{});
});

test('CDK admission queues one request, preserves its identity, and rejects overflow before creating a task', async t => {
    const secret=process.env.ORBITCARD_API_SECRET, apiKey=process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET='synthetic'; process.env.ORBITCARD_API_KEY='key';
    t.after(()=>{if(secret===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=secret;
        if(apiKey===undefined)delete process.env.ORBITCARD_API_KEY;else process.env.ORBITCARD_API_KEY=apiKey;});
    let resume, created=0; const dispatched=[], tasks=new Map();
    const f=fixture({sleep:()=>new Promise(resolve=>{resume=resolve;})});f.activeJobs.add('first');
    Object.assign(f.store, {
        verifyCdkDetails:async()=>({type:'自助',plan_type:'plus'}),getRunningTaskByCdk:async cdk=>tasks.get(cdk)||null,
        getMaintenanceModeState:async()=>({}),getGptApiConfig:async()=>({enabled:true,api_key:'key',base_url:'https://orbitcard.test'}),
        assertPaymentAllowed:async()=>{},
        createOrbitcardTask:async({cdk})=>{created++;const task={jobKey:'waiting-'+cdk,orbitcardClientOrderNo:'fixed-'+cdk,orbitcardState:'preparing'};
            tasks.set(cdk,{job_key:task.jobKey,orbitcard_client_order_no:task.orbitcardClientOrderNo,status:'running',message:'排队等待'});return task;},
        settleOrbitcardTask:async()=>({applied:true})
    });
    const handler=require('../src/payments/activation-service')({store:f.store,ensureStoreReady:async()=>{},activeJobs:f.activeJobs,
        waitingQueue:f.queue,log(){},runWorker:async({task})=>{dispatched.push(task.jobKey);await f.queue.allocate({key:task.jobKey,session,cfg:task.apiConfig,allocate:async()=>42});}});
    async function request(cdk){const res={code:200,headers:{},set(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(data){this.data=data;return data;}};await handler({body:{cdk,session}},res);return res;}
    const second=await request('SECOND');assert.equal(second.code,200);assert.equal(second.data.queued,true);
    assert.equal(dispatched.length,0);assert.equal(f.queue.count,1);
    const duplicate=await request('SECOND');assert.equal(duplicate.data.jobKey,second.data.jobKey);assert.equal(duplicate.data.queued,true);
    const overflow=await request('THIRD');assert.equal(overflow.code,429);assert.equal(overflow.data.error_code,'PAYMENT_QUEUE_FULL');
    assert.equal(overflow.headers['Retry-After'],'600');assert.equal(created,1);
    f.activeJobs.delete('first');resume();await flush();await flush();
    assert.deepEqual(dispatched,[second.data.jobKey]);assert.equal(f.queue.isFull(),false);assert.equal(f.activeJobs.size,0);assert.equal(f.db.owners.size,0);
});
