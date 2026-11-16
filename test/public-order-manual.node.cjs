'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once, EventEmitter } = require('node:events');
const { attachTaskSockets } = require('../src/realtime/task-sockets');

function fixture() {
    let task = { job_key: 'original-job', cdk_code: 'CODE-TEST', orbitcard_client_order_no: 'original-order',
        orbitcard_state: 'funding_pending', status: 'manual', progress: 30, orbitcard_email: 'customer@example.test',
        orbitcard_plan_type: 'gpt-plus', message: 'PRIVATE-ADMIN-NOTE', manual_result_reason: 'PRIVATE-REASON',
        manual_result_by: 'private-admin@example.test', gpt_api_raw: JSON.stringify({ status: 'processing',
            client_order_no: 'original-order', subscription_succeeded: false }) };
    const refreshed = [];
    const store = { ensureReady: async () => {}, getAdminPaths: async () => ({ loginPath: 'admin-login', panelPath: 'admin' }),
        getOrbitcardTaskByCdk: async cdk => cdk === 'CODE-TEST' ? task : null,
        getTaskStatus: async () => task, safeOrder: require('../src/db/mysql-store').safeOrder };
    const filename = path.resolve(__dirname, '../src/server.js'), real = createRequire(filename), module = { exports: {} };
    const mocks = { './config/load-env': () => false, './db/mysql-store': store, './logging/runtime-log': { push() {}, initialize() {} },
        './payments/order-recovery': () => ({ refreshTask: async current => { refreshed.push(current.job_key); return { success: true, querySkipped: true }; } }) };
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports, path.dirname(filename));
    return { ...module.exports, store, refreshed, get task() { return task; }, setTask(value) { task = value; } };
}

test('manual delivery is customer business success while original funding facts and source task remain unchanged', () => {
    const f = fixture();
    for (const state of ['funding_pending', 'card_pending', 'manual']) for (const released of [null, '2026-11-17']) {
        const task = { ...f.task, orbitcard_state: state, manual_result: 'success', manual_local_released_at: released };
        const before = structuredClone(task), result = f.publicOrder(task);
        assert.equal(result.status, 'success'); assert.equal(result.progress, 100); assert.equal(result.cdk_state, 'redeemed');
        assert.equal(result.queued, false); assert.match(result.message, /人工售后完成交付/);
        assert.deepEqual(result.order, f.store.safeOrder(task.gpt_api_raw));
        assert.notEqual(result.order.status, 'success');
        assert.equal(result.target_email, 'customer@example.test'); assert.equal(result.plan_type, 'plus');
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|private-admin|平台.*成功/);
        assert.deepEqual(task, before);
    }
});

test('manual failure only exposes an available CDK after explicit release and never reverses a known redemption', () => {
    const f = fixture();
    for (const released of [null, '2026-11-17']) {
        const result = f.publicOrder({ ...f.task, manual_result: 'failed', manual_local_released_at: released });
        assert.equal(result.status, 'failed'); assert.equal(result.progress, 0);
        assert.equal(result.cdk_state, released ? 'available' : 'reserved');
        assert.match(result.message, /人工确认失败/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|private-admin/);
    }
    const redeemed = f.publicOrder({ ...f.task, manual_result: 'failed', manual_local_released_at: 'released', manual_redeemed_at: 'already-redeemed' });
    assert.equal(redeemed.status, 'failed'); assert.equal(redeemed.cdk_state, 'redeemed');
});

test('manual results suppress stale queue prompts while unmarked and legacy orders keep their previous mapping', () => {
    const f = fixture(), queueMessage = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';
    for (const manual_result of ['success', 'failed']) {
        const result = f.publicOrder({ ...f.task, manual_result, message: queueMessage });
        assert.equal(result.error_code, undefined); assert.equal(result.retry_after_seconds, undefined); assert.equal(result.queued, false);
    }
    const original = f.publicOrder({ ...f.task, message: queueMessage });
    assert.equal(original.status, 'manual'); assert.equal(original.progress, 30); assert.equal(original.cdk_state, 'reserved');
    assert.equal(original.message, queueMessage); assert.equal(original.error_code, 'PAYMENT_QUEUE_FULL');
    assert.equal(f.publicOrder({ ...f.task, orbitcard_state: 'retry_waiting' }).status, 'retry');
    const legacy = f.publicOrder({ ...f.task, manual_redeemed_at: 'legacy-redemption' });
    assert.equal(legacy.status, 'success'); assert.equal(legacy.progress, 100); assert.equal(legacy.cdk_state, 'redeemed');
    assert.equal(legacy.message, '卡密已由人工售后核销');
    assert.equal(f.publicOrder({ ...f.task, manual_result: 'unrecognized' }).status, 'manual');
});

test('an already polling customer receives a released manual result and the newest task takes precedence after a new order', async t => {
    const f = fixture(); Object.assign(f.task, { manual_result: 'success', manual_local_released_at: 'released' });
    const server = f.app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const query = async () => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cdk/orbitcard/status`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdk: 'CODE-TEST' }) });
        assert.equal(response.status, 200); return (await response.json()).data;
    };
    const delivered = await query();
    assert.equal(delivered.status, 'success'); assert.equal(delivered.cdk_state, 'redeemed'); assert.equal(delivered.jobKey, 'original-job');
    Object.assign(f.task, { manual_result: 'failed' });
    const failed = await query(); assert.equal(failed.status, 'failed'); assert.equal(failed.cdk_state, 'available');
    f.setTask({ ...f.task, job_key: 'newest-job', orbitcard_client_order_no: 'newest-order', status: 'running', orbitcard_state: 'preparing',
        manual_result: null, manual_local_released_at: null, message: '正在处理新订单', progress: 10 });
    const newest = await query(); assert.equal(newest.jobKey, 'newest-job'); assert.equal(newest.status, 'running');
    assert.equal(newest.client_order_no, 'newest-order'); assert.equal(newest.cdk_state, 'reserved');
    assert.deepEqual(f.refreshed, ['original-job', 'original-job', 'newest-job']);
});

test('WebSocket snapshots use the independent manual result even when getTaskStatus does not join CDK redemption', async t => {
    const f = fixture(); Object.assign(f.task, { manual_result: 'success', manual_local_released_at: 'released' });
    class Socket extends EventEmitter {
        readyState = 1; bufferedAmount = 0; sent = [];
        send(raw) { this.sent.push(JSON.parse(raw)); }
        ping() {}
        terminate() { this.readyState = 3; this.emit('close'); }
        close() { this.terminate(); }
    }
    const wss = new EventEmitter(), ws = new Socket();
    attachTaskSockets(wss, { store: f.store, publicOrder: f.publicOrder, clients: new Map(), verifyAdminToken: () => null });
    t.after(() => ws.terminate());
    wss.emit('connection', ws, { socket: { remoteAddress: 'test' } });
    ws.emit('message', JSON.stringify({ type: 'subscribe', jobKey: 'original-job', cdk: 'CODE-TEST' }));
    await new Promise(setImmediate);
    assert.equal(ws.sent[0].type, 'snapshot'); assert.equal(ws.sent[0].status, 'success');
    assert.equal(ws.sent[0].progress, 100); assert.equal(ws.sent[0].cdk_state, 'redeemed');
    assert.notEqual(ws.sent[0].order.status, 'success');
});
