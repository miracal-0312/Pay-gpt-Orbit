'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createService = require('../orbitcard-manual-service');
const createStore = require('../orbitcard-manual-store');
const { cardScope } = require('../orbitcard-card-policy');

function fixture({ unknown = false, pendingAllocation = false, now = Date.now } = {}) {
    const orders = new Map(), calls = [], created = [], allocations = [];
    const cfg = { enabled: true, base_url: 'https://orbitcard.cc', api_key: 'key' };
    const plans = [
        { type: 'gpt-go', name: 'Go' }, { type: 'gpt-plus', name: 'Plus' },
        { type: 'gpt-credits-250', name: '250 credits' }
    ];
    const store = {
        getGptApiConfig: async () => cfg,
        getMaxConcurrentActivations: async () => 5,
        getManualOrder: async id => orders.get(id) || null,
        listManualOrders: async () => [...orders.values()],
        listRecoverableManualOrders: async () => [...orders.values()].filter(x => x.state === 'manual'),
        cardMethods: () => ({ listCards: async () => [{ card_id: 12, history_confirmed: 1,
            active_job: null, successful_plus: 0, successful_pro100: 0,
            successful_pro200: 0, successful_pro500: 0 }] }),
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
            if (!['success','failed'].includes(row.state)) Object.assign(row, change);
            return row;
        },
    };
    const provider = {
        fetchPlans: async () => ({ success: true, plans }),
        summary: value => ({ task_no: value?.task_no, client_order_no: value?.client_order_no }),
        outcome: value => value.upstream_status === 'succeeded' ? 'success' : 'pending',
        captcha: () => null,
        request: async (_cfg, operation, body, key) => {
            calls.push({ operation, body, key });
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
    const cardService = { allocate: async (_cfg, jobKey, planType, selection) => {
        allocations.push({ jobKey, planType, selection });
        if (pendingAllocation && allocations.length === 1) {
            throw new (require('../orbitcard-card-policy').FundingPendingError)('原补款结果待确认');
        }
        return 12;
    } };
    const activeJobs = new Set();
    const service = createService({ store, activeJobs, audit: () => {}, provider, cardService, now });
    return { service, calls, created, orders, allocations, cfg, store, provider, cardService, activeJobs };
}

async function until(check) {
    for (let i = 0; i < 25; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('background order did not reach expected state');
}

const session = JSON.stringify({ user: { email: 'buyer@example.com' }, account: {}, accessToken: 'secret-session' });
const id = '1b056caa-d7a6-4c39-9672-88e9cc5c6577';

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
    await until(() => orders.get(id).state === 'manual');
    await service.refresh(id);
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 1);
    assert(calls.filter(x => x.operation === 'getSubscription').every(x => x.body.client_order_no === `manual-${id}`));
});

test('manual preparation is never queried as a submitted subscription', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture({pendingAllocation:true});
    await assert.rejects(f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true}),/原补款/);
    assert.equal((await f.service.refresh(id)).state,'preparing');
    assert.equal(f.calls.length,0);
});

test('manual query checks original platform before making another request', async () => {
    process.env.ORBITCARD_API_KEY='key';process.env.ORBITCARD_API_SECRET='secret';
    const f=fixture({unknown:true});
    await f.service.create({requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true});
    await until(()=>f.orders.get(id).state==='manual');
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

test('pending funding keeps the same manual request and never submits until it is confirmed', async () => {
    process.env.ORBITCARD_API_KEY = 'key'; process.env.ORBITCARD_API_SECRET = 'secret';
    const { service, allocations, calls, orders } = fixture({ pendingAllocation: true });
    const input = { requestId: id, planType: 'gpt-plus', mode: 'test', session, authorized: true };
    await assert.rejects(service.create(input), /原补款结果待确认/);
    assert.equal(orders.get(id).state, 'preparing');
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 0);
    await service.create(input);
    await until(() => orders.get(id).state === 'success');
    assert.equal(allocations.length, 2);
    assert.equal(calls.filter(x => x.operation === 'createSubscription').length, 1);
});

function storeFixture() {
    const scope = cardScope('https://orbitcard.cc');
    const db = { orders: [], cdks: [{ cdk_code: 'KC-READY', is_active: 1, type: '自助',
        plan_type: 'plus', used_at: null }], card: { scope, card_id: 12, history_confirmed: 1,
        active_job: null, provider_status: 'ACTIVE', currency: 'USD', successful_plus: 0 } };
    const clean = sql => sql.replace(/\s+/g, ' ').trim();
    const runQuery = async (sql, p = []) => {
        const q = clean(sql);
        if (q.startsWith('SELECT * FROM orbitcard_admin_orders WHERE request_id')) return db.orders.filter(o => o.request_id === p[0]
            && (!q.includes("state = 'prepared'") || o.state === 'prepared')).map(o => structuredClone(o));
        if (q.startsWith('SELECT request_id FROM orbitcard_admin_orders WHERE scope')) return db.orders.filter(o => o.scope === p[0]
            && o.target_email === p[1] && o.plan_type === p[2] && ['preparing','prepared','submitting','pending','manual'].includes(o.state)).map(o => structuredClone(o));
        if (q.startsWith('SELECT request_id FROM orbitcard_admin_orders WHERE cdk_code')) return db.orders.filter(o => o.cdk_code === p[0] && o.state === 'success').map(o => structuredClone(o));
        if (q.startsWith('SELECT * FROM cdk_codes') || q.startsWith('SELECT cdk_code FROM cdk_codes')) return db.cdks.filter(c => c.cdk_code === p[0]).map(o => structuredClone(o));
        if (q.startsWith('SELECT job_key FROM task_logs')) return [];
        if (q.startsWith('SELECT funding_key FROM orbitcard_card_fundings')) return [];
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
        else if (q.startsWith('INSERT INTO orbitcard_admin_orders')) db.orders.push({
            request_id: p[0], client_order_no: p[1], scope: p[2], api_key_hash: p[3],
            mode: p[4], cdk_code: p[5], plan_type: p[6], plan_name: p[7],
            target_email: p[8], card_id: p[9], admin_email: p[10], state: 'prepared',
            task_no: null, snapshot: null, message: p[11]
        });
        else if (q.startsWith('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP')) db.cdks.find(c => c.cdk_code === p[0]).used_at = 'reserved';
        else if (q.startsWith('UPDATE cdk_codes SET used_at = NULL')) db.cdks.find(c => c.cdk_code === p[0]).used_at = null;
        else if (q.startsWith('UPDATE orbitcard_admin_orders SET card_id = ?')) {
            const row = db.orders.find(o => o.request_id === p[2]); row.card_id = p[0]; row.message = p[1];
        } else if (q.startsWith('UPDATE orbitcard_admin_orders SET issue_key = ?')) {
            const row = db.orders.find(o => o.request_id === p[2]); row.issue_key = p[0]; row.message = p[1];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'prepared'")) {
            const row = db.orders.find(o => o.request_id === p[1]); row.state = 'prepared'; row.message = p[0];
        }
        else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job = ?')) {
            db.card.active_job = p[0]; db.card.active_plan = p[1];
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'submitting'")) {
            const row = db.orders.find(o => o.request_id === p[0]);
            if (row.state !== 'prepared') return { affectedRows: 0 };
            row.state = 'submitting';
        } else if (q.startsWith('UPDATE orbitcard_admin_orders SET state = ?')) {
            const row = db.orders.find(o => o.request_id === p[4]);
            Object.assign(row, { state: p[0], task_no: row.task_no || p[1], snapshot: p[2], message: p[3] });
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job = NULL')) {
            db.card.active_job = null; db.card.active_plan = null;
            if (q.includes('successful_plus = successful_plus + 1')) db.card.successful_plus++;
        } else if (q.startsWith("UPDATE orbitcard_admin_orders SET state = 'failed'")) {
            const row = db.orders.find(o => o.request_id === (p.length > 1 ? p[1] : p[0]));
            row.state = 'failed'; row.message = p.length > 1 ? p[0] : 'abandoned';
        } else if (q.startsWith('INSERT INTO cdk_codes')) {
            db.cdks.push({ cdk_code: p[0], is_active: 1, type: '手动', plan_type: p[1], used_at: null });
        } else throw new Error(`Unexpected execute ${q}`);
        return { affectedRows: 1 };
    };
    const withTransaction = async action => {
        const backup = structuredClone(db);
        try { return await action({ transaction: true }); }
        catch (error) { Object.assign(db, backup); throw error; }
    };
    return { db, store: createStore({ runQuery, runExecute, withTransaction }) };
}

function manualInput(requestId, overrides = {}) {
    return { requestId, planType: 'gpt-plus', planName: 'Plus', targetEmail: 'buyer@example.com',
        cardId: 12, baseUrl: 'https://orbitcard.cc', apiKeyHash: 'a'.repeat(64),
        adminEmail: 'admin@example.com', mode: 'fulfillment', cdkCode: 'KC-READY',
        acceptedCdkPlans: ['gpt-plus','plus'], ...overrides };
}

test('manual CDK and card reservation settle atomically on verified success or failure', async () => {
    const { db, store } = storeFixture();
    await assert.rejects(store.createManualOrder(manualInput(id, { acceptedCdkPlans: ['gpt-go'] })), /CDK/);
    assert.equal(db.cdks[0].used_at, null);
    assert.equal(db.card.active_job, null);
    await store.createManualOrder(manualInput(id));
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.active_job, `manual-${id}`);
    await assert.rejects(store.createManualOrder(manualInput('36aad0bb-5eb7-4771-93f5-1ebd049b29e0')), /待确认管理员订单/);
    assert.equal(await store.claimManualSubmission(id), true);
    await store.settleManualOrder(id, { state: 'failed', message: 'confirmed failure' });
    assert.equal(db.cdks[0].used_at, null);
    assert.equal(db.card.active_job, null);
    assert.equal(db.card.successful_plus, 0);
    const next = '36aad0bb-5eb7-4771-93f5-1ebd049b29e0';
    await store.createManualOrder(manualInput(next));
    await store.claimManualSubmission(next);
    await store.settleManualOrder(next, { state: 'success', message: 'confirmed success' });
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.active_job, null);
    assert.equal(db.card.successful_plus, 1);
    await store.settleManualOrder(next, { state: 'failed', message: 'stale failure' });
    assert.equal(db.cdks[0].used_at, 'reserved');
    assert.equal(db.card.successful_plus, 1);
});

test('a prepared order interrupted before submission releases its CDK and card without a platform call', async () => {
    const { db, store } = storeFixture();
    await store.createManualOrder(manualInput(id));
    assert.equal(db.cdks[0].used_at, 'reserved');
    await store.abandonPreparedManualOrder(id);
    assert.equal(db.orders[0].state, 'failed');
    assert.equal(db.cdks[0].used_at, null);
    assert.equal(db.card.active_job, null);
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
    assert.equal(db.card.successful_plus, 1);
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
