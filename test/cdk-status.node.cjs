'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const createStatusService = require('../cdk-status-service');

function fixture() {
    const env = { CDK_REDEMPTION_WEBHOOK_URL: 'https://shop.example/api/v1/card-secrets/redemption-callback',
        CDK_REDEMPTION_SOURCE: 'pay-gpt-orbit', CDK_REDEMPTION_WEBHOOK_SECRET: 's'.repeat(32) };
    const db = { code: { id: 7, cdk_code: 'CODE-SUPPORT', is_active: 1, used_at: 'reserved' },
        task: { job_key: 'job-2', orbitcard_retry_root_job_key: 'job-1', status: 'failed', orbitcard_state: 'support_locked' },
        order: null, events: [], audits: [] };
    let locked = false, releases = 0, failEnqueue = false, failAudit = false;
    const runQuery = async (sql, params, options) => {
        assert.ok(options?.connection);
        if (sql.includes('FROM cdk_codes')) return db.code && params[0].toLowerCase() === db.code.cdk_code.toLowerCase() ? [structuredClone(db.code)] : [];
        if (sql.includes('FROM task_logs')) return db.task ? [structuredClone(db.task)] : [];
        if (sql.includes('FROM orbitcard_admin_orders')) return db.order ? [structuredClone(db.order)] : [];
        throw Error(`Unexpected query: ${sql}`);
    };
    const runExecute = async (sql, p, options) => {
        assert.ok(options?.connection);
        if (sql.startsWith('UPDATE cdk_codes SET manual_redeemed_at')) {
            Object.assign(db.code, { manual_redeemed_at: '2026-10-26T00:00:00Z', manual_redeemed_by: p[0], manual_redemption_reason: p[1] });
            db.code.used_at ||= 'reserved';
        } else if (sql.startsWith('UPDATE cdk_codes SET shipped_at')) {
            db.code.shipped_at = sql.includes('= NULL') ? null : 'shipped-now';
        } else if (sql.startsWith('INSERT INTO admin_login_logs')) {
            if (failAudit) throw Error('audit unavailable');
            db.audits.push({ event: p[0], adminEmail: p[1], detail: p[2] });
        } else if (sql.startsWith('INSERT INTO cdk_redemption_outbox')) {
            if (failEnqueue) throw Error('outbox unavailable');
            if (!db.events.some(event => event.id === p[0])) db.events.push({ id: p[0], source: p[1], url: p[2], payload: JSON.parse(p[3]) });
        } else throw Error(`Unexpected write: ${sql}`);
        return { affectedRows: 1 };
    };
    const withTransaction = async fn => {
        const snapshot = structuredClone(db);
        try { return await fn({ transaction: true }); }
        catch (error) { Object.assign(db, snapshot); throw error; }
    };
    const acquirePaymentLock = async key => {
        assert.equal(key, 'cdk:code-support');
        if (locked) return null;
        locked = true;
        return { assertOwned: async () => { assert.equal(locked, true); }, release: async () => { locked = false; releases++; } };
    };
    const webhook = require('../cdk-redemption-webhook')({ runQuery, runExecute, env });
    const update = createStatusService({ runQuery, runExecute, withTransaction, acquirePaymentLock, env, enqueueRedemption: webhook.enqueue });
    const input = { cdk: 'code-support', status: 'redeemed', reason: ' 已在售后完成补发 ', adminEmail: 'admin@example.test' };
    return { db, env, update, input, setLocked(value) { locked = value; }, failEnqueue(value) { failEnqueue = value; },
        failAudit(value) { failAudit = value; }, get releases() { return releases; } };
}

test('support redemption atomically saves audit details and a canonical shop receipt without changing payment history', async () => {
    const f = fixture(), originalTask = structuredClone(f.db.task);
    assert.deepEqual(await f.update(f.input), { status: 'redeemed', shipped: false, changed: true, redemptionChanged: true });
    assert.equal(f.db.code.manual_redeemed_by, f.input.adminEmail);
    assert.equal(f.db.code.manual_redemption_reason, f.input.reason.trim());
    assert.equal(f.db.code.used_at, 'reserved');
    assert.deepEqual(f.db.task, originalTask);
    assert.equal(f.db.events.length, 1);
    const payload = f.db.events[0].payload;
    assert.equal(payload.cdk, 'CODE-SUPPORT');
    assert.equal(payload.order_id, 'job-1');
    assert.equal(payload.event_type, 'cdk.redeemed');
    assert.equal(JSON.stringify(payload).includes(f.input.adminEmail), false);
    assert.equal(JSON.stringify(payload).includes(f.input.reason.trim()), false);
    const audit = structuredClone(f.db.code);
    assert.equal((await f.update({ ...f.input, reason: 'duplicate' })).changed, false);
    assert.deepEqual(f.db.code, audit);
    assert.equal(f.db.events.length, 1);
    assert.equal(f.releases, 2);
});

test('outbox failure rolls back the manual status and retry records exactly one receipt', async () => {
    const f = fixture(); f.failEnqueue(true);
    await assert.rejects(f.update(f.input), /outbox unavailable/);
    assert.equal(f.db.code.manual_redeemed_at, undefined);
    assert.equal(f.db.events.length, 0);
    assert.equal(f.releases, 1);
    f.failEnqueue(false);
    await f.update(f.input);
    assert.equal(f.db.events.length, 1);
});

test('manual fulfillment and historical occupied codes can be redeemed; existing success is idempotent', async () => {
    for (const kind of ['manual', 'legacy', 'occupied-only', 'success']) {
        const f = fixture();
        if (kind === 'manual') { f.db.task = null; f.db.order = { state: 'manual', client_order_no: 'manual-order-1' }; }
        if (kind === 'legacy') f.db.task = { job_key: 'legacy-1', status: 'manual' };
        if (kind === 'occupied-only') f.db.task = null;
        if (kind === 'success') f.db.task = { status: 'success', orbitcard_state: 'success' };
        const result = await f.update(f.input);
        assert.equal(result.changed, kind !== 'success');
        if (kind === 'manual') assert.equal(f.db.events[0].payload.order_id, 'manual-order-1');
        if (kind === 'occupied-only') assert.equal(f.db.events[0].payload.order_id, 'support-7');
        if (kind === 'success') assert.equal(f.db.events.length, 0);
    }
});

test('invalid, disabled, busy and unconfigured updates do not mutate a CDK', async () => {
    for (const kind of ['invalid-code', 'invalid-status', 'empty-reason', 'long-reason', 'invalid-shipped', 'no-change-request', 'invalid-expected', 'disabled', 'missing', 'busy', 'no-webhook', 'bad-webhook', 'preparing']) {
        const f = fixture(), input = { ...f.input };
        if (kind === 'invalid-code') input.cdk = '../bad';
        if (kind === 'invalid-status') input.status = 'unused';
        if (kind === 'empty-reason') input.reason = ' ';
        if (kind === 'long-reason') input.reason = 'a'.repeat(256);
        if (kind === 'invalid-shipped') input.shipped = 'false';
        if (kind === 'no-change-request') delete input.status;
        if (kind === 'invalid-expected') input.expectedShipped = 'false';
        if (kind === 'disabled') f.db.code.is_active = 0;
        if (kind === 'missing') f.db.code = null;
        if (kind === 'busy') f.setLocked(true);
        if (kind === 'no-webhook') f.env.CDK_REDEMPTION_WEBHOOK_URL = '';
        if (kind === 'bad-webhook') f.env.CDK_REDEMPTION_WEBHOOK_SECRET = 'short';
        if (kind === 'preparing') f.db.order = { state: 'preparing' };
        const before = structuredClone(f.db);
        await assert.rejects(f.update(input), undefined, kind);
        assert.deepEqual(f.db, before, kind);
    }
});

test('unused inventory can be redeemed and shipped atomically with operator audit and one receipt', async () => {
    const f = fixture(); f.db.code.used_at = null; f.db.task = null;
    const result = await f.update({ ...f.input, shipped: true, expectedStatus: 'unused', expectedShipped: false });
    assert.deepEqual(result, { status: 'redeemed', shipped: true, changed: true, redemptionChanged: true });
    assert.equal(f.db.events.length, 1);
    assert.equal(f.db.code.shipped_at, 'shipped-now');
    assert.equal(f.db.audits.length, 1);
    assert.equal(f.db.audits[0].adminEmail, f.input.adminEmail);
    assert.match(f.db.audits[0].detail, /unused → redeemed/);
    assert.ok(f.db.audits[0].detail.includes(f.input.reason.trim()));
});

test('shipping can be edited both ways without webhook configuration or changing redemption records', async () => {
    for (const state of ['unused', 'processing', 'redeemed']) {
        const f = fixture(); f.env.CDK_REDEMPTION_WEBHOOK_URL = '';
        if (state === 'unused') { f.db.code.used_at = null; f.db.task = null; }
        if (state === 'redeemed') f.db.code.manual_redeemed_at = 'original-redemption';
        const before = structuredClone(f.db);
        const input = { ...f.input, status: undefined, shipped: true, expectedStatus: state, expectedShipped: false };
        assert.deepEqual(await f.update(input), { status: state, shipped: true, changed: true, redemptionChanged: false });
        assert.equal(f.db.code.manual_redeemed_at, before.code.manual_redeemed_at);
        assert.deepEqual(f.db.task, before.task);
        assert.equal(f.db.events.length, 0);
        const same = await f.update({ ...input, expectedShipped: true });
        assert.equal(same.changed, false);
        assert.equal(f.db.audits.length, 1);
        await f.update({ ...input, shipped: false, expectedShipped: true });
        assert.equal(f.db.code.shipped_at, null);
        assert.equal(f.db.audits.length, 2);
    }
});

test('stale edits and audit failures cannot partially change shipping, redemption or notifications', async () => {
    const f = fixture();
    for (const expected of [{ expectedStatus: 'unused' }, { expectedShipped: true }]) {
        await assert.rejects(f.update({ ...f.input, shipped: true, ...expected }), /状态已发生变化/);
        assert.equal(f.db.audits.length, 0);
        assert.equal(f.db.events.length, 0);
    }
    f.failAudit(true);
    const before = structuredClone(f.db);
    await assert.rejects(f.update({ ...f.input, shipped: true }), /audit unavailable/);
    assert.deepEqual(f.db, before);
});

test('competing updates share the payment lock and cannot replace the original audit or receipt', async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.update(f.input), f.update({ ...f.input, reason: 'second' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal(f.db.events.length, 1);
});

test('late self-service failure settles the original payment card without releasing or retrying a manually redeemed CDK', async () => {
    const f = require('./helpers/card-db.cjs')(), task = await f.claim();
    await f.addCard(42);
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    await f.settle(task, 'submitting');
    f.db.cdks[0].manual_redeemed_at = '2026-10-26';
    const result = await f.store.recordOrbitcardPaymentFailure(task.jobKey, {
        clientOrderNo: task.orbitcardClientOrderNo, cardId: 42, orderId: 'SUB-1',
        raw: JSON.stringify({ task_no: 'SUB-1', status: 'failed', subscription_succeeded: false })
    });
    assert.equal(result.applied, true);
    assert.equal(result.nextTask, undefined);
    assert.equal(f.db.tasks.length, 1);
    assert.ok(f.db.cdks[0].used_at);
    assert.equal(f.db.cards[0].active_job, null);
    assert.equal(f.db.cards[0].successful_plus, 0);
});

test('late preparation release and previously queued payment retry cannot reopen a manually redeemed CDK', async () => {
    const f = require('./helpers/card-db.cjs')(), task = await f.claim();
    f.db.cdks[0].manual_redeemed_at = '2026-10-26';
    await f.settle(task, 'rejected');
    assert.ok(f.db.cdks[0].used_at);
    f.db.tasks[0].orbitcard_state = 'retry_waiting';
    assert.equal(await f.store.claimOrbitcardRetryTask(task.jobKey, task.orbitcardClientOrderNo), false);
    assert.equal(f.db.tasks[0].orbitcard_state, 'retry_waiting');
    assert.equal(await f.store.createOrbitcardTask({ cdk: f.db.cdks[0].cdk_code, planType: 'plus' }), null);
});

function load(name, mocks) {
    const filename = path.resolve(__dirname, '..', name), real = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports, path.dirname(filename));
    return module.exports;
}

test('list, export and public redemption lookup prioritize manual redemption over an original failed order', async () => {
    const code = { id: 7, cdk_code: 'CODE-SUPPORT', used_at: 'reserved', task_status: 'failed', orbitcard_state: 'support_locked',
        manual_redeemed_at: '2026-10-26', manual_redeemed_by: 'admin@example.test', manual_redemption_reason: '补发完成' };
    const store = load('mysql-store.js', { './mysql-core': { runQuery: async () => [code] },
        './orbitcard-card-store': () => ({}), './orbitcard-cdk-store': () => ({}) });
    for (const row of [(await store.listCdks())[0], (await store.listCdksExportPage())[0]]) {
        assert.equal(row.status, 'redeemed');
        assert.equal(row.orbitcard_support_locked, false);
        assert.equal(row.manual_redemption_reason, '补发完成');
    }
    assert.deepEqual(await store.getCdkRedemptionStatus('CODE-SUPPORT'), { status: 'redeemed', redeemed: true });
});

test('admin status endpoint requires both tokens and records the authenticated operator', async t => {
    const previous = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 'a'.repeat(32);
    t.after(() => { if (previous === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET = previous; });
    const f = fixture(), express = require('express'), app = express();
    app.use(express.json());
    const calls = [];
    const store = { getAdminAuthConfig: async () => ({ passwordVersion: 1, secondaryPasswordVersion: 1 }),
        updateCdkStatus: async input => { calls.push(input); return f.update(input); } };
    require('../admin-http')(app, { store, ensureStoreReady: async () => {}, getTotalActiveJobs: () => 0 });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const auth = require('../admin-auth'), url = `http://127.0.0.1:${server.address().port}/api/admin/cdks/CODE-SUPPORT/status`;
    const bearer = `Bearer ${auth.issueAdminToken(1, 'operator@example.test').token}`;
    const headers = { Authorization: bearer, 'x-admin-secondary-token': auth.issueSecondaryToken(1, '127.0.0.1').token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: bearer } })).status, 403);
    assert.equal(calls.length, 0);
    const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ status: 'redeemed', reason: '售后完成', adminEmail: 'spoofed' }) });
    assert.equal(result.status, 200);
    assert.match((await result.json()).message, /商城通知已入队/);
    assert.equal(f.db.code.manual_redeemed_by, 'operator@example.test');
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ status: 'unused', reason: 'invalid' }) })).status, 400);
    const shipping = await fetch(url, { method: 'POST', headers, body: JSON.stringify({
        shipped: true, expected_status: 'redeemed', expected_shipped: false, reason: '人工出库', adminEmail: 'spoofed'
    }) });
    assert.equal(shipping.status, 200);
    assert.equal((await shipping.json()).shipped, true);
    assert.equal(f.db.audits.at(-1).adminEmail, 'operator@example.test');
    assert.equal(f.db.events.length, 1, 'shipping must not enqueue another redemption receipt');
    const stale = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ shipped: false, expected_shipped: false, reason: 'stale' }) });
    assert.equal(stale.status, 409);
    assert.equal(f.db.code.shipped_at, 'shipped-now');
});
