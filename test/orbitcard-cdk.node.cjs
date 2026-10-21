'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Load with an injected HTTP transport: these tests require no packages, DB or real payments.
function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : id === './runtime-log' ? { push() {} } : realRequire(id), module, module.exports);
    return module.exports;
}

function modules() {
    const api = load('orbitcard-client.js', { axios: { request: async () => { throw new Error('Unexpected network request'); } } });
    const domain = load('orbitcard-cdk.js', { './orbitcard-client': api });
    const factory = load('orbitcard-cdk-store.js', { './orbitcard-cdk': domain });
    const worker = load('orbitcard-worker.js', { './orbitcard-client': api, './orbitcard-cdk': domain });
    const query = load('orbitcard-query.js', { './orbitcard-client': api, './orbitcard-cdk': domain });
    return { api, domain, factory, worker, query };
}

function database(factory) {
    const db = { cdk: { cdk_code: 'CDK-TEST', type: '自助', is_active: 1, used_at: null, plan_type: 'plus' }, tasks: [], failInsert: false };
    let tail = Promise.resolve();
    let sequence = 0;
    const connection = {};
    const store = factory({
        withTransaction(fn) {
            const operation = tail.then(async () => {
                const backup = structuredClone(db);
                try { return await fn(connection); } catch (error) { Object.assign(db, backup); throw error; }
            });
            tail = operation.catch(() => {});
            return operation;
        },
        async createTaskLog(input, options) {
            assert.equal(options.connection, connection);
            assert.equal(input.sessionPayload, undefined);
            if (db.failInsert) throw new Error('insert failed');
            const task = { id: ++sequence, job_key: `job-${sequence}`, cdk_code: input.cdkCode, status: input.status, progress: 3 };
            db.tasks.push(task);
            return { jobKey: task.job_key };
        },
        async runQuery(sql, args) {
            const q = sql.replace(/\s+/g, ' ');
            if (q.includes('FROM cdk_codes')) return [{ ...db.cdk }];
            if (q.includes("orbitcard_state IN")) return db.tasks.filter(t => ['prepared','submitting','pending','manual','success'].includes(t.orbitcard_state));
            if (q.includes('JOIN cdk_codes')) return db.tasks.length ? [{ ...db.tasks.at(-1) }] : [];
            if (q.includes('ORDER BY id DESC')) return db.tasks.length ? [{ ...db.tasks.at(-1) }] : [];
            if (q.includes('FROM task_logs WHERE job_key')) return db.tasks.filter(t => t.job_key === args[0]).map(t => ({ ...t }));
            throw new Error(`Unexpected query: ${q}`);
        },
        async runExecute(sql, args) {
            const q = sql.replace(/\s+/g, ' ');
            if (q.startsWith('UPDATE task_logs SET orbitcard_client_order_no')) {
                Object.assign(db.tasks.find(t => t.job_key === args[6]), { orbitcard_client_order_no: args[0], orbitcard_state: 'prepared', orbitcard_plan_type: args[1], orbitcard_email: args[2], orbitcard_base_url: args[3],
                    orbitcard_retry_root_job_key:args[4],orbitcard_retry_attempt_no:1,orbitcard_api_key_hash:args[5] });
            } else if (q.startsWith('UPDATE task_logs SET status')) {
                Object.assign(db.tasks.find(t => t.job_key === args[6]), { status: args[0], progress: args[1], message: args[2], orbitcard_state: args[3],
                    gpt_api_order_id: args[4], gpt_api_raw: args[5], session_payload: null });
            } else if (q.startsWith('UPDATE cdk_codes SET used_at = NULL')) db.cdk.used_at = null;
            else if (q.startsWith('UPDATE cdk_codes SET used_at')) db.cdk.used_at ||= 'locked';
            else throw new Error(`Unexpected execute: ${q}`);
            return { affectedRows: 1 };
        }
    });
    const claim = () => store.createOrbitcardTask({ cdk: 'CDK-TEST', planType: 'plus', email: 'target@example.test', baseUrl: 'https://orbitcard.test' });
    const settle = (task, state, extra = {}) => store.settleOrbitcardTask(task.jobKey, {
        status: state === 'success' ? 'success' : ['failed','rejected'].includes(state) ? 'failed' : 'manual',
        progress: 90, message: state, orbitcardState: state, ...extra
    });
    return { db, store, claim, settle };
}

test('an attempt has a stable identity; a fresh attempt has a distinct identity', () => {
    const { domain } = modules();
    assert.equal(domain.clientOrderNo('CDK', 'job1'), domain.clientOrderNo('CDK', 'job1'));
    assert.notEqual(domain.clientOrderNo('CDK', 'job1'), domain.clientOrderNo('CDK', 'job2'));
    assert.match(domain.clientOrderNo('CDK', 'job1'), /^cdk-[a-f0-9]{64}$/);
});

test('concurrent redemptions atomically create one task and reserve one CDK', async () => {
    const f = database(modules().factory);
    const results = await Promise.all([f.claim(), f.claim()]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.db.tasks.length, 1);
    assert.ok(f.db.cdk.used_at);
    assert.ok(f.db.tasks[0].orbitcard_client_order_no);
});

test('task insert failure rolls back CDK reservation', async () => {
    const f = database(modules().factory);
    f.db.failInsert = true;
    await assert.rejects(f.claim(), /insert failed/);
    assert.equal(f.db.cdk.used_at, null);
    assert.equal(f.db.tasks.length, 0);
});

test('confirmed failure releases CDK and a retry receives a new order identity', async () => {
    const f = database(modules().factory);
    const first = await f.claim();
    await f.settle(first, 'failed');
    assert.equal(f.db.cdk.used_at, null);
    const second = await f.claim();
    assert.ok(second);
    assert.notEqual(first.orbitcardClientOrderNo, second.orbitcardClientOrderNo);
    assert.ok(f.db.cdk.used_at);
});

test('pending/manual outcomes retain CDK and prevent a fresh redemption', async () => {
    const f = database(modules().factory);
    const task = await f.claim();
    await f.settle(task, 'manual');
    assert.ok(f.db.cdk.used_at);
    assert.equal(await f.claim(), null);
});

test('stale failure cannot release the CDK owned by a newer attempt', async () => {
    const f = database(modules().factory);
    const old = await f.claim();
    await f.settle(old, 'failed');
    const current = await f.claim();
    assert.equal((await f.settle(old, 'rejected')).applied, false);
    assert.ok(f.db.cdk.used_at);
    assert.equal(f.db.tasks.at(-1).job_key, current.jobKey);
});

test('success cannot be downgraded by stale pending/failed responses', async () => {
    const f = database(modules().factory);
    const task = await f.claim();
    await f.settle(task, 'success');
    assert.equal((await f.settle(task, 'failed')).applied, false);
    assert.equal((await f.settle(task, 'pending')).applied, false);
    assert.ok(f.db.cdk.used_at);
});

test('recovering a prepared task cannot release a task already submitted', async () => {
    const f = database(modules().factory);
    const task = await f.claim();
    await f.settle(task, 'submitting', { expectedState:'prepared', expectedClientOrderNo:task.orbitcardClientOrderNo });
    assert.equal((await f.settle(task, 'rejected', { expectedState: 'prepared' })).applied, false);
    assert.ok(f.db.cdk.used_at);
});

test('only one process can claim submission for the same durable order identity', async () => {
    const f=database(modules().factory),task=await f.claim();
    const claim=identity => f.store.settleOrbitcardTask(task.jobKey,{
        status:'running',progress:20,message:'submitting',orbitcardState:'submitting',
        expectedState:'prepared',expectedClientOrderNo:identity
    });
    assert.equal((await claim('another-order')).applied,false);
    const results=await Promise.all([claim(task.orbitcardClientOrderNo),claim(task.orbitcardClientOrderNo)]);
    assert.equal(results.filter(item=>item.applied).length,1);
    assert.equal(f.db.tasks[0].orbitcard_state,'submitting');
    assert.equal((await f.store.settleOrbitcardTask(task.jobKey,{status:'running',orbitcardState:'prepared',
        expectedState:'prepared',expectedClientOrderNo:task.orbitcardClientOrderNo})).applied,false);
});

test('three confirmed failed payments use three distinct cards and then lock the CDK', async () => {
    const f=require('./helpers/card-db.cjs')(),cards=f.store.cardMethods(f.base);
    await f.addCard(42);await f.addCard(43);await f.addCard(44);
    let task=await f.claim(),root=task.jobKey;
    const identities=[];
    for(let attempt=1;attempt<=3;attempt++) {
        const cardId=41+attempt;
        if(attempt>1) assert.equal(await f.store.claimOrbitcardRetryTask(task.jobKey,task.orbitcardClientOrderNo),true);
        assert.ok(await cards.reserveCard(cardId,task.jobKey,'plus'));
        const claimed=await f.store.settleOrbitcardTask(task.jobKey,{status:'running',orbitcardState:'submitting',
            expectedState:'prepared',expectedClientOrderNo:task.orbitcardClientOrderNo});
        assert.equal(claimed.applied,true);
        identities.push(task.orbitcardClientOrderNo);
        const result=await f.store.recordOrbitcardPaymentFailure(task.jobKey,{clientOrderNo:task.orbitcardClientOrderNo,
            cardId,orderId:`SUB-${attempt}`,raw:JSON.stringify({task_no:`SUB-${attempt}`,client_order_no:task.orbitcardClientOrderNo,
                card_id:cardId,status:'failed',subscription_succeeded:false})});
        assert.equal(result.applied,true);
        if(attempt<3) {
            assert.equal(result.exhausted,false);
            task=result.nextTask;
            assert.equal(task.orbitcardRetryAttemptNo,attempt+1);
            assert.equal(task.orbitcardRetryRootJobKey,root);
            assert.equal(f.db.cdks[0].used_at!==null,true);
        } else assert.equal(result.exhausted,true);
    }
    assert.equal(new Set(identities).size,3);
    assert.equal(f.db.tasks.at(-1).orbitcard_state,'support_locked');
    assert.match(f.db.tasks.at(-1).message,/人工售后/);
    assert.equal(f.db.uses.filter(use=>use.state==='released').length,3);
    assert.equal(f.db.cards[0].successful_plus,0);
    assert.equal(f.db.cards[1].successful_plus,0);
    assert.equal(f.db.cards[2].successful_plus,0);
    assert.ok(f.db.cdks[0].used_at);
});

test('a confirmed failure rotates the order once; unknown results never rotate it',async () => {
    const f=require('./helpers/card-db.cjs')(),task=await f.claim();await f.addCard(42);
    await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    await f.store.settleOrbitcardTask(task.jobKey,{status:'running',orbitcardState:'submitting',
        expectedState:'prepared',expectedClientOrderNo:task.orbitcardClientOrderNo});
    const base={clientOrderNo:task.orbitcardClientOrderNo,cardId:42,orderId:'SUB-1'};
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(task.jobKey,{...base,raw:JSON.stringify({task_no:'SUB-1',status:'pending'})}),/处理中/);
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(task.jobKey,{...base,raw:JSON.stringify({task_no:'SUB-1',status:'failed',query_source:'snapshot'})}),/上游结果/);
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(task.jobKey,{...base,raw:JSON.stringify({task_no:'SUB-1',status:'failed',upstream_status:'processing'})}),/不一致/);
    assert.equal(f.db.tasks.length,1);
    const failed={...base,raw:JSON.stringify({task_no:'SUB-1',status:'failed',subscription_succeeded:false})};
    const results=await Promise.all([f.store.recordOrbitcardPaymentFailure(task.jobKey,failed),f.store.recordOrbitcardPaymentFailure(task.jobKey,failed)]);
    assert.equal(results.filter(item=>item.applied).length,1);
    assert.equal(f.db.tasks.length,2);
    assert.equal(f.db.tasks[1].orbitcard_state,'retry_waiting');
    assert.equal((await f.store.claimOrbitcardRetryTask(f.db.tasks[1].job_key,f.db.tasks[1].orbitcard_client_order_no)),true);
    assert.equal((await f.store.claimOrbitcardRetryTask(f.db.tasks[1].job_key,f.db.tasks[1].orbitcard_client_order_no)),false);
});

test('a rejected second attempt keeps its CDK locked for human support',async () => {
    const f=require('./helpers/card-db.cjs')();await f.addCard(42);
    const first=await f.claim();await f.store.cardMethods(f.base).reserveCard(42,first.jobKey,'plus');
    await f.store.settleOrbitcardTask(first.jobKey,{status:'running',orbitcardState:'submitting',
        expectedState:'prepared',expectedClientOrderNo:first.orbitcardClientOrderNo});
    const rotated=await f.store.recordOrbitcardPaymentFailure(first.jobKey,{clientOrderNo:first.orbitcardClientOrderNo,
        cardId:42,orderId:'SUB-1',raw:JSON.stringify({task_no:'SUB-1',status:'failed',subscription_succeeded:false})});
    const second=rotated.nextTask;await f.store.claimOrbitcardRetryTask(second.jobKey,second.orbitcardClientOrderNo);
    await f.store.cardMethods(f.base).reserveCard(42,second.jobKey,'plus');
    await f.store.settleOrbitcardTask(second.jobKey,{status:'running',orbitcardState:'submitting',
        expectedState:'prepared',expectedClientOrderNo:second.orbitcardClientOrderNo});
    assert.equal((await f.store.lockOrbitcardSupport(second.jobKey,'submitting','请联系人工售后',
        {orderId:'REJECTED-2',raw:'{"status":"rejected"}'})).applied,true);
    assert.equal(f.db.tasks.at(-1).orbitcard_state,'support_locked');
    assert.equal(f.db.tasks.at(-1).gpt_api_order_id,'REJECTED-2');
    assert.equal(f.db.uses.at(-1).state,'released');
    assert.ok(f.db.cdks[0].used_at);
});

test('abnormal card exhaustion locks the CDK before the first subscription submission',async () => {
    const f=require('./helpers/card-db.cjs')(),task=await f.claim();
    assert.equal((await f.store.lockOrbitcardSupport(task.jobKey,'prepared','card unavailable')).applied,false);
    const locked=await f.store.lockOrbitcardSupport(task.jobKey,'prepared','请联系人工售后',{cardSelectionExhausted:true});
    assert.equal(locked.applied,true);
    assert.equal(f.db.tasks[0].orbitcard_state,'support_locked');
    assert.match(f.db.tasks[0].message,/人工售后/);
    assert.ok(f.db.cdks[0].used_at);
    assert.equal((await f.store.lockOrbitcardSupport(task.jobKey,'prepared','again',{cardSelectionExhausted:true})).applied,false);
});

test('only a consistent live upstream result settles or retries an order', () => {
    const {api,domain}=modules();
    const valid={orderId:'SUB-1',client_order_no:'ORDER-1',plan_type:'gpt-plus'};
    assert.equal(domain.validOrder(valid,{clientOrderNo:'ORDER-1',planType:'gpt-plus'}),true);
    assert.equal(domain.validOrder({...valid,client_order_no:undefined},{clientOrderNo:'ORDER-1',planType:'gpt-plus'}),false);
    assert.equal(domain.validOrder({...valid,plan_type:undefined},{clientOrderNo:'ORDER-1',planType:'gpt-plus'}),false);
    assert.equal(api.outcome({status:'failed',subscription_succeeded:true,query_source:'upstream'},true),'pending');
    assert.equal(api.outcome({status:'processing',subscription_succeeded:false,query_source:'upstream'},true),'pending');
    assert.equal(api.outcome({status:'failed',subscription_succeeded:false,query_source:'snapshot'},true),'pending');
    assert.equal(api.outcome({status:'succeeded',subscription_succeeded:true,query_source:'upstream'},true),'success');
    assert.equal(api.outcome({status:'failed',subscription_succeeded:false,query_source:'upstream'},true),'failed');
});

test('a mismatched create snapshot cannot redirect follow-up queries to another task',async () => {
    const {api,worker}=modules(),calls=[];
    api.fetchPlans=async()=>({success:true,plans:[{type:'gpt-plus'}]});
    api.request=async (_,operation,body)=>{
        calls.push({operation,body});
        if(operation==='createSubscription') return {success:true,data:{task_no:'WRONG',client_order_no:'OTHER',plan_type:'gpt-plus'}};
        return {success:false,status:404};
    };
    const previous=process.env.ORBITCARD_API_SECRET;process.env.ORBITCARD_API_SECRET='test-secret';
    try {
        await worker.run({cfg:{orbitcard_region_plus:'US'},planType:'plus',cdk:'CDK',clientOrderNo:'ORDER-1',
            session:{accessToken:'private',user:{email:'target@example.test'},account:{}},selectCard:async()=>42,
            setProgress:async()=>{},onSubmission:async()=>{},broadcast:()=>{},sleep:async()=>{},maxPolls:1});
        assert.deepEqual(calls.map(call=>call.operation),['createSubscription','getSubscription']);
        assert.equal(Object.hasOwn(calls[0].body,'payment_region'),false);
        assert.deepEqual(calls[1].body,{client_order_no:'ORDER-1'});
    } finally {if(previous===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=previous;}
});

test('a failed submission claim never calls createSubscription',async () => {
    const {worker,api}=modules(),operations=[];
    api.fetchPlans=async () => ({success:true,plans:[{type:'gpt-plus'}]});
    api.request=async (_,operation) => {operations.push(operation);return {success:true,data:{payment_regions:[{code:'US',default:true}]}};};
    const previous=process.env.ORBITCARD_API_SECRET;process.env.ORBITCARD_API_SECRET='test-secret';
    try {
        await assert.rejects(worker.run({cfg:{},planType:'plus',cdk:'CDK-TEST',clientOrderNo:'original-order',
            session:{accessToken:'private',user:{email:'target@example.test'},account:{}},selectCard:async()=>42,
            setProgress:async (_,__,___,extra)=>{if(extra.orbitcardState==='submitting') throw Error('claim denied');},
            onSubmission:()=>{throw Error('must not submit');}}),/claim denied/);
        assert.deepEqual(operations,[]);
    } finally {if(previous===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=previous;}
});

test('worker retries only after a verified terminal upstream failure',async () => {
    const {worker,api}=modules(),operations=[],confirmed=[];
    api.fetchPlans=async()=>({success:true,plans:[{type:'gpt-plus'}]});
    api.request=async (_,operation) => {
        operations.push(operation);
        if(operation==='createSubscription') return {success:true,data:{task_no:'SUB-1'}};
        return {success:true,data:{task_no:'SUB-1',client_order_no:'ORDER-1',plan_type:'gpt-plus',card_id:42,
            status:'failed',subscription_succeeded:false}};
    };
    const previous=process.env.ORBITCARD_API_SECRET;process.env.ORBITCARD_API_SECRET='test-secret';
    try {
        const result=await worker.run({cfg:{},planType:'plus',cdk:'CDK-TEST',clientOrderNo:'ORDER-1',
            session:{accessToken:'private',user:{email:'target@example.test'},account:{}},selectCard:async()=>42,
            setProgress:async()=>{},onSubmission:async()=>{},broadcast:()=>{},sleep:async()=>{},maxPolls:1,
            onConfirmedFailure:failure=>{confirmed.push(failure);return {exhausted:true};}});
        assert.deepEqual(result,{exhausted:true});
        assert.deepEqual(operations,['createSubscription','getSubscription']);
        assert.equal(confirmed.length,1);assert.equal(confirmed[0].clientOrderNo,'ORDER-1');
        assert.equal(confirmed[0].cardId,42);
    } finally {if(previous===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=previous;}
});

test('rejected submission during a retry locks support instead of releasing the CDK',async () => {
    const {worker,api}=modules(),states=[];
    api.fetchPlans=async()=>({success:true,plans:[{type:'gpt-plus'}]});
    api.request=async()=>({success:false,data:{task_no:'REJECTED-2'},requestError:{submission_outcome:'rejected'}});
    const previous=process.env.ORBITCARD_API_SECRET;process.env.ORBITCARD_API_SECRET='test-secret';
    try {
        const result=await worker.run({cfg:{},planType:'plus',cdk:'CDK-TEST',clientOrderNo:'ORDER-2',
            session:{accessToken:'private',user:{email:'target@example.test'},account:{}},selectCard:async()=>42,
            setProgress:async (_,__,___,extra)=>states.push(extra.orbitcardState),onSubmission:async()=>{},
            onRejectedSubmission:rejection=>({supportLocked:true,orderId:rejection.orderId})});
        assert.deepEqual(result,{supportLocked:true,orderId:undefined});
        assert.deepEqual(states,['submitting']);
    } finally {if(previous===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=previous;}
});

test('restart query records confirmed failure for retry but never resubmits an unknown order',async () => {
    const {query,api}=modules(),task={job_key:'restart-retry-1',orbitcard_client_order_no:'ORDER-1',
        orbitcard_base_url:'https://orbitcard.test',orbitcard_plan_type:'plus',orbitcard_email:'target@example.test',orbitcard_card_id:42};
    const calls=[];
    api.request=async (_,operation)=>{calls.push(operation);return {success:true,data:{task_no:'SUB-1',
        client_order_no:'ORDER-1',plan_type:'gpt-plus',card_id:42,targetEmail:'target@example.test',
        status:'failed',subscription_succeeded:false}};};
    const result=await query.refresh({cfg:{base_url:'https://orbitcard.test'},task,
        persist:async()=>{throw Error('must keep CDK locked')},
        onConfirmedFailure:async (_,failure)=>{assert.equal(failure.cardId,42);return {applied:true,exhausted:false};}});
    assert.equal(result.retrying,true);assert.deepEqual(calls,['getSubscription']);
});

async function runWorker(responses) {
    const { worker, api } = modules();
    api.fetchPlans = async () => ({ success: true, plans: [{ type: 'gpt-plus' }] });
    const calls = [], states = [];
    api.request = async (...args) => { calls.push(args); return responses.shift(); };
    const previous = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_SECRET = 'test-secret';
    try {
        const rollback = await worker.run({ cfg: { orbitcard_card_id: 42 }, planType: 'plus', cdk: 'CDK-TEST',
            selectCard: async () => 42,
            session: { accessToken: 'private-token', user: { email: 'target@example.test' }, account: {} },
            clientOrderNo: 'cdk-fixed-attempt', onSubmission: () => { assert.equal(states.at(-1)[3].orbitcardState, 'submitting'); },
            setProgress: async (...args) => states.push(args), broadcast: () => {}, sleep: async () => {}, maxPolls: 1 });
        return { rollback, calls, states };
    } finally {
        if (previous === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = previous;
    }
}
test('unknown creation queries its persisted identity, never creates a replacement', async () => {
    const out = await runWorker([{ success: false }, { success: false, status: 503 }]);
    assert.equal(out.rollback, false);
    assert.deepEqual(out.calls.map(c => c[1]), ['createSubscription','getSubscription']);
    assert.deepEqual(out.calls[1][2], { client_order_no: 'cdk-fixed-attempt' });
    assert.equal(out.states.at(-1)[3].orbitcardState, 'manual');
    assert.ok(!JSON.stringify(out.states).includes('private-token'));
});

test('explicit rejection releases CDK even when the platform allocated a task number', async () => {
    const out = await runWorker([{ success: false, data: { task_no: 'SUB-REJECTED' }, requestError: { submission_outcome: 'rejected' } }]);
    assert.equal(out.rollback, true);
    assert.equal(out.states.at(-1)[3].orbitcardState, 'rejected');
    assert.equal(out.calls.length, 1);
});

test('fee charge failure does not reverse subscription success', async () => {
    const out = await runWorker([{ success: true, data: { task_no: 'SUB1' } },
        { success: true, data: { orderId: 'SUB1', client_order_no: 'cdk-fixed-attempt', plan_type: 'gpt-plus', status: 'succeeded', fee_status: 'charge_failed', session: { accessToken: 'private-result' } } }]);
    assert.equal(out.rollback, false);
    assert.equal(out.states.at(-1)[3].orbitcardState, 'success');
    assert.ok(!JSON.stringify(out.states).includes('private-result'));
});

test('reconciliation after restart only queries the persisted order and coalesces concurrent queries', async () => {
    const { api, query } = modules();
    let finish;
    let count = 0;
    api.request = async (cfg, operation, body) => {
        count++;
        assert.equal(operation, 'getSubscription');
        assert.deepEqual(body, { client_order_no: 'cdk-fixed-attempt' });
        return new Promise(resolve => { finish = resolve; });
    };
    const saved = [];
    const input = { cfg: { base_url: 'https://orbitcard.test' }, task: { job_key: 'job1', orbitcard_base_url: 'https://orbitcard.test/',
        orbitcard_client_order_no: 'cdk-fixed-attempt', orbitcard_plan_type: 'plus', orbitcard_email: 'target@example.test' },
        persist: async (...args) => { saved.push(args); return { applied: true }; } };
    const first = query.refresh(input), second = query.refresh(input);
    finish({ success: true, data: { orderId: 'SUB1', status: 'succeeded', client_order_no: 'cdk-fixed-attempt', plan_type: 'gpt-plus', fee_status: 'charge_failed' } });
    await Promise.all([first, second]);
    assert.equal(count, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0][1].orbitcardState, 'success');
});

test('query ownership mismatch preserves the CDK and does not persist credentials', async () => {
    const { api, query } = modules();
    api.request = async () => ({ success: true, data: { orderId: 'WRONG', status: 'succeeded', session: { accessToken: 'secret' } } });
    let writes = 0;
    const result = await query.refresh({ cfg: { base_url: 'https://orbitcard.test' }, task: {
        job_key: 'job1', gpt_api_order_id: 'SUB1', orbitcard_client_order_no: 'cdk-fixed', orbitcard_base_url: 'https://orbitcard.test'
    }, persist: async () => { writes++; } });
    assert.equal(result.success, false);
    assert.equal(writes, 0);
    assert.ok(!JSON.stringify(result).includes('secret'));
});

test('activation errors before acquiring a CDK cannot roll back somebody else’s lock', async () => {
    let rollbacks = 0;
    const deps = { ensureStoreReady: async () => {}, activeJobs: new Set(),
        store: { getMaintenanceModeState: async () => ({}), getMaxConcurrentActivations: async () => 5,
            verifyCdkDetails: async () => { throw new Error('temporary database error'); }, settleOrbitcardTask: async () => { rollbacks++; } } };
    const handler = require('../activation-service')(deps);
    let status;
    const res = { status(n) { status = n; return this; }, json(data) { return data; } };
    await handler({ body: { cdk: 'CDK-TEST', session: JSON.stringify({ accessToken: 'token', user: { email: 'user@example.test' }, account: {} }) } }, res);
    assert.equal(status, 503);
    assert.equal(rollbacks, 0);
});
