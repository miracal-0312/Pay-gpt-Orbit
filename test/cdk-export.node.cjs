'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');

function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name);
    const module = { exports: {} }, real = createRequire(filename);
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports, path.dirname(filename));
    return module.exports;
}

test('CDK queries filter in SQL and export advances past the list cap by ID', async () => {
    const calls = [];
    const core = { runQuery: async (sql, params) => { calls.push({ sql, params }); return [{ id: 50, cdk_code: 'KC-TEST', plan_type: 'pro200', task_status: null, orbitcard_state: null }]; } };
    const store = load('mysql-store.js', {
        './mysql-core': core,
        './orbitcard-card-store': () => ({}),
        './orbitcard-cdk-store': () => ({})
    });
    const list = await store.listCdks('pro200');
    assert.equal(list[0].plan_type, 'pro200');
    assert.match(calls[0].sql, /c\.plan_type = \?\s+ORDER BY c\.id DESC LIMIT 2000/);
    assert.deepEqual(calls[0].params, ['pro200']);
    const page = await store.listCdksExportPage('pro200', 51);
    assert.equal(page[0].id, 50);
    assert.match(calls[1].sql, /c\.plan_type = \? AND c\.id < \? ORDER BY c\.id DESC LIMIT 500/);
    assert.deepEqual(calls[1].params, ['pro200', 51]);
});

test('CDK is redeemed only after confirmed success; export marks exact IDs in one transaction', async () => {
    const queries = [], writes = [];
    let taskState = 'pending', missing = false;
    const core = {
        runQuery: async (sql, params) => {
            queries.push([sql, params]);
            if (sql.startsWith('SELECT id FROM cdk_codes')) return missing ? [] : params.map(id => ({ id }));
            if (sql.startsWith('SELECT * FROM cdk_codes') && sql.includes('FOR UPDATE')) {
                return [{ cdk_code: 'KC-TEST', shipped_at: '2026-01-01 00:00:00', used_at: null }];
            }
            return [{ id: 7, cdk_code: 'KC-TEST', plan_type: 'plus', used_at: 'reserved',
                task_status: taskState === 'success' ? 'success' : 'running', orbitcard_state: taskState }];
        },
        runExecute: async (sql, params) => { writes.push([sql, params]); return { affectedRows: params.length }; },
        withTransaction: async callback => callback({ testConnection: true })
    };
    const store = load('mysql-store.js', {
        './mysql-core': core,
        './orbitcard-card-store': () => ({}),
        './orbitcard-cdk-store': () => ({})
    });
    assert.equal((await store.listCdks())[0].status, 'processing');
    taskState = 'success';
    assert.equal((await store.listCdks())[0].status, 'redeemed');
    await store.markCdksShipped([7, 8]);
    assert.match(queries.at(-1)[0], /SELECT id FROM cdk_codes.*FOR UPDATE/);
    assert.match(writes[0][0], /shipped_at = COALESCE\(shipped_at, CURRENT_TIMESTAMP\)/);
    assert.deepEqual(writes[0][1], [7, 8]);
    await assert.rejects(store.markCdksShipped([7, 7]), /ID/);
    missing = true;
    await assert.rejects(store.markCdksShipped([9]), /状态发生变化/);
    await assert.rejects(store.deleteCdk('KC-TEST'), /已出库/);
    assert.equal(writes.length, 1);
});

test('admin CSV export requires both tokens, filters plans and includes rows beyond 2000', async t => {
    const originalSecret = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 'c'.repeat(32);
    t.after(() => { if (originalSecret === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET = originalSecret; });
    const rows = Array.from({ length: 2101 }, (_, i) => ({ id: 2202 - i, code: `KC-PLUS-${i}`, plan_type: 'plus',
        plan_label: 'ChatGPT Plus', status: 'unused', shipped: false, created_at: new Date('2026-01-01T00:00:00Z') }));
    rows.push({ id: 1, code: '=HYPERLINK("bad")', plan_type: 'pro100', plan_label: 'ChatGPT Pro 100', status: 'redeemed',
        shipped: false, created_at: new Date('2026-01-01T00:00:00Z') });
    const requests = [], shippedBatches = [];
    const store = {
        ensureReady: async () => {},
        getAdminPaths: async () => ({ loginPath: 'admin-login', panelPath: 'admin' }),
        getAdminAuthConfig: async () => ({ passwordVersion: 1, secondaryPasswordVersion: 1 }),
        getMaxConcurrentActivations: async () => 1,
        listCdks: async plan => rows.filter(row => !plan || row.plan_type === plan).slice(0, 2000),
        listCdksExportPage: async (plan, beforeId) => {
            requests.push([plan, beforeId]);
            return rows.filter(row => (!plan || row.plan_type === plan) && (beforeId === null || row.id < beforeId)).slice(0, 500);
        },
        markCdksShipped: async ids => {
            shippedBatches.push([...ids]);
            for (const row of rows.filter(row => ids.includes(row.id))) row.shipped = true;
        }
    };
    const { app } = load('server.js', { './mysql-store': store, './runtime-log': { push() {}, initialize() {} } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = require('../admin-auth');
    const bearer = auth.issueAdminToken(1, 'admin@example.test').token;
    const secondary = auth.issueSecondaryToken(1, '127.0.0.1').token;
    const headers = { Authorization: `Bearer ${bearer}`, 'x-admin-secondary-token': secondary };
    assert.equal((await fetch(base + '/api/admin/cdks/export', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/api/admin/cdks/export', { method: 'POST', headers: { Authorization: headers.Authorization } })).status, 403);
    assert.equal((await fetch(base + '/api/admin/cdks/export?plan_type=other', { method: 'POST', headers })).status, 400);
    assert.equal((await fetch(base + '/api/admin/cdks/export', { headers })).status, 404);
    assert.equal((await fetch(base + '/api/admin/cdks/KC-PLUS-0/ship', { method: 'POST', headers })).status, 404);
    assert.equal((await fetch(base + '/api/admin/cdks?plan_type=other', { headers })).status, 400);
    const list = await (await fetch(base + '/api/admin/cdks?plan_type=plus', { headers })).json();
    assert.equal(list.length, 2000);
    assert.ok(list.every(row => row.plan_type === 'plus'));
    assert.equal(shippedBatches.length, 0);
    const exported = await fetch(base + '/api/admin/cdks/export?plan_type=plus', { method: 'POST', headers });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /\.csv"$/);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await exported.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const csv = bytes.toString('utf8');
    assert.ok(csv.startsWith('\uFEFF"卡密","套餐","状态","出库","创建时间"\r\n'));
    assert.equal(csv.trim().split('\r\n').length, 2102);
    assert.ok(csv.includes('KC-PLUS-2100'));
    assert.ok(!csv.includes('HYPERLINK'));
    assert.ok(csv.includes('"已出库"'));
    assert.equal(shippedBatches.length, 1);
    assert.equal(shippedBatches[0].length, 2101);
    assert.ok(rows.filter(row => row.plan_type === 'plus').every(row => row.shipped));
    assert.equal(rows.at(-1).shipped, false);
    assert.deepEqual(requests.map(([plan]) => plan), Array(5).fill('plus'));
    const pro = await (await fetch(base + '/api/admin/cdks/export?plan_type=pro100', { method: 'POST', headers })).text();
    assert.match(pro, /"'=HYPERLINK\(""bad""\)"/);
    assert.ok(pro.includes('"已核销"'));
    assert.equal(rows.at(-1).shipped, true);
    assert.equal(pro.trim().split('\r\n').length, 2);
});

test('CDK catalog and generation accept only live Plus and Pro plans', async t => {
    const oldSecret = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 'd'.repeat(32);
    t.after(() => { if (oldSecret === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET = oldSecret; });
    const orbitcard = require('../orbitcard-client');
    const oldFetchPlans = orbitcard.fetchPlans;
    orbitcard.fetchPlans = async () => ({ success: true, plans: [
        { type: 'gpt-go', name: 'Go' }, { type: 'gpt-plus', name: 'Plus' },
        { type: 'gpt-pro-5x', name: 'Pro 100' }, { type: 'gpt-credits-250', name: 'Credits' }
    ] });
    t.after(() => { orbitcard.fetchPlans = oldFetchPlans; });
    const inserted = [];
    const store = {
        ensureReady: async () => {},
        getAdminPaths: async () => ({ loginPath: 'admin-login', panelPath: 'admin' }),
        getAdminAuthConfig: async () => ({ passwordVersion: 1, secondaryPasswordVersion: 1 }),
        getMaxConcurrentActivations: async () => 1,
        getGptApiConfig: async () => ({ base_url: 'https://orbitcard.cc', api_key: 'test' }),
        insertCdks: async (codes, options) => { inserted.push({ codes, options }); return { insertedCount: codes.length }; }
    };
    const { app } = load('server.js', { './mysql-store': store, './runtime-log': { push() {}, initialize() {} } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = require('../admin-auth');
    const headers = { Authorization: `Bearer ${auth.issueAdminToken(1, 'admin@example.test').token}`,
        'x-admin-secondary-token': auth.issueSecondaryToken(1, '127.0.0.1').token,
        'Content-Type': 'application/json' };
    const catalog = await (await fetch(base + '/api/admin/cdks/plans', { headers })).json();
    assert.deepEqual(catalog.plans.map(plan => plan.type), ['plus', 'pro100']);
    const rejected = await fetch(base + '/api/admin/cdks/generate', { method: 'POST', headers,
        body: JSON.stringify({ count: 1, plan_type: 'gpt-go' }) });
    assert.notEqual(rejected.status, 200);
    assert.equal(inserted.length, 0);
    const accepted = await (await fetch(base + '/api/admin/cdks/generate', { method: 'POST', headers,
        body: JSON.stringify({ count: 1, plan_type: 'pro100' }) })).json();
    assert.equal(accepted.success, true);
    assert.deepEqual(inserted[0].options, { type: '自助', plan_type: 'pro100' });
    assert.match(inserted[0].codes[0], /^YZW-[A-Z2-9]{12}-PRO100$/);
});
