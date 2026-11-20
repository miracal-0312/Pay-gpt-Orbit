'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { projectBusinessOrder } = require('../src/payments/order-business-status');

const closedAt = '2026-11-17 18:00:00.123';
function load(relative, mocks = {}) {
    const filename = path.resolve(__dirname, '..', relative), real = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports, path.dirname(filename));
    return module.exports;
}
function task(overrides = {}) {
    return { id: 1, job_key: 'original-job', status: 'manual', orbitcard_state: 'funding_pending',
        orbitcard_client_order_no: 'original-client', orbitcard_plan_type: 'plus',
        manual_result: 'success', manual_result_at: closedAt, progress: 30,
        gpt_api_raw: JSON.stringify({ status: 'processing', client_order_no: 'original-client' }), ...overrides };
}
function assertClosed(view, outcome, at = closedAt) {
    assert.equal(view.business_status, 'closed');
    assert.equal(view.business_result, outcome);
    assert.equal(view.business_closed_at, at);
}

test('persisted manual results close business immediately despite every original pending state and either release choice', () => {
    for (const manual_result of ['success', 'failed']) for (const state of ['preparing', 'funding_pending', 'card_pending', 'manual']) {
        for (const manual_local_released_at of [null, closedAt]) {
            for (const row of [task({ orbitcard_state: state, manual_result, manual_local_released_at }),
                { state, manual_result, manual_result_at: closedAt, manual_local_released_at }]) {
                const before = structuredClone(row);
                assertClosed(projectBusinessOrder(Object.freeze(row)), manual_result);
                assert.deepEqual(row, before, 'Projection cannot manufacture platform settlement or release reservations');
            }
        }
    }
    assertClosed(projectBusinessOrder(task({ manual_result_at: null })), 'success', null);
});

test('late original outcomes cannot reopen a manually closed order or replace its closure time', () => {
    for (const manual_result of ['success', 'failed']) {
        const row = task({ manual_result });
        for (const state of ['manual', 'success', 'failed', 'rejected', 'support_locked']) {
            Object.assign(row, { status: state, orbitcard_state: state, updated_at: '2026-11-18 12:00:00',
                gpt_api_raw: JSON.stringify({ status: state, subscription_succeeded: state === 'success' }) });
            assertClosed(projectBusinessOrder(row), manual_result);
        }
    }
});

test('notes, pauses, releases alone and invalid manual markers preserve the original business state', () => {
    for (const action of ['note', 'pause']) for (const manual_result of [null, '', 'unrecognized']) {
        const row = task({ orbitcard_state: 'funding_pending', manual_result, manual_result_at: null,
            manual_local_released_at: closedAt, last_manual_action: action });
        assert.deepEqual(projectBusinessOrder(row), {
            business_status: 'funding_pending', business_result: null, business_closed_at: null });
    }
    for (const state of ['success', 'failed', 'rejected', 'balance_blocked', 'support_locked', 'manual', 'pending']) {
        const expected = state === 'success' ? 'success' : ['failed', 'rejected', 'balance_blocked', 'support_locked'].includes(state) ? 'failed' : null;
        for (const row of [{ orbitcard_state: state }, { state }, { status: state }]) {
            assert.deepEqual(projectBusinessOrder(row), { business_status: state, business_result: expected, business_closed_at: null });
        }
    }
    assert.deepEqual(projectBusinessOrder({}), { business_status: null, business_result: null, business_closed_at: null });
});

function adminDataFixture(rows) {
    // Execute the production aggregate SQL against synthetic in-memory rows.
    // No MySQL connection, network, persistence or production data is involved.
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE task_logs (orbitcard_client_order_no TEXT, orbitcard_state TEXT, manual_result TEXT)');
    const insert = db.prepare('INSERT INTO task_logs VALUES (?, ?, ?)');
    for (const row of rows) insert.run(row.orbitcard_client_order_no ?? null, row.orbitcard_state ?? null, row.manual_result ?? null);
    const queries = [], core = {
        runQuery: async (sql, params) => {
            queries.push(sql);
            if (/COUNT\(\*\)/.test(sql) && /FROM task_logs/.test(sql)) return [{ ...db.prepare(sql).get() }];
            if (/FROM cdk_codes/.test(sql)) return [{ total: 0, used: 0 }];
            if (/FROM task_logs ORDER BY id DESC/.test(sql)) return structuredClone(rows);
            throw new Error('Unexpected query: ' + sql);
        },
        runExecute: async () => assert.fail('Reading business status must not write'),
        getMaintenanceModeState: async () => ({ enabled: false, drain: false }),
        getAppConfigValue: async () => '2', getTelegramConfig: async () => ({ bot_token: '' })
    };
    const store = load('src/db/mysql-store.js', { './mysql-core': core });
    return { store, queries, close: () => db.close() };
}

test('dashboard counts 44 as 23 successful plus 21 manually failed and zero processing without rewriting old rows', async t => {
    const rows = [
        ...Array.from({ length: 23 }, (_, i) => task({ id: i + 1, job_key: `success-${i}`, orbitcard_state: 'success', manual_result: null })),
        ...Array.from({ length: 20 }, (_, i) => task({ id: i + 24, job_key: `failed-${i}`, orbitcard_state: 'failed', manual_result: null })),
        task({ id: 44, job_key: 'manual-failed', manual_result: 'failed' }),
        task({ id: 45, orbitcard_client_order_no: null, manual_result: 'success' })
    ];
    const before = structuredClone(rows), f = adminDataFixture(rows); t.after(f.close);
    const data = await f.store.getAdminData();
    assert.deepEqual(data.stats, { total: 44, success: 23, failed: 21, pending: 0, cdk_total: 0, cdk_used: 0 });
    assert.equal(data.stats.total, data.stats.success + data.stats.failed + data.stats.pending);
    for (const row of data.logs.filter(row => row.manual_result === 'failed')) {
        assertClosed(row, 'failed'); assert.equal(row.orbitcard_state, 'funding_pending'); assert.equal(row.status, 'manual');
    }
    assert.deepEqual(rows, before);
});

test('aggregate precedence agrees with business views for manual success, opposite final results and still-open pauses', async t => {
    const rows = [
        task({ manual_result: 'success', orbitcard_state: 'funding_pending' }),
        task({ manual_result: 'success', orbitcard_state: 'failed' }),
        task({ manual_result: 'failed', orbitcard_state: 'success' }),
        task({ manual_result: null, orbitcard_state: 'success' }),
        task({ manual_result: null, orbitcard_state: 'failed' }),
        task({ manual_result: null, orbitcard_state: 'funding_pending', last_manual_action: 'pause' }),
        task({ manual_result: 'unrecognized', orbitcard_state: 'manual', last_manual_action: 'note' })
    ];
    const f = adminDataFixture(rows); t.after(f.close);
    const data = await f.store.getAdminData();
    assert.deepEqual(data.stats, { total: 7, success: 3, failed: 2, pending: 2, cdk_total: 0, cdk_used: 0 });
    const projected = data.logs.map(row => row.business_result);
    assert.equal(projected.filter(value => value === 'success').length, data.stats.success);
    assert.equal(projected.filter(value => value === 'failed').length, data.stats.failed);
    assert.equal(projected.filter(value => value === null).length, data.stats.pending);
});

test('administrator order list and detail expose legacy manual closure without changing reconciliation facts', async () => {
    for (const manual_result of ['success', 'failed']) {
        const row = { request_id: 'old-admin', client_order_no: 'manual-old', state: 'funding_pending',
            manual_result, manual_result_at: closedAt, retry_history: '[]', snapshot: '{"status":"processing"}',
            message: require('../src/payments/payment-waiting-queue').FULL_MESSAGE };
        const before = structuredClone(row), service = require('../src/payments/orbitcard-manual-service')({
            store: { listManualOrders: async () => [row], getManualOrder: async () => row }, activeJobs: new Set(), audit() {}, cardService: {}, waitingQueue: {} });
        for (const view of [...await service.list(), await service.get(row.request_id)]) {
            assertClosed(view, manual_result); assert.equal(view.state, 'funding_pending'); assert.equal(view.order.status, 'processing');
            assert.equal(view.error_code, undefined); assert.equal(view.retry_after_seconds, undefined); assert.equal(view.captcha, null);
        }
        assert.deepEqual(row, before);
    }
});

test('manual control read shows a closed business even while original settlement remains unresolved', async () => {
    for (const kind of ['task', 'admin']) for (const manual_result of ['success', 'failed']) {
        const row = kind === 'task' ? task({ manual_result }) : { request_id: 'old-admin', client_order_no: 'manual-old',
            state: 'funding_pending', manual_result, manual_result_at: closedAt };
        const id = row.job_key || row.request_id;
        const service = require('../src/payments/order-manual-control')({ runQuery: async sql =>
            sql.includes(kind === 'task' ? 'FROM task_logs WHERE job_key' : 'FROM orbitcard_admin_orders WHERE request_id') ? [row] : [],
            runExecute: async () => assert.fail('Legacy closure must not need a write') });
        const view = await service.getOrderManualControl({ kind, id });
        assertClosed(view, manual_result); assert.equal(view.state, 'funding_pending'); assert.equal(view.settlement.allowed, false);
    }
});

test('customer status distinguishes closed business from the unchanged original platform snapshot', () => {
    const safeOrder = require('../src/db/mysql-store').safeOrder;
    const server = load('src/server.js', { './config/load-env': () => false,
        './db/mysql-store': { safeOrder }, './logging/runtime-log': { push() {}, initialize() {} } });
    for (const manual_result of ['success', 'failed']) {
        const row = task({ manual_result }), before = structuredClone(row), view = server.publicOrder(row);
        assertClosed(view, manual_result); assert.equal(view.status, manual_result);
        assert.deepEqual(view.order, safeOrder(row.gpt_api_raw)); assert.deepEqual(row, before);
    }
});

test('a manually failed business stays closed while its unreleased CDK remains reserved for support', async () => {
    for (const origin of ['task', 'admin']) {
        const row = { id: 1, cdk_code: 'CODE-TEST', plan_type: 'plus', used_at: closedAt,
            task_status: origin === 'task' ? 'manual' : null, orbitcard_state: origin === 'task' ? 'funding_pending' : null,
            task_manual_result: origin === 'task' ? 'failed' : null, admin_manual_result: origin === 'admin' ? 'failed' : null,
            manual_state: origin === 'admin' ? 'funding_pending' : null };
        const store = load('src/db/mysql-store.js', { './mysql-core': { runQuery: async () => [row] } });
        for (const item of [...await store.listCdks(), ...await store.listCdksExportPage()]) {
            assert.equal(item.order_business_status, 'closed'); assert.equal(item.order_business_result, 'failed');
            assert.equal(item.status, 'processing'); assert.equal(item.orbitcard_pending_confirmation, false);
            assert.equal(item.orbitcard_support_locked, true);
        }
        assert.deepEqual(await store.getCdkRedemptionStatus(row.cdk_code), { status: 'processing', redeemed: false });
    }
});

test('released historical closure does not override the current administrator CDK owner', async () => {
    const row = { id: 1, cdk_code: 'CODE-TEST', plan_type: 'plus', used_at: 'new-owner-reservation',
        task_status: 'manual', orbitcard_state: 'funding_pending', task_manual_result: 'failed',
        task_local_released_at: closedAt, admin_manual_result: null, manual_state: 'pending' };
    const store = load('src/db/mysql-store.js', { './mysql-core': { runQuery: async sql => {
        assert.match(sql, /t\.manual_result AS task_manual_result/);
        assert.match(sql, /m\.manual_local_released_at IS NULL/);
        return [row];
    } } });
    const [open] = await store.listCdks();
    assert.equal(open.status, 'processing'); assert.equal(open.order_business_status, null);
    assert.equal(open.order_business_result, null); assert.equal(open.orbitcard_support_locked, false);
    Object.assign(row, { admin_manual_result: 'failed', manual_state: 'funding_pending' });
    const [closed] = await store.listCdks();
    assert.equal(closed.status, 'processing'); assert.equal(closed.order_business_status, 'closed');
    assert.equal(closed.order_business_result, 'failed'); assert.equal(closed.orbitcard_support_locked, true);
    Object.assign(row, { admin_manual_result: 'success', manual_redeemed_at: 'new-owner-delivered' });
    const [redeemed] = await store.listCdks();
    assert.equal(redeemed.status, 'redeemed'); assert.equal(redeemed.order_business_result, 'success');
    assert.equal(redeemed.orbitcard_support_locked, false);
});
