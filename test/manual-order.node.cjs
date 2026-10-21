'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createService = require('../orbitcard-manual-service');
const createStore = require('../orbitcard-manual-store');
const { cardScope } = require('../orbitcard-card-policy');

function fixture({ unknown = false } = {}) {
    const orders = new Map(), calls = [], created = [];
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
        createManualOrder: async input => {
            created.push(input);
            const row = { request_id: input.requestId, client_order_no: `manual-${input.requestId}`,
                scope: cardScope(input.baseUrl),
                api_key_hash: require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex'),
                plan_type: input.planType, plan_name: input.planName, target_email: input.targetEmail,
                card_id: input.cardId, mode: input.mode, cdk_code: input.cdkCode, state: 'prepared' };
            orders.set(input.requestId, row); return { order: row, created: true };
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
    const cards = {
        listCards: async () => [{ card_id: 12, last4: '1234', provider_status: 'ACTIVE', currency: 'USD', balance_amount: 30 }],
        cardDetailsInBatches: async () => [{ card_id: 12, last4: '1234', provider_status: 'ACTIVE', currency: 'USD', balance_amount: 30 }],
        positiveId: value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
    };
    const service = createService({ store, activeJobs: new Set(), audit: () => {}, provider, cards });
    return { service, calls, created, orders, cfg };
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
    const { service, calls, created, orders, cfg } = fixture();
    cfg.enabled = false; // Public new-order switch does not disable an authenticated administrator test.
    const catalog = await service.catalog();
    assert.deepEqual(catalog.plans.map(x => x.type), ['gpt-plus']);
    await assert.rejects(service.create({ requestId: id, planType: 'gpt-credits-250', cardId: 12,
        mode: 'test', cdkCode: '', session, authorized: true, adminEmail: 'admin@example.com' }), /未对该 API Key 开放/);
    await service.create({ requestId: id, planType: 'gpt-plus', cardId: 12,
        mode: 'test', cdkCode: '', session, authorized: true, adminEmail: 'admin@example.com' });
    await until(() => orders.get(id).state === 'success');
    assert.equal(created[0].cdkCode, null);
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
            && o.target_email === p[1] && o.plan_type === p[2] && ['prepared','submitting','pending','manual'].includes(o.state)).map(o => structuredClone(o));
        if (q.startsWith('SELECT request_id FROM orbitcard_admin_orders WHERE cdk_code')) return db.orders.filter(o => o.cdk_code === p[0] && o.state === 'success').map(o => structuredClone(o));
        if (q.startsWith('SELECT * FROM cdk_codes') || q.startsWith('SELECT cdk_code FROM cdk_codes')) return db.cdks.filter(c => c.cdk_code === p[0]).map(o => structuredClone(o));
        if (q.startsWith('SELECT job_key FROM task_logs')) return [];
        if (q.startsWith('SELECT * FROM orbitcard_managed_cards')) return db.card.scope === p[0] && db.card.card_id === p[1] ? [structuredClone(db.card)] : [];
        throw new Error(`Unexpected query ${q}`);
    };
    const runExecute = async (sql, p = []) => {
        const q = clean(sql);
        if (q.startsWith('INSERT INTO orbitcard_admin_orders')) db.orders.push({
            request_id: p[0], client_order_no: p[1], scope: p[2], api_key_hash: p[3],
            mode: p[4], cdk_code: p[5], plan_type: p[6], plan_name: p[7],
            target_email: p[8], card_id: p[9], admin_email: p[10], state: 'prepared',
            task_no: null, snapshot: null, message: p[11]
        });
        else if (q.startsWith('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP')) db.cdks.find(c => c.cdk_code === p[0]).used_at = 'reserved';
        else if (q.startsWith('UPDATE cdk_codes SET used_at = NULL')) db.cdks.find(c => c.cdk_code === p[0]).used_at = null;
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
            const row = db.orders.find(o => o.request_id === p[0]); row.state = 'failed'; row.message = 'abandoned';
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
