'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createService = require('../orbitcard-manual-service');
const createStore = require('../orbitcard-manual-store');
const { cardScope } = require('../orbitcard-card-policy');

function fixture({ unknown = false, pendingAllocation = false, now = Date.now } = {}) {
    const orders = new Map(), calls = [], created = [], allocations = [], auditEntries = [], auditContexts = [];
    const cfg = { enabled: true, base_url: 'https://orbitcard.cc', api_key: 'key',
        orbitcard_plan_prices: { plus: '20.00', pro100: '100.00', pro200: '200.00', pro500: '500.00' } };
    const plans = [
        { type: 'gpt-go', name: 'Go' }, { type: 'gpt-plus', name: 'Plus' },
        { type: 'gpt-credits-250', name: '250 credits' }
    ];
    const store = { acquirePaymentLock: require('./helpers/payment-locks.cjs')().acquirePaymentLock,
        assertPaymentAllowed: async jobKey => {
            const order = [...orders.values()].find(item => item.client_order_no === jobKey);
            if (!order || !['preparing','prepared','submitting','pending'].includes(order.state)) {
                throw new (require('../payment-automation').PaymentStoppedError)('任务已转人工处理');
            }
        },
        assertFundingReconciliationAllowed: async jobKey => {
            const order = [...orders.values()].find(item => item.client_order_no === jobKey);
            if (!order || !['funding_waiting','funding_review','funding_pending'].includes(order.state)) {
                throw new (require('../payment-automation').PaymentStoppedError)('不能核对该任务');
            }
        },
        releaseManualFunding: async () => null,
        pauseManualPreparation: async (requestId, _key, message) => {
            const order = orders.get(requestId);
            if (order?.state === 'preparing') Object.assign(order, { state: pendingAllocation ? 'funding_pending' : 'support_locked', message });
        },
        getGptApiConfig: async () => cfg,
        getMaxConcurrentActivations: async () => 5,
        getManualOrder: async id => orders.get(id) || null,
        listManualOrders: async () => [...orders.values()],
        listRecoverableManualOrders: async () => [...orders.values()].filter(x => ['submitting','pending','manual'].includes(x.state)),
        noteManualQueryAttempt: async () => {},
        cardMethods: () => ({ listCards: async () => [{ card_id: 12, authorization_count: 0,
            active_job: null }] }),
        withCardAllocationLock: async (_url, action) => action({ syncCards: async () => {} }),
        prepareManualOrder: async input => {
            created.push(input);
            const row = { request_id: input.requestId, client_order_no: `manual-${input.requestId}`,
                scope: cardScope(input.baseUrl),
                api_key_hash: require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex'),
                plan_type: input.planType, plan_name: input.planName, target_email: input.targetEmail,
                card_id: 0, mode: input.mode, cdk_code: input.cdkCode, state: 'preparing' };
            orders.set(input.requestId, row); return row;
        },
        markManualPrepared: async (requestId, key, cardId) => {
            const row = orders.get(requestId);
            assert.equal(row.client_order_no, key);
            row.card_id = cardId; row.state = 'prepared';
            return row;
        },
        failManualPreparation: async (requestId, _key, message) => {
            const row = orders.get(requestId);
            if (pendingAllocation) throw new Error('原补款意图待确认');
            if (row?.state === 'preparing' && !row.card_id) { row.state = 'failed'; row.message = message; }
            return row;
        },
        claimManualSubmission: async id => {
            const row = orders.get(id);
            if (row.state !== 'prepared') return false;
            row.state = 'submitting'; return true;
        },
        settleManualOrder: async (id, change) => {
            const row = orders.get(id);
            if (change.expectedClientOrderNo && row.client_order_no !== change.expectedClientOrderNo) return row;
            if (!['success','failed','support_locked'].includes(row.state)) {
                const retry = change.state === 'failed' && change.retryAllowed && row.state !== 'manual'
                    && require('../payment-retry-policy').manualHistory(row).length < 2;
                Object.assign(row, change, { state: retry ? 'retry_waiting' : change.state === 'failed' ? 'support_locked' : change.state });
                if (change.snapshot) row.snapshot=JSON.stringify(change.snapshot);
            }
            return row;
        },
        startManualRetry: async (requestId, expected) => {
            const row=orders.get(requestId);
            if(row.state!=='retry_waiting' || row.client_order_no!==expected)return null;
            const history=require('../payment-retry-policy').manualHistory(row);
            if(history.length>=2)return null;
            history.push({client_order_no:row.client_order_no,task_no:row.task_no,card_id:row.card_id,snapshot:JSON.parse(row.snapshot)});
            Object.assign(row,{client_order_no:`manual-${requestId}-attempt-${history.length+1}`,retry_history:JSON.stringify(history),
                state:'preparing',card_id:0,task_no:null,snapshot:null});
            return row;
        },
    };
    const provider = {
        fetchPlans: async () => ({ success: true, plans }),
        summary: require('../orbitcard-client').summary,
        outcome: require('../orbitcard-client').outcome,
        captcha: () => null,
        request: async (_cfg, operation, body, key) => {
            auditContexts.push({operation,jobKey:_cfg.auditJobKey});
            calls.push({ operation, body, key });
            if (operation === 'getSubscriptionPaymentRegions') return { success: true,
                data: { plan_type: body.plan_type, payment_regions: [{ code: 'PH' }, { code: 'US' }] } };
            if (operation === 'createSubscription') {
                if (unknown) return { success: false, error: 'network timeout' };
                return { success: true, data: { task_no: 'task-1', client_order_no: key,
                    plan_type: body.plan_type, card_id: body.card_id } };
            }
            return { success: !unknown, data: unknown ? null : { task_no: 'task-1',
                client_order_no: body.client_order_no || calls.find(x => x.operation === 'createSubscription')?.key,
                plan_type: orders.values().next().value.plan_type, card_id: 12,
                upstream_status: 'succeeded', query_source: 'upstream' } };
        }
    };
    const cardService = { confirmFunding: async () => { throw new (require('../orbitcard-card-policy').FundingPendingError)('原补款仍待确认'); },
        allocate: async (_cfg, jobKey, planType, selection) => {
        auditContexts.push({operation:'allocate',jobKey:_cfg.auditJobKey});
        allocations.push({ jobKey, planType, selection });
        if (pendingAllocation && allocations.length === 1) {
            throw new (require('../orbitcard-card-policy').FundingPendingError)('原补款结果待确认');
        }
        return 12;
    } };
    const activeJobs = new Set();
    const service = createService({ store, activeJobs, audit: entry => auditEntries.push(entry), provider, cardService, now });
    return { service, calls, created, orders, allocations, cfg, store, provider, cardService, activeJobs, auditEntries, auditContexts };
}

async function until(check) {
    for (let i = 0; i < 25; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('background order did not reach expected state');
}

test('two admin service instances cannot prepare the same request or release it through recovery', async () => {
    process.env.ORBITCARD_API_KEY='key'; process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture(); let enter, release;
    const entered=new Promise(resolve=>{enter=resolve;}), gate=new Promise(resolve=>{release=resolve;});
    const allocate=f.cardService.allocate;
    f.cardService.allocate=async(...args)=>{enter();await gate;return allocate(...args);};
    const other=createService({store:f.store,activeJobs:new Set(),provider:f.provider,cardService:f.cardService,audit(){}});
    const input={requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true};
    const first=f.service.create(input);
    try {
        await entered;
        await assert.rejects(other.create(input),error=>error.status===409);
        assert.equal((await other.refresh(id)).state,'preparing');
        let abandoned=0;
        f.store.listRecoverableManualOrders=async()=>[{...f.orders.get(id),state:'prepared'}];
        f.store.abandonPreparedManualOrder=async()=>{abandoned++;throw new Error('must not release active order');};
        await other.recover(); assert.equal(abandoned,0); assert.equal(f.calls.length,0);
    } finally {release();}
    await first; await until(()=>f.orders.get(id).state==='success');
    assert.equal(f.allocations.length,1);assert.equal(f.calls.filter(x=>x.operation==='createSubscription').length,1);
});

test('admin execution ownership remains held after HTTP acceptance until background submission finishes', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture();let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;}), gate=new Promise(resolve=>{release=resolve;});
    const request=f.provider.request;
    f.provider.request=async(...args)=>{if(args[1]==='createSubscription'){enter();await gate;}return request(...args);};
    const input={requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true};
    const other=createService({store:f.store,activeJobs:new Set(),provider:f.provider,cardService:f.cardService,audit(){}});
    await f.service.create(input); await entered;
    try {
        await assert.rejects(other.create(input),error=>error.status===409);
        assert.equal((await other.refresh(id)).state,'submitting');
        assert.equal(f.calls.length,0,'must not query an order still in its original create request');
    } finally {release();}
    await until(()=>f.orders.get(id).state==='success');
    assert.equal(f.calls.filter(x=>x.operation==='createSubscription').length,1);
});

const session = JSON.stringify({ user: { email: 'buyer@example.com' }, account: {}, accessToken: 'secret-session' });
const id = '1b056caa-d7a6-4c39-9672-88e9cc5c6577';

test('administrator payments rotate through three existing cards and retain the two earlier failure records',async()=>{
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    let clock=Date.now();const f=fixture({now:()=>clock}),submitted=[];
    f.cardService.allocate=async(_cfg,_job,_plan,selection)=>{
        const card=12+submitted.length;
        assert.ok(!(selection.excludedCardIds||[]).includes(card));
        return card;
    };
    f.provider.request=async(_cfg,operation,body,key)=>{
        if(operation==='createSubscription') {
            const result={task_no:`SUB-${submitted.length+1}`,client_order_no:key,plan_type:body.plan_type,card_id:body.card_id,
                targetEmail:'buyer@example.com',status:'failed',subscription_succeeded:false,query_source:'upstream'};
            submitted.push(result);return {success:true,data:result};
        }
        assert.equal(operation,'getSubscription');
        return {success:true,data:submitted.find(row=>row.task_no===body.task_no||row.client_order_no===body.client_order_no)};
    };
    await f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true});
    await until(()=>submitted.length===2&&f.activeJobs.size===0);
    clock+=5000;await f.service.refresh(id);
    assert.equal(submitted.length,3);
    clock+=5000;await f.service.refresh(id);
    assert.equal(f.orders.get(id).state,'support_locked');assert.equal(submitted.length,3);
    assert.deepEqual(submitted.map(row=>row.card_id),[12,13,14]);
    assert.equal(new Set(submitted.map(row=>row.client_order_no)).size,3);
    assert.equal(JSON.parse(f.orders.get(id).retry_history).length,2);
    assert.ok(!JSON.stringify(f.orders.get(id)).includes('secret-session'));
});

test('expired administrator retry Session waits for fresh credentials and keeps the attempt identity on preparation resume',async()=>{
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    let clock=Date.now();const f=fixture({unknown:true,now:()=>clock});
    const input={requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true};
    await f.service.create(input);await until(()=>f.activeJobs.size===0);
    const order=f.orders.get(id);
    Object.assign(order,{state:'retry_waiting',snapshot:JSON.stringify(manualFailure(order))});
    const before=f.calls.length;
    clock+=16*60*1000;
    assert.equal((await f.service.refresh(id)).state,'retry_waiting');
    assert.equal(f.calls.length,before);
    assert.equal(require('../payment-retry-policy').manualHistory(order).length,0);
    // Model a restart after the next identity was persisted but before its card
    // was allocated. Resubmitting must use that identity for the payment guard.
    const next=await f.store.startManualRetry(id,order.client_order_no);
    f.cardService.allocate=async(cfg,key,_plan,selection)=>{
        assert.equal(key,next.client_order_no);
        assert.equal(cfg.auditJobKey,key);
        await cfg.paymentGuard.assertAllowed();
        assert.deepEqual(selection.excludedCardIds,[12]);
        return 13;
    };
    await f.service.create(input);await until(()=>f.activeJobs.size===0);
    assert.equal(order.state,'pending');
    assert.equal(order.client_order_no,`manual-${id}-attempt-2`);
    assert.equal(require('../payment-retry-policy').manualHistory(order).length,1);
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,2);
});

test('simultaneous administrator retries reserve capacity before awaiting durable attempt claims',async()=>{
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture({unknown:true}),second='36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
    for(const requestId of [id,second]) {
        await f.service.create({requestId,planType:'gpt-plus',mode:'test',session,authorized:true});
        await until(()=>f.activeJobs.size===0);
        const order=f.orders.get(requestId);
        Object.assign(order,{state:'retry_waiting',snapshot:JSON.stringify(manualFailure(order))});
    }
    let enter,release,claims=0;
    const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const start=f.store.startManualRetry;
    f.store.getMaxConcurrentActivations=async()=>1;
    f.store.startManualRetry=async(...args)=>{claims++;enter();await gate;return start(...args);};
    const first=f.service.refresh(id);
    try {
        await entered;
        assert.equal((await f.service.refresh(second)).state,'retry_waiting');
        assert.equal(claims,1);
    } finally {release();}
    await first;
    assert.equal(f.activeJobs.size,0);
    assert.equal(claims,1);
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,3);
});

test('manual payment stages and all upstream preparation calls share one durable trace without Session secrets', async()=>{
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture();f.cfg.orbitcard_payment_regions={plus:'PH'};
    await f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true});
    await until(()=>f.orders.get(id).state==='success');
    const jobKey=`manual-${id}`;
    assert.ok(f.auditContexts.every(entry=>entry.jobKey===jobKey));
    assert.ok(f.auditEntries.every(entry=>entry.jobKey===jobKey));
    for(const event of ['session_validated','payment_plan_selected','payment_region_selected','manual_card_ready','subscription_parameters_ready','subscription_submission_started','subscription_submission_returned','subscription_result_checked']) {
        assert.ok(f.auditEntries.some(entry=>entry.event===event),event);
    }
    assert.ok(!JSON.stringify(f.auditEntries).includes('secret-session'));
});

test('test mode uses only Plus and Pro plans and charges once without a CDK', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    const { service, calls, created, orders, allocations, cfg } = fixture();
    cfg.enabled = false; // Public new-order switch does not disable an authenticated administrator test.
    const catalog = await service.catalog();
    assert.deepEqual(catalog.plans.map(x => x.type), ['gpt-plus']);
    await assert.rejects(service.create({ requestId: id, planType: 'gpt-credits-250', cardId: 12,
        mode: 'test', cdkCode: '', session, authorized: true, adminEmail: 'admin@example.com' }), /未对该 API Key 开放/);
    await service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'test', cdkCode: '', session, authorized: true, adminEmail: 'admin@example.com' });
    await until(() => orders.get(id).state === 'success');
    assert.equal(created[0].cdkCode, null);
    assert.deepEqual(allocations, [{jobKey:`manual-${id}`,planType:'gpt-plus',selection:{manualRequestId:id}}]);
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 1);
    assert.equal(calls[0].key, `manual-${id}`);
    assert.equal(calls[0].body.session_json.user.email, 'buyer@example.com');
    assert.equal(JSON.stringify(orders.get(id)).includes('secret-session'), false);
    await service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'test', cdkCode: '', session, authorized: true, adminEmail: 'admin@example.com' });
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 1);
});

test('fulfillment requires matching CDK and persists its association', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    const { service, created, orders } = fixture();
    await assert.rejects(service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'fulfillment', session, authorized: true }), /CDK/);
    await service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'fulfillment', cdkCode: 'KC-TEST123', session, authorized: true });
    await until(() => orders.get(id).state === 'success');
    assert.deepEqual(created[0].acceptedCdkPlans, ['gpt-plus', 'plus']);
    assert.equal((await service.get(id)).cdk_code, 'KC-TEST123');
    await assert.rejects(service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'test', session, authorized: true }), /请求编号/);
});

test('unknown submission queries the original order and never submits again', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    const { service, calls, orders } = fixture({ unknown: true });
    await service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'test', session, authorized: true });
    await until(() => orders.get(id).state === 'pending');
    await service.refresh(id);
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 1);
    assert(calls.filter(x => x.operation === 'getSubscription').every(x => x.body.client_order_no === `manual-${id}`));
    assert.equal(orders.get(id).state,'pending');
});

test('a thrown subscription submission stays pending and recovery queries the original identity only',async()=>{
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture(),request=f.provider.request;
    f.provider.request=async(...args)=>{
        if(args[1]==='createSubscription') { f.calls.push({operation:args[1],body:args[2],key:args[3]});throw Error('connection lost'); }
        return request(...args);
    };
    const input={requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true};
    await f.service.create(input);await until(()=>f.orders.get(id).state==='pending'&&f.activeJobs.size===0);
    await f.service.create(input);await f.service.recover();
    assert.equal(f.orders.get(id).state,'success');
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,1);
    assert.equal(f.calls.find(call=>call.operation==='getSubscription').body.client_order_no,`manual-${id}`);
});

test('an explicit non-acceptance is settled as rejected without querying or resubmitting',async()=>{
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture();
    f.provider.request=async(_cfg,operation)=>{
        f.calls.push({operation});
        assert.equal(operation,'createSubscription');
        return {success:false,requestError:{submission_outcome:'rejected'}};
    };
    const input={requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true};
    await f.service.create(input);await until(()=>f.orders.get(id).state==='rejected'&&f.activeJobs.size===0);
    await f.service.create(input);await f.service.recover();
    assert.deepEqual(f.calls,[{operation:'createSubscription'}]);
});

test('administrator test and fulfillment use configured regions, and changing defaults never resubmits an unknown order', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    for (const mode of ['test', 'fulfillment']) {
        const f = fixture({ unknown: true }); f.cfg.orbitcard_payment_regions = { plus: 'PH' };
        const input = { requestId: id, planType: 'gpt-plus', mode, session, authorized: true,
            ...(mode === 'fulfillment' ? { cdkCode: 'KC-TEST123' } : {}) };
        await f.service.create(input);
        await until(() => f.orders.get(id).state === 'pending');
        assert.equal(f.calls[0].operation, 'getSubscriptionPaymentRegions');
        assert.equal(f.calls.find(row => row.operation === 'createSubscription').body.payment_region, 'PH');
        f.cfg.orbitcard_payment_regions.plus = 'US';
        await f.service.create(input); await f.service.refresh(id);
        assert.equal(f.calls.filter(row => row.operation === 'createSubscription').length, 1);
    }
});

test('administrator region validation precedes order creation, CDK reservation and card preparation', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    const f = fixture(); f.cfg.orbitcard_payment_regions = { plus: 'JP' };
    await assert.rejects(f.service.create({ requestId: id, planType: 'gpt-plus', mode: 'fulfillment',
        cdkCode: 'KC-TEST123', session, authorized: true }), /地区 JP 当前不可用/);
    assert.equal(f.created.length, 0); assert.equal(f.allocations.length, 0);
    assert.deepEqual(f.calls.map(row => row.operation), ['getSubscriptionPaymentRegions']);
});

test('manual preparation is never queried as a submitted subscription', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture({pendingAllocation:true});
    await assert.rejects(f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true}),/原补款/);
    assert.equal((await f.service.refresh(id)).state,'funding_pending');
    assert.equal(f.calls.length,0);
});

test('manual query checks original platform before making another request', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture({unknown:true});
    await f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true});
    await until(()=>f.orders.get(id).state==='pending');
    const previous=f.calls.length;f.cfg.base_url='https://different.example';
    await assert.rejects(f.service.refresh(id),/平台地址与原订单不一致/);
    assert.equal(f.calls.length,previous);
});

test('manual admission reserves capacity after the awaited limit without oversubscription', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture(), releases=[];
    f.store.getMaxConcurrentActivations=()=>new Promise(resolve=>releases.push(resolve));
    const first=f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true});
    const second=f.service.create({requestId:'2b056caa-d7a6-4c39-9672-88e9cc5c6577',planType:'gpt-plus',mode:'test',session,authorized:true});
    const results=Promise.allSettled([first,second]);
    await until(()=>releases.length===2);releases.forEach(resolve=>resolve(1));
    const settled=await results;
    assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(settled.find(r=>r.status==='rejected').reason.status,429);
    await until(()=>f.orders.get(id)?.state==='success');
    assert.equal(f.created.length,1);assert.equal(f.allocations.length,1);
});

test('manual query respects server Retry-After without creating another order', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    let clock=100000;const f=fixture({unknown:true,now:()=>clock});
    const original=f.provider.request;
    f.provider.request=async(...args)=>({...await original(...args),retryAfterMs:20000});
    await f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true});
    await until(()=>f.orders.get(id)?.state==='pending');
    await f.service.refresh(id);assert.equal(f.calls.length,1);
    clock+=20001;await f.service.refresh(id);assert.equal(f.calls.length,2);
    await f.service.refresh(id);assert.equal(f.calls.length,2);
});

test('pending funding hands the administrator order to reconciliation and repeated submission cannot resume payment', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    const { service, allocations, calls, orders } = fixture({ pendingAllocation: true });
    const input = { requestId: id, planType: 'gpt-plus', mode: 'test', session, authorized: true };
    await assert.rejects(service.create(input), /原补款结果待确认/);
    assert.equal(orders.get(id).state, 'funding_pending');
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 0);
    await service.create(input);
    assert.equal(orders.get(id).state, 'funding_pending');
    assert.equal(allocations.length, 1);
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 0);
});

function storeFixture({ enqueueRedemption } = {}) {
    let clock = Date.parse('2026-11-10T08:00:00Z');
    const scope = cardScope('https://orbitcard.cc');
    const db = { orders: [], fundings: [], issues: [], cdks: [{ cdk_code: 'KC-READY', is_active: 1, type: '自助',
        plan_type: 'plus', used_at: null }], card: { scope, card_id: 12, authorization_count: 0,
        active_job: null, provider_status: 'ACTIVE', currency: 'USD', reuse_after_ms: 0 } };
    const clean = sql => sql.replace(/\s+/g, ' ').trim();
    let inTransaction = false;
    const runQuery = async (sql, p = [], options) => {
        if (inTransaction) assert.equal(options?.connection?.transaction, true, 'transactional reads must retain their connection');
        const q = clean(sql);
        if (q.startsWith('SELECT * FROM orbitcard_admin_orders WHERE request_id')) return db.orders.filter(o => o.request_id === p[0]
            && (!q.includes("state = 'prepared'") || o.state === 'prepared')).map(o => structuredClone(o));
        if (q.startsWith('SELECT request_id FROM orbitcard_admin_orders WHERE scope')) return db.orders.filter(o => o.scope === p[0]
            && o.target_email === p[1] && o.plan_type === p[2] && ['preparing','prepared','funding_waiting','funding_review','funding_pending','card_pending','submitting','pending','manual','retry_waiting'].includes(o.state)).map(o => structuredClone(o));
        if (q.startsWith('SELECT request_id FROM orbitcard_admin_orders WHERE cdk_code')) return db.orders.filter(o => o.cdk_code === p[0] && o.state === 'success').map(o => structuredClone(o));
        if (q.startsWith('SELECT * FROM cdk_codes') || q.startsWith('SELECT cdk_code FROM cdk_codes')) return db.cdks.filter(c => c.cdk_code === p[0]).map(o => structuredClone(o));
        if (q.startsWith('SELECT job_key FROM task_logs')) return [];
        if (q.startsWith('SELECT funding_key FROM orbitcard_card_fundings')) return [];
        if (q.startsWith('SELECT * FROM orbitcard_card_fundings')) return db.fundings.filter(f=>f.job_key===p[0]).map(f=>structuredClone(f));
        if (q.startsWith('SELECT * FROM orbitcard_card_issues')) {
            assert.ok(q.endsWith('FOR UPDATE'));
            return db.issues.filter(issue => q.includes('WHERE job_key = ? OR issue_key = ?')
                ? issue.job_key === p[0] || issue.issue_key === p[1] : issue.issue_key === p[0]).map(issue => structuredClone(issue));
        }
        if (q.startsWith('SELECT * FROM orbitcard_managed_cards')) return db.card.scope === p[0] && db.card.card_id === p[1] ? [structuredClone(db.card)] : [];
        throw new Error(`Unexpected query ${q}`);
    };
    const runExecute = async (sql, p = []) => {
        const q = clean(sql);
        if (q.startsWith('INSERT INTO orbitcard_admin_orders') && q.includes("0,?,'preparing'")) db.orders.push({
            request_id: p[0], client_order_no: p[1], scope: p[2], api_key_hash: p[3],
            mode: p[4], cdk_code: p[5], plan_type: p[6], plan_name: p[7],
            target_email: p[8], card_id: 0, admin_email: p[9], state: 'preparing',
            task_no: null, snapshot: null, message: p[10], issue_key: null
        });
        else if (q.startsWith('UPDATE orbitcard_admin_orders SET client_order_no = ?')) {
            Object.assign(db.orders.find(o=>o.request_id===p[3]),{client_order_no:p[0],retry_history:p[1],state:'preparing',
                card_id:0,authorization_baseline:null,issue_key:null,task_no:null,snapshot:null,message:p[2]});
        }
        else if (q.startsWith('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP')) db.cdks.find(c => c.cdk_code === p[0]).used_at = 'reserved';
        else if (q.startsWith('UPDATE cdk_codes SET used_at = NULL')) {
            const code = db.cdks.find(c => c.cdk_code === p[0]);
            if (!q.includes('manual_redeemed_at IS NULL') || !code.manual_redeemed_at) code.used_at = null;
        }
        else if (q.startsWith('UPDATE orbitcard_admin_orders SET card_id = ?')) {
            const row = db.orders.find(o => o.request_id === p[3]); row.card_id = p[0]; row.authorization_baseline = p[1]; row.message = p[2];
        } else if (q.startsWith('UPDATE orbitcard_admin_orders SET issue_key = ?')) {
            const row = db.orders.find(o => o.request_id === p[2]); row.issue_key = p[0]; row.message = p[1];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'prepared'")) {
            const row = db.orders.find(o => o.request_id === p[1]);
            if(!row || !['preparing','funding_waiting'].includes(row.state) || row.client_order_no!==p[2] || row.card_id!==p[3])return {affectedRows:0};
            row.state = 'prepared'; row.message = p[0];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'funding_waiting'")) {
            const row = db.orders.find(o=>o.request_id===p[1]);row.state='funding_waiting';row.message=p[0];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'funding_review'")) {
            const row = db.orders.find(o=>o.request_id===p[1]);row.state='funding_review';row.message=p[0];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'support_locked'")) {
            const row = db.orders.find(o=>o.request_id===p[1]);if(['preparing','funding_waiting','funding_review'].includes(row.state)){row.state='support_locked';row.message=p[0];}
        }
        else if (q.startsWith('UPDATE orbitcard_managed_cards SET authorization_pending_count=')) {
            if (db.card.scope !== p[1] || db.card.card_id !== p[2]) return { affectedRows: 0 };
            db.card.authorization_pending_count = Math.max(db.card.authorization_pending_count || 0, p[0]);
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET reuse_after_ms=')) {
            if (db.card.scope !== p[1] || db.card.card_id !== p[2] || db.failCooldown) return { affectedRows: 0 };
            db.card.reuse_after_ms = Math.max(db.card.reuse_after_ms || 0, p[0]);
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job = ?')) {
            db.card.active_job = p[0];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'submitting'")) {
            const row = db.orders.find(o => o.request_id === p[0]);
            if (row.state !== 'prepared') return { affectedRows: 0 };
            row.state = 'submitting';
        } else if (q.startsWith('UPDATE orbitcard_admin_orders SET state = ?, message = ?')) {
            const row = db.orders.find(o => o.request_id === p[2]);
            Object.assign(row, { state:p[0], message:p[1] });
        } else if (q.startsWith('UPDATE orbitcard_admin_orders SET state = ?')) {
            const row = db.orders.find(o => o.request_id === p[4]);
            Object.assign(row, { state: p[0], task_no: row.task_no || p[1], snapshot: p[2], message: p[3] });
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job = NULL')) {
            if (db.failRelease) throw new Error('injected card release failure');
            db.card.active_job = null;
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'failed'")) {
            const row = db.orders.find(o => o.request_id === (p.length > 1 ? p[1] : p[0]));
            row.state = 'failed'; row.message = p.length > 1 ? p[0] : 'abandoned';
        } else if (q.startsWith('INSERT INTO cdk_codes')) {
            db.cdks.push({ cdk_code: p[0], is_active: 1, type: '手动', plan_type: p[1], used_at: null });
        } else throw new Error(`Unexpected execute ${q}`);
        return { affectedRows: 1 };
    };
    let transactionTail = Promise.resolve();
    const withTransaction = action => {
        const result = transactionTail.then(async () => {
            const backup = structuredClone(db);
            inTransaction = true;
            try { return await action({ transaction: true }); }
            catch (error) { Object.assign(db, backup); throw error; }
            finally { inTransaction = false; }
        });
        transactionTail = result.catch(() => {});
        return result;
    };
    return { db, advance: ms => { clock += ms; }, now: () => clock,
        store: createStore({ runQuery, runExecute, withTransaction, enqueueRedemption, now: () => clock }) };
}

async function prepareOrder(store, input) {
    const order = await store.prepareManualOrder(input);
    const card = await store.reserveManualCard(input.requestId, input.cardId, order.client_order_no, input.planType);
    assert.ok(card, 'test order must reserve an eligible card');
    return store.markManualPrepared(input.requestId, order.client_order_no, input.cardId);
}

test('waiting administrator funding releases CDK and card only after confirmed final funding including handoffs',async()=>{
    for(const state of ['pending','ready','failed']) {
        const {db,store}=storeFixture();const input=manualInput(id);
        const order=await store.prepareManualOrder(input);
        await store.reserveManualCard(id,12,order.client_order_no,input.planType);
        db.fundings.push({job_key:order.client_order_no,scope:order.scope,card_id:12,plan_type:'plus',
            credential_hash:order.api_key_hash,order_no:'FUND-1',state});
        await store.waitManualFunding(id,order.client_order_no,'waiting');
        assert.equal(db.orders[0].state,'funding_waiting');
        assert.ok(db.cdks[0].used_at);assert.equal(db.card.active_job,order.client_order_no);
        const result=await store.releaseManualFunding(id,order.client_order_no,'use fresh Session');
        if(state==='pending') {
            assert.equal(result,null);assert.ok(db.cdks[0].used_at);assert.equal(db.card.active_job,order.client_order_no);
            await store.pauseManualPreparation(id,order.client_order_no,'support');
            assert.equal(db.orders[0].state,'funding_pending');
            assert.equal(await store.claimManualSubmission(id),false);
            assert.equal(await store.releaseManualFunding(id,order.client_order_no,'release'),null);
            db.fundings[0].state='ready';
            assert.equal((await store.releaseManualFunding(id,order.client_order_no,'release')).state,'failed');
            assert.equal(db.card.active_job,null);assert.equal(db.cdks[0].used_at,null);
        } else {
            assert.equal(result.state,'failed');assert.equal(db.cdks[0].used_at,null);assert.equal(db.card.active_job,null);
            assert.equal(db.card.reuse_after_ms,0,'no subscription was submitted');
        }
    }
});

test('waiting administrator funding blocks a second order and resumes preparation with the original card',async()=>{
    const {db,store}=storeFixture();const input=manualInput(id,{mode:'test',cdkCode:null});
    const order=await store.prepareManualOrder(input);await store.reserveManualCard(id,12,order.client_order_no,input.planType);
    db.fundings.push({job_key:order.client_order_no,scope:order.scope,card_id:12,plan_type:'plus',
        credential_hash:order.api_key_hash,order_no:'FUND-1',state:'pending'});
    await store.waitManualFunding(id,order.client_order_no,'waiting');
    await assert.rejects(store.prepareManualOrder(manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0',{mode:'test',cdkCode:null})),/待确认/);
    db.fundings[0].state='ready';await store.markManualPrepared(id,order.client_order_no,12);
    assert.equal(await store.claimManualSubmission(id),true);assert.equal(await store.claimManualSubmission(id),false);
});

test('funding review blocks submission and new orders, and releases only confirmed original funding',async()=>{
    for(const state of ['pending','ready','failed']) {
        const {db,store}=storeFixture();const input=manualInput(id);
        const order=await store.prepareManualOrder(input);await store.reserveManualCard(id,12,order.client_order_no,input.planType);
        db.fundings.push({job_key:order.client_order_no,scope:order.scope,card_id:12,plan_type:'plus',
            credential_hash:order.api_key_hash,order_no:'FUND-1',state});
        await store.waitManualFunding(id,order.client_order_no,'waiting');
        await store.reviewManualFunding(id,order.client_order_no,'timeout review');
        assert.equal(db.orders[0].state,'funding_review');
        await assert.rejects(store.markManualPrepared(id,order.client_order_no,12),/准备状态不一致/);
        await assert.rejects(store.waitManualFunding(id,order.client_order_no,'resume'),/不能继续等待/);
        assert.equal(await store.claimManualSubmission(id),false);
        await assert.rejects(store.prepareManualOrder(manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0')),/待确认/);
        const result=await store.releaseManualFunding(id,order.client_order_no,'review complete');
        assert.equal(db.card.active_job,state==='pending'?order.client_order_no:null);
        assert.equal(db.cdks[0].used_at,state==='pending'?'reserved':null);
        assert.equal(result?.state,state==='pending'?undefined:'failed');
        assert.equal(db.card.reuse_after_ms,0);
    }
});

test('explicit support handoff and mismatched original funding cannot be reclassified as funding review',async()=>{
    for(const support of [true,false]) {
        const {db,store}=storeFixture();const input=manualInput(id);
        const order=await store.prepareManualOrder(input);await store.reserveManualCard(id,12,order.client_order_no,input.planType);
        db.fundings.push({job_key:order.client_order_no,scope:order.scope,card_id:12,plan_type:'plus',
            credential_hash:order.api_key_hash,order_no:'FUND-1',state:'pending'});
        await store.waitManualFunding(id,order.client_order_no,'waiting');
        if(support)db.orders[0].state='support_locked';
        else db.fundings[0].credential_hash='another-key';
        await assert.rejects(store.reviewManualFunding(id,order.client_order_no,'review'));
        assert.equal(db.orders[0].state,support?'support_locked':'funding_waiting');
        assert.equal(db.card.active_job,order.client_order_no);assert.equal(db.cdks[0].used_at,'reserved');
    }
});

test('funding reconciliation releases a card after manual CDK redemption without undoing redemption',async()=>{
    for(const state of ['funding_review','funding_pending'])for(const outcome of ['ready','failed']) {
        const {db,store}=storeFixture(), input=manualInput(id);
        const order=await store.prepareManualOrder(input);
        await store.reserveManualCard(id,12,order.client_order_no,input.planType);
        db.fundings.push({job_key:order.client_order_no,scope:order.scope,card_id:12,plan_type:'plus',
            credential_hash:order.api_key_hash,order_no:'FUND-1',state:outcome});
        db.orders[0].state=state;
        db.cdks[0].manual_redeemed_at='2026-11-13';
        assert.equal((await store.releaseManualFunding(id,order.client_order_no,'reconciled')).state,'failed');
        assert.equal(db.card.active_job,null);assert.equal(db.card.reuse_after_ms,0);
        assert.equal(db.cdks[0].manual_redeemed_at,'2026-11-13');assert.equal(db.cdks[0].used_at,'reserved');
        assert.equal(await store.claimManualSubmission(id),false);
    }
});

test('funding incident cannot release mismatched, incomplete or unresolved preparations',async()=>{
    for(const scenario of ['unknown','scope','card','credential','plan','issue','missing-issue','duplicate-funding','owner','release-failure']) {
        const {db,store}=storeFixture(), input=manualInput(id);
        const order=await store.prepareManualOrder(input);
        await store.reserveManualCard(id,12,order.client_order_no,input.planType);
        db.orders[0].state='funding_pending';
        const funding={job_key:order.client_order_no,scope:order.scope,card_id:12,plan_type:'plus',
            credential_hash:order.api_key_hash,order_no:'FUND-1',state:'ready'};
        db.fundings.push(funding);
        if(scenario==='unknown')funding.state='unknown';
        if(scenario==='scope')funding.scope='other-platform';
        if(scenario==='card')funding.card_id=99;
        if(scenario==='credential')funding.credential_hash='other-key';
        if(scenario==='plan')funding.plan_type='pro100';
        if(scenario==='issue')db.issues.push({...funding,issue_key:'unlinked-issue',state:'pending'});
        if(scenario==='missing-issue')db.orders[0].issue_key='missing-issue';
        if(scenario==='duplicate-funding')db.fundings.push({...funding,order_no:'FUND-2'});
        if(scenario==='owner')db.card.active_job='other-job';
        if(scenario==='release-failure')db.failRelease=true;
        const before=structuredClone(db);
        if(['owner','release-failure'].includes(scenario)) await assert.rejects(store.releaseManualFunding(id,order.client_order_no,'release'));
        else assert.equal(await store.releaseManualFunding(id,order.client_order_no,'release'),null,scenario);
        assert.deepEqual(db,before,scenario);
    }
});

test('card preparation handoff releases only final original issuance and never resumes subscription',async()=>{
    for(const outcome of ['pending','ready','failed']) {
        const {db,store}=storeFixture();const order=await store.prepareManualOrder(manualInput(id));
        await store.attachManualIssue(id,order.client_order_no,'issue-original');
        db.issues.push({issue_key:'issue-original',scope:order.scope,job_key:order.client_order_no,
            credential_hash:order.api_key_hash,plan_type:'plus',card_id:outcome==='ready'?12:null,state:outcome});
        await store.pauseManualPreparation(id,order.client_order_no,'await original issue');
        assert.equal(db.orders[0].state,'card_pending');
        assert.equal(await store.claimManualSubmission(id),false);
        await assert.rejects(store.prepareManualOrder(manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0')),/待确认/);
        if(outcome==='pending') {
            await assert.rejects(store.failManualPreparation(id,order.client_order_no,'release'),/不能自动释放/);
            assert.equal(db.orders[0].state,'card_pending');assert.equal(db.cdks[0].used_at,'reserved');
        } else {
            assert.equal((await store.failManualPreparation(id,order.client_order_no,'release')).state,'failed');
            assert.equal(db.cdks[0].used_at,null);
        }
    }
});

function manualInput(requestId, overrides = {}) {
    return { requestId, planType: 'gpt-plus', planName: 'Plus', targetEmail: 'buyer@example.com',
        cardId: 12, baseUrl: 'https://orbitcard.cc', apiKeyHash: 'a'.repeat(64),
        adminEmail: 'admin@example.com', mode: 'fulfillment', cdkCode: 'KC-READY',
        acceptedCdkPlans: ['gpt-plus','plus'], ...overrides };
}

function manualFailure(order, overrides = {}) {
    return { task_no: `SUB-${order.card_id}`, client_order_no: order.client_order_no,
        card_id: order.card_id, plan_type: order.plan_type, targetEmail: order.target_email,
        status: 'failed', subscription_succeeded: false, query_source: 'upstream', ...overrides };
}

test('durable administrator retry keeps exactly three different cards and rejects duplicate claims and stale results', async () => {
    const { db, store, now } = storeFixture(), input = manualInput(id);
    const credentials = { email: input.targetEmail, baseUrl: input.baseUrl, apiKeyHash: input.apiKeyHash };
    await prepareOrder(store, input);
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
        assert.equal(await store.claimManualSubmission(id), true);
        const current = await store.getManualOrder(id), snapshot = manualFailure(current);
        attempts.push({ identity: current.client_order_no, cardId: current.card_id, snapshot });
        const settled = await store.settleManualOrder(id, { state: 'failed', taskNo: snapshot.task_no,
            snapshot, retryAllowed: true, expectedClientOrderNo: current.client_order_no });
        assert.equal(settled.state, attempt < 3 ? 'retry_waiting' : 'support_locked');
        assert.equal(db.card.active_job, null);
        assert.equal(db.card.reuse_after_ms, now() + 300000);
        assert.equal(db.cdks[0].used_at, 'reserved');
        if (attempt === 3) {
            assert.equal(await store.startManualRetry(id, current.client_order_no, credentials), null);
            break;
        }
        await assert.rejects(store.prepareManualOrder(manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0')), /待确认管理员订单/);
        const claims = await Promise.all(Array.from({ length: 8 }, () => store.startManualRetry(id, current.client_order_no, credentials)));
        const next = claims.filter(Boolean);
        assert.equal(next.length, 1);
        assert.equal(JSON.parse(next[0].retry_history).length, attempt);
        for (const prior of attempts) assert.equal(await store.reserveManualCard(id, prior.cardId, next[0].client_order_no, input.planType), null);
        Object.assign(db.card, { card_id: 12 + attempt, reuse_after_ms: 0, authorization_pending_count: 0 });
        assert.ok(await store.reserveManualCard(id, db.card.card_id, next[0].client_order_no, input.planType));
        await store.markManualPrepared(id, next[0].client_order_no, db.card.card_id);
        await store.settleManualOrder(id, { state: 'success', taskNo: snapshot.task_no, snapshot,
            expectedClientOrderNo: current.client_order_no });
        assert.equal(db.orders[0].state, 'prepared', 'late result from a previous attempt cannot settle its replacement');
        assert.equal(db.card.active_job, next[0].client_order_no);
    }
    assert.equal(new Set(attempts.map(attempt => attempt.identity)).size, 3);
    const history = JSON.parse(db.orders[0].retry_history);
    assert.deepEqual(history.map(attempt => attempt.card_id), [12, 13]);
    assert.deepEqual(history.map(attempt => attempt.snapshot), attempts.slice(0, 2).map(attempt => attempt.snapshot));
    assert.deepEqual(JSON.parse(db.orders[0].snapshot), attempts[2].snapshot);
    assert.ok(!JSON.stringify(db).includes('accessToken'));
});

test('administrator retries require original account credentials, confirmed failure and resolved funding', async () => {
    const { db, store } = storeFixture(), input = manualInput(id);
    const credentials = { email: input.targetEmail, baseUrl: input.baseUrl, apiKeyHash: input.apiKeyHash };
    const prepared = await prepareOrder(store, input);
    await store.claimManualSubmission(id);
    await store.settleManualOrder(id, { state: 'pending', message: 'network timeout', expectedClientOrderNo: prepared.client_order_no });
    assert.equal(await store.startManualRetry(id, prepared.client_order_no, credentials), null);
    assert.equal(db.card.active_job, prepared.client_order_no);
    const snapshot = manualFailure(prepared);
    await store.settleManualOrder(id, { state: 'failed', taskNo: snapshot.task_no,
        snapshot, retryAllowed: true, expectedClientOrderNo: prepared.client_order_no });
    const waiting = structuredClone(db.orders[0]);
    for (const changed of [{ email: 'other@example.com' }, { baseUrl: 'https://other.example.com' }, { apiKeyHash: 'b'.repeat(64) }]) {
        await assert.rejects(store.startManualRetry(id, prepared.client_order_no, { ...credentials, ...changed }), /不一致/);
        assert.deepEqual(db.orders[0], waiting);
    }
    for (const changed of [{ task_no: 'FOREIGN' }, { client_order_no: 'foreign' }, { card_id: 999 },
        { plan_type: 'gpt-go' }, { targetEmail: 'other@example.com' }, { request_error: true },
        { status: 'pending', subscription_succeeded: undefined }]) {
        db.orders[0].snapshot = JSON.stringify({ ...snapshot, ...changed });
        assert.equal(await store.startManualRetry(id, prepared.client_order_no, credentials), null);
        assert.equal(db.orders[0].client_order_no, prepared.client_order_no);
    }
    db.orders[0].snapshot = waiting.snapshot;
    for (const changed of [{ is_active: 0 }, { manual_redeemed_at: '2026-11-10' }]) {
        const original = structuredClone(db.cdks[0]);
        Object.assign(db.cdks[0], changed);
        assert.equal(await store.startManualRetry(id, prepared.client_order_no, credentials), null);
        Object.assign(db.cdks[0], original); delete db.cdks[0].manual_redeemed_at;
    }
    db.fundings.push({ job_key: prepared.client_order_no, state: 'pending' });
    assert.equal(await store.startManualRetry(id, prepared.client_order_no, credentials), null);
    db.fundings.length = 0;
    db.issues.push({ job_key: prepared.client_order_no, state: 'unknown' });
    assert.equal(await store.startManualRetry(id, prepared.client_order_no, credentials), null);
    db.issues.length = 0;
    assert.equal((await store.startManualRetry(id, prepared.client_order_no, credentials)).state, 'preparing');
});

test('administrator retry does not queue when failed-card release rolls back and preparation failures keep the CDK locked', async () => {
    const { db, store } = storeFixture(), input = manualInput(id);
    const prepared = await prepareOrder(store, input);
    await store.claimManualSubmission(id);
    const snapshot = manualFailure(prepared);
    db.failRelease = true;
    await assert.rejects(store.settleManualOrder(id, { state: 'failed', taskNo: snapshot.task_no,
        snapshot, retryAllowed: true, expectedClientOrderNo: prepared.client_order_no }), /injected card release failure/);
    assert.equal(db.orders[0].state, 'submitting');
    assert.equal(db.card.active_job, prepared.client_order_no);
    assert.equal(db.card.reuse_after_ms, 0);
    db.failRelease = false;
    await store.settleManualOrder(id, { state: 'failed', taskNo: snapshot.task_no,
        snapshot, retryAllowed: true, expectedClientOrderNo: prepared.client_order_no });
    const next = await store.startManualRetry(id, prepared.client_order_no,
        { email: input.targetEmail, baseUrl: input.baseUrl, apiKeyHash: input.apiKeyHash });
    const stopped = await store.failManualPreparation(id, next.client_order_no, 'no existing cards');
    assert.equal(stopped.state, 'support_locked');
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(JSON.parse(stopped.retry_history).length, 1);
});

test('manual fulfillment emits a receipt atomically, while test orders and failures emit none', async () => {
    for (const mode of ['fulfillment', 'test']) {
        const receipts = []; let fail = mode === 'fulfillment';
        const { db, store } = storeFixture({ enqueueRedemption: async (receipt, options) => {
            assert.equal(options.connection.transaction, true);
            if (fail) throw Error('outbox unavailable');
            receipts.push(receipt);
        } });
        await prepareOrder(store, manualInput(id, { mode, cdkCode: mode === 'fulfillment' ? 'KC-READY' : null }));
        await store.claimManualSubmission(id);
        await store.settleManualOrder(id, { state: 'pending', message: 'pending' });
        assert.equal(receipts.length, 0);
        if (fail) {
            await assert.rejects(store.settleManualOrder(id, { state: 'success', message: 'success' }), /outbox/);
            assert.equal(db.orders[0].state, 'pending'); assert.equal(db.card.authorization_count, 0);
            assert.equal(db.card.authorization_pending_count, undefined);
            fail = false;
        }
        await store.settleManualOrder(id, { state: 'success', message: 'success' });
        await store.settleManualOrder(id, { state: 'success', message: 'success' });
        assert.equal(db.card.authorization_count, 0);
        assert.equal(db.card.authorization_pending_count, 1);
        assert.equal(receipts.length, mode === 'fulfillment' ? 1 : 0);
    }
    const { store } = storeFixture({ enqueueRedemption: async () => { throw Error('failed order must not emit'); } });
    await prepareOrder(store, manualInput(id)); await store.claimManualSubmission(id);
    await store.settleManualOrder(id, { state: 'failed', message: 'failed' });
});

test('manual CDK and card reservation settle atomically on verified success or failure', async () => {
    const { db, store, advance } = storeFixture();
    db.card.authorization_count=3;
    await assert.rejects(prepareOrder(store, manualInput(id, { acceptedCdkPlans: ['gpt-go'] })), /CDK/);
    assert.equal(db.cdks[0].used_at, null);
    assert.equal(db.card.active_job, null);
    await prepareOrder(store, manualInput(id));
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.active_job, `manual-${id}`);
    await assert.rejects(prepareOrder(store, manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0')), /待确认管理员订单/);
    assert.equal(await store.claimManualSubmission(id), true);
    await store.settleManualOrder(id, { state: 'failed', message: 'confirmed failure' });
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.orders[0].state,'support_locked');
    assert.equal(db.card.active_job, null);
    assert.equal(db.card.authorization_count, 3);
    advance(require('../orbitcard-pool').REUSE_COOLDOWN_MS);
    const next = '36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
    db.cdks.push({...db.cdks[0],cdk_code:'KC-SECOND',used_at:null});
    await prepareOrder(store, manualInput(next,{cdkCode:'KC-SECOND'}));
    await store.claimManualSubmission(next);
    await store.settleManualOrder(next, { state: 'success', message: 'confirmed success' });
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.active_job, null);
    assert.equal(db.card.authorization_count, 3);
    assert.equal(db.card.authorization_pending_count, 4);
    await store.settleManualOrder(next, { state: 'failed', message: 'stale failure' });
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.authorization_count, 3);
    assert.equal(db.card.authorization_pending_count, 4);
});

test('only an explicitly rejected unaccepted subscription releases the CDK without payment cooldown',async()=>{
    const {db,store}=storeFixture({enqueueRedemption:async()=>{throw Error('rejected orders cannot emit redemption');}});
    await prepareOrder(store,manualInput(id));await store.claimManualSubmission(id);
    await store.settleManualOrder(id,{state:'rejected',message:'not accepted'});
    assert.equal(db.orders[0].state,'rejected');assert.equal(db.card.active_job,null);assert.equal(db.cdks[0].used_at,null);
    assert.equal(db.card.reuse_after_ms,0);assert.equal(db.card.authorization_pending_count,undefined);
    await store.settleManualOrder(id,{state:'pending',message:'stale callback'});
    assert.equal(db.orders[0].state,'rejected');
    for(const state of ['pending','manual']) {
        const f=storeFixture();await prepareOrder(f.store,manualInput(id));await f.store.claimManualSubmission(id);
        await f.store.settleManualOrder(id,{state,message:'accepted or manually held'});
        await assert.rejects(f.store.settleManualOrder(id,{state:'rejected',message:'unsafe release'}),/不能按未受理释放/);
        assert.equal(f.db.orders[0].state,state);assert.equal(f.db.cdks[0].used_at,'reserved');assert.equal(f.db.card.active_job,`manual-${id}`);
    }
});

test('every confirmed accepted subscription failure locks the CDK and releases the card with cooldown',async()=>{
    for(const previous of ['submitting','pending','manual']) {
        const {db,store,now}=storeFixture();await prepareOrder(store,manualInput(id));await store.claimManualSubmission(id);
        if(previous!=='submitting')await store.settleManualOrder(id,{state:previous,message:previous});
        await store.settleManualOrder(id,{state:'failed',message:'confirmed failed'});
        assert.equal(db.orders[0].state,'support_locked');assert.equal(db.cdks[0].used_at,'reserved');assert.equal(db.card.active_job,null);
        assert.equal(db.card.reuse_after_ms,now()+require('../orbitcard-pool').REUSE_COOLDOWN_MS);
        await store.settleManualOrder(id,{state:'pending',message:'stale query'});
        assert.equal(db.orders[0].state,'support_locked');assert.equal(db.cdks[0].used_at,'reserved');
    }
});

test('manual original-order refresh settles terminal upstream snapshots and releases the card without another payment', async () => {
    for (const mode of ['test', 'fulfillment']) for (const status of ['failed', 'succeeded']) {
        const { db, store, now } = storeFixture();
        const cfg = { base_url: 'https://orbitcard.cc', api_key: 'snapshot-test-key' };
        const apiKeyHash = require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex');
        await prepareOrder(store, manualInput(id, { mode, cdkCode: mode === 'test' ? null : 'KC-READY', apiKeyHash }));
        await store.claimManualSubmission(id);
        await store.settleManualOrder(id, { state: 'pending', taskNo: 'SUB-SNAPSHOT', message: 'waiting' });
        db.card.balance = 91;
        store.acquirePaymentLock = require('./helpers/payment-locks.cjs')().acquirePaymentLock;
        const calls = [], events = [];
        const provider = { ...require('../orbitcard-client'), request: async (_, operation, body) => {
            calls.push(operation);
            assert.equal(operation, 'getSubscription');
            assert.deepEqual(body, { task_no: 'SUB-SNAPSHOT' });
            return { success: true, data: { task_no: 'SUB-SNAPSHOT', client_order_no: `manual-${id}`,
                plan_type: 'gpt-plus', card_id: 12, status, upstream_status: status,
                subscription_succeeded: status === 'succeeded', query_source: 'snapshot', result_source: 'upstream',
                ...(status === 'failed' ? { failureCode: 'EXISTING_SUBSCRIPTION_NOT_OURS' } : {}) } };
        } };
        const service = createService({ store, provider, now, activeJobs: new Set(), audit: event => events.push(event),
            cardService: { allocate: async () => assert.fail('reconciliation cannot allocate or fund a card') } });
        const result = await service.refresh(id, cfg);
        assert.equal(result.state, status === 'failed' ? 'retry_waiting' : 'success');
        assert.equal(db.card.active_job, null);
        assert.equal(db.card.balance, 91);
        assert.equal(db.card.authorization_count, 0);
        assert.equal(db.card.authorization_pending_count || 0, status === 'succeeded' ? 1 : 0);
        assert.equal(db.card.reuse_after_ms, now() + require('../orbitcard-pool').REUSE_COOLDOWN_MS);
        assert.equal(db.cdks[0].used_at, mode === 'test' ? null : 'reserved');
        assert.equal(events.find(event => event.event === 'subscription_result_checked').data.state,
            status === 'failed' ? 'failed' : 'success');
        await service.refresh(id, cfg);
        assert.deepEqual(calls, ['getSubscription']);
    }
});

test('manual snapshots with missing provenance, mismatched ownership or query errors retain the card', async () => {
    for (const scenario of ['provenance', 'identity', 'card', 'request_error', 'data_error', 'http_failure']) {
        const { db, store, now } = storeFixture();
        const cfg = { base_url: 'https://orbitcard.cc', api_key: 'snapshot-test-key' };
        const apiKeyHash = require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex');
        await prepareOrder(store, manualInput(id, { apiKeyHash }));
        await store.claimManualSubmission(id);
        await store.settleManualOrder(id, { state: 'pending', taskNo: 'SUB-SNAPSHOT', message: 'waiting' });
        store.acquirePaymentLock = require('./helpers/payment-locks.cjs')().acquirePaymentLock;
        const data = { task_no: 'SUB-SNAPSHOT', client_order_no: `manual-${id}`, plan_type: 'gpt-plus', card_id: 12,
            status: 'failed', upstream_status: 'failed', subscription_succeeded: false,
            query_source: 'snapshot', result_source: 'upstream' };
        const response = { success: true, data };
        if (scenario === 'provenance') delete data.result_source;
        if (scenario === 'identity') data.client_order_no = 'another-order';
        if (scenario === 'card') data.card_id = 99;
        if (scenario === 'request_error') response.requestError = { code: 'relay_query_failed' };
        if (scenario === 'data_error') data.request_error = { code: 'relay_query_failed' };
        if (scenario === 'http_failure') response.success = false;
        const provider = { ...require('../orbitcard-client'), request: async (_, operation) => {
            assert.equal(operation, 'getSubscription'); return response;
        } };
        const service = createService({ store, provider, now, activeJobs: new Set(), audit() {}, cardService: {} });
        assert.equal((await service.refresh(id, cfg)).state, 'pending', scenario);
        assert.equal(db.card.active_job, `manual-${id}`, scenario);
        assert.equal(db.card.reuse_after_ms, 0, scenario);
        assert.equal(db.cdks[0].used_at, 'reserved', scenario);
    }
});

test('administrator success waits for its authorization; seven observed authorizations stop further allocations', async () => {
    const { db, store, advance } = storeFixture();
    for (let count = 0; count < 7; count++) {
        const requestId = `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
        const input = manualInput(requestId, { mode: 'test', cdkCode: null });
        await prepareOrder(store, input);
        await store.claimManualSubmission(requestId);
        await store.settleManualOrder(requestId, { state: 'pending', message: 'pending' });
        assert.equal(db.card.authorization_count, count);
        await store.settleManualOrder(requestId, { state: 'success', message: 'confirmed success' });
        await store.settleManualOrder(requestId, { state: 'success', message: 'duplicate query' });
        await store.settleManualOrder(requestId, { state: 'failed', message: 'stale failure' });
        assert.equal(db.card.authorization_count, count);
        assert.equal(db.card.authorization_pending_count, count + 1);
        assert.equal(db.card.active_job, null);
        const waitingId = `10000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
        const waiting = await store.prepareManualOrder(manualInput(waitingId, { mode: 'test', cdkCode: null }));
        assert.equal(await store.reserveManualCard(waitingId,12,waiting.client_order_no,'gpt-plus'),null);
        await store.failManualPreparation(waitingId,waiting.client_order_no,'still awaiting authorization');
        // This fixture stands in for a successful transaction-ID synchronization.
        db.card.authorization_count = count + 1;
        advance(require('../orbitcard-pool').REUSE_COOLDOWN_MS);
    }
    const eighth = manualInput(id, { mode: 'test', cdkCode: null });
    const order = await store.prepareManualOrder(eighth);
    assert.equal(await store.reserveManualCard(id, 12, order.client_order_no, eighth.planType), null);
    assert.equal(db.card.authorization_count, 7);
    assert.equal(db.card.active_job, null);
});

test('submitted administrator success and failure cool the card even when authorization has already synchronized', async () => {
    const { REUSE_COOLDOWN_MS } = require('../orbitcard-pool');
    for (const state of ['success', 'failed']) {
        const { db, store, now, advance } = storeFixture();
        await prepareOrder(store, manualInput(id, { mode: 'test', cdkCode: null }));
        await store.claimManualSubmission(id);
        // An authorization can become visible before the card balance catches up.
        db.card.authorization_count = 1;
        await store.settleManualOrder(id, { state, message: 'confirmed' });
        const reuseAfter = now() + REUSE_COOLDOWN_MS;
        assert.equal(db.card.reuse_after_ms, reuseAfter);
        assert.equal(db.card.active_job, null);
        const nextId = '36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
        const next = await store.prepareManualOrder(manualInput(nextId, { mode: 'test', cdkCode: null }));
        assert.equal(await store.reserveManualCard(nextId, 12, next.client_order_no, 'gpt-plus'), null);
        advance(REUSE_COOLDOWN_MS - 1);
        await store.settleManualOrder(id, { state, message: 'duplicate final result' });
        assert.equal(db.card.reuse_after_ms, reuseAfter, 'duplicate settlement must not extend cooldown');
        assert.equal(await store.reserveManualCard(nextId, 12, next.client_order_no, 'gpt-plus'), null);
        advance(1);
        assert.ok(await store.reserveManualCard(nextId, 12, next.client_order_no, 'gpt-plus'));
    }
});

test('expired administrator cooldown still requires the successful authorization to be visible', async () => {
    const { db, store, advance } = storeFixture();
    await prepareOrder(store, manualInput(id, { mode: 'test', cdkCode: null }));
    await store.claimManualSubmission(id);
    await store.settleManualOrder(id, { state: 'success', message: 'confirmed' });
    advance(require('../orbitcard-pool').REUSE_COOLDOWN_MS);
    const nextId = '36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
    const next = await store.prepareManualOrder(manualInput(nextId, { mode: 'test', cdkCode: null }));
    assert.equal(await store.reserveManualCard(nextId, 12, next.client_order_no, 'gpt-plus'), null);
    db.card.authorization_count = 1;
    assert.ok(await store.reserveManualCard(nextId, 12, next.client_order_no, 'gpt-plus'));
});

test('failure to persist administrator card cooldown rolls back settlement and keeps ownership', async () => {
    const { db, store } = storeFixture();
    await prepareOrder(store, manualInput(id));
    await store.claimManualSubmission(id);
    db.failCooldown = true;
    await assert.rejects(store.settleManualOrder(id, { state: 'success', message: 'confirmed' }), /冷却/);
    assert.equal(db.orders[0].state, 'submitting');
    assert.equal(db.card.active_job, `manual-${id}`);
    assert.equal(db.card.reuse_after_ms, 0);
    assert.equal(db.card.authorization_pending_count, undefined);
    assert.equal(db.cdks[0].used_at, 'reserved');
});

test('a lost transaction snapshot does not change an order result or invent a consumption count', async () => {
    const { db, store } = storeFixture();
    await prepareOrder(store, manualInput(id));
    await store.claimManualSubmission(id);
    db.card.authorization_count = null;
    await store.settleManualOrder(id, { state: 'success', message: 'confirmed success' });
    assert.equal(db.orders[0].state, 'success');
    assert.equal(db.card.authorization_count, null);
    assert.equal(db.card.authorization_pending_count, 1);
    assert.equal(db.card.active_job, null);
    const nextId = '36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
    const next = await store.prepareManualOrder(manualInput(nextId,{mode:'test',cdkCode:null}));
    assert.equal(await store.reserveManualCard(nextId,12,next.client_order_no,'gpt-plus'),null);
});

test('a replayed manual reservation keeps its original authorization baseline', async () => {
    const {db,store,advance}=storeFixture();
    const order=await store.prepareManualOrder(manualInput(id));
    assert.ok(await store.reserveManualCard(id,12,order.client_order_no,'gpt-plus'));
    assert.equal(db.orders[0].authorization_baseline,0);
    db.card.authorization_count=1;
    assert.ok(await store.reserveManualCard(id,12,order.client_order_no,'gpt-plus'));
    assert.equal(db.orders[0].authorization_baseline,0);
    await store.markManualPrepared(id,order.client_order_no,12);await store.claimManualSubmission(id);
    await store.settleManualOrder(id,{state:'success',message:'confirmed'});
    assert.equal(db.card.authorization_pending_count,1);
    const nextId='36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
    const next=await store.prepareManualOrder(manualInput(nextId,{mode:'test',cdkCode:null}));
    assert.equal(await store.reserveManualCard(nextId,12,next.client_order_no,'gpt-plus'),null);
    advance(require('../orbitcard-pool').REUSE_COOLDOWN_MS);
    assert.ok(await store.reserveManualCard(nextId,12,next.client_order_no,'gpt-plus'));
});

test('late manual-order failure preserves a support-redeemed CDK while releasing the original payment card', async () => {
    const { db, store } = storeFixture();
    await prepareOrder(store, manualInput(id));
    await store.claimManualSubmission(id);
    db.cdks[0].manual_redeemed_at = '2026-10-26';
    await store.settleManualOrder(id, { state: 'failed', message: 'original payment failed' });
    assert.equal(db.orders[0].state, 'support_locked');
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.active_job, null);
    assert.equal(db.card.authorization_count, 0);
});

test('manual-order handoff persists through pending queries and confirmed failure cannot release its CDK for recharge', async () => {
    const { db, store } = storeFixture();
    await prepareOrder(store, manualInput(id)); await store.claimManualSubmission(id);
    await store.settleManualOrder(id, { state: 'manual', message: 'support' });
    await store.settleManualOrder(id, { state: 'pending', message: 'upstream pending' });
    assert.equal(db.orders[0].state, 'manual');
    await store.settleManualOrder(id, { state: 'failed', message: 'confirmed failure' });
    assert.equal(db.orders[0].state, 'support_locked'); assert.ok(db.cdks[0].used_at);
    assert.equal(db.card.active_job, null); assert.equal(db.card.authorization_count, 0);
});

test('a prepared order interrupted before submission releases its CDK and card without a platform call', async () => {
    const { db, store } = storeFixture();
    await prepareOrder(store, manualInput(id));
    assert.equal(db.cdks[0].used_at, 'reserved');
    await store.abandonPreparedManualOrder(id);
    assert.equal(db.orders[0].state, 'failed');
    assert.equal(db.cdks[0].used_at, null);
    assert.equal(db.card.active_job, null);
    assert.equal(db.card.reuse_after_ms, 0);
});

test('a stale query cannot settle an unsubmitted admin preparation', async () => {
    const {db,store}=storeFixture(); await prepareOrder(store, manualInput(id));
    const order=await store.settleManualOrder(id,{state:'success',message:'stale query'});
    assert.equal(order.state,'prepared');assert.equal(db.card.authorization_count,0);
    assert.equal(db.card.active_job,`manual-${id}`);assert.equal(db.cdks[0].used_at,'reserved');
});

test('automatic manual preparation reserves its CDK before card funding and binds one eligible card', async () => {
    const { db, store } = storeFixture();
    const order = await store.prepareManualOrder(manualInput(id));
    assert.equal(order.state, 'preparing');
    assert.equal(order.card_id, 0);
    assert.equal(db.cdks[0].used_at, 'reserved');
    await assert.rejects(store.prepareManualOrder(manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0')), /待确认管理员订单/);
    assert.ok(await store.reserveManualCard(id, 12, `manual-${id}`, 'gpt-plus'));
    assert.equal(db.card.active_job, `manual-${id}`);
    await store.markManualPrepared(id, `manual-${id}`, 12);
    assert.equal(await store.claimManualSubmission(id), true);
    await store.settleManualOrder(id, { state: 'success', message: 'confirmed success' });
    assert.equal(db.card.authorization_count, 0);
    assert.equal(db.card.authorization_pending_count, 1);
    assert.equal(db.card.active_job, null);
    assert.equal(db.cdks[0].used_at, 'reserved');
});

test('a failed manual preparation before any remote write releases its card and CDK', async () => {
    const { db, store } = storeFixture();
    await store.prepareManualOrder(manualInput(id));
    await store.reserveManualCard(id, 12, `manual-${id}`, 'gpt-plus');
    await store.failManualPreparation(id, `manual-${id}`, '账户余额不足');
    assert.equal(db.orders[0].state, 'failed');
    assert.equal(db.card.active_job, null);
    assert.equal(db.cdks[0].used_at, null);
});

test('insufficient funds after a confirmed card issue releases the original card and CDK in one transaction',async()=>{
    for(const fundingState of [null,'ready','failed']) {
        const {db,store}=storeFixture();const order=await store.prepareManualOrder(manualInput(id));
        await store.reserveManualCard(id,12,order.client_order_no,'gpt-plus');
        await store.attachManualIssue(id,order.client_order_no,'issue-original');
        const identity={scope:order.scope,job_key:order.client_order_no,credential_hash:order.api_key_hash,plan_type:'plus',card_id:12};
        db.issues.push({...identity,issue_key:'issue-original',state:'ready'});
        if(fundingState)db.fundings.push({...identity,funding_key:'funding-original',state:fundingState});
        await store.failManualPreparation(id,order.client_order_no,'账户余额不足');
        assert.equal(db.orders[0].state,'failed');assert.equal(db.card.active_job,null);assert.equal(db.cdks[0].used_at,null);
        assert.equal(db.card.reuse_after_ms,0);assert.equal(db.issues[0].state,'ready');
    }
});

test('a confirmed failed card issue without a card releases the CDK',async()=>{
    const {db,store}=storeFixture();const order=await store.prepareManualOrder(manualInput(id));
    await store.attachManualIssue(id,order.client_order_no,'issue-failed');
    db.issues.push({issue_key:'issue-failed',scope:order.scope,job_key:order.client_order_no,
        credential_hash:order.api_key_hash,plan_type:'plus',card_id:null,state:'failed'});
    await store.failManualPreparation(id,order.client_order_no,'原开卡已失败');
    assert.equal(db.orders[0].state,'failed');assert.equal(db.cdks[0].used_at,null);
});

test('unresolved or mismatched funding and issue records prevent preparation release',async()=>{
    const mutations=[{state:'pending'},{state:'unknown'},{state:'submitting'},{state:'prepared'},
        {scope:'another-platform'},{credential_hash:'another-key'},{plan_type:'pro100'},{card_id:99}];
    for(const kind of ['issue','funding'])for(const mutation of mutations) {
        const {db,store}=storeFixture();const order=await store.prepareManualOrder(manualInput(id));
        await store.reserveManualCard(id,12,order.client_order_no,'gpt-plus');
        const identity={scope:order.scope,job_key:order.client_order_no,credential_hash:order.api_key_hash,plan_type:'plus',card_id:12,state:'ready'};
        if(kind==='issue') {
            await store.attachManualIssue(id,order.client_order_no,'issue-original');
            db.issues.push({...identity,issue_key:'issue-original',...mutation});
        } else db.fundings.push({...identity,funding_key:'funding-original',...mutation});
        await assert.rejects(store.failManualPreparation(id,order.client_order_no,'账户余额不足'),/不能自动释放/);
        assert.equal(db.orders[0].state,'preparing');assert.equal(db.card.active_job,order.client_order_no);assert.equal(db.cdks[0].used_at,'reserved');
    }
});

test('missing, foreign, or unlinked pending issue records cannot unlock an administrator preparation',async()=>{
    for(const scenario of ['missing','foreign-job','unlinked-pending','duplicate']) {
        const {db,store}=storeFixture();const order=await store.prepareManualOrder(manualInput(id));
        await store.reserveManualCard(id,12,order.client_order_no,'gpt-plus');
        const issue={issue_key:'issue-original',scope:order.scope,job_key:order.client_order_no,
            credential_hash:order.api_key_hash,plan_type:'plus',card_id:12,state:'ready'};
        if(scenario!=='unlinked-pending')await store.attachManualIssue(id,order.client_order_no,issue.issue_key);
        if(scenario!=='missing')db.issues.push({...issue,...(scenario==='foreign-job'?{job_key:'manual-other'}:{}),
            ...(scenario==='unlinked-pending'?{state:'pending'}:{})});
        if(scenario==='duplicate')db.issues.push({...issue,issue_key:'issue-second'});
        await assert.rejects(store.failManualPreparation(id,order.client_order_no,'账户余额不足'),/不能自动释放/);
        assert.equal(db.orders[0].state,'preparing');assert.equal(db.card.active_job,order.client_order_no);assert.equal(db.cdks[0].used_at,'reserved');
    }
});
