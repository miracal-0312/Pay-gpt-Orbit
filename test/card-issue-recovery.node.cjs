'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const fixture = require('./helpers/card-db.cjs');
const { PaymentStoppedError } = require('../payment-automation');

function load(name, mocks) {
    const filename = path.resolve(__dirname, '..', name), real = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => mocks[id] || real(id), module, module.exports);
    return module.exports;
}
const cfg = { enabled: true, base_url: 'https://orbitcard.test', api_key: 'issue-recovery-test' };

async function setup({ state = 'pending', orderNo = 'OPEN-ORIGINAL', response, attach = true } = {}) {
    let clock = Date.now();
    const f = fixture({ now: () => clock }), task = await f.claim(), calls = [];
    const methods = f.store.cardMethods(f.base);
    const body = { product_code: 'p1', amount: '20.00', quantity: 1 };
    await methods.createIssue({ issue_key: 'original-key', job_key: task.jobKey, plan_type: 'plus', product_code: 'p1',
        amount: '20.00', credential_hash: crypto.createHash('sha256').update(cfg.api_key).digest('hex'), request_body: JSON.stringify(body) });
    if (attach) await methods.attachIssue(task.jobKey, 'original-key');
    await methods.updateIssue('original-key', { state, order_no: orderNo });
    Object.assign(f.db.tasks[0], { status: 'manual', orbitcard_state: 'card_pending' });
    const api = { request: async (config, operation, requestBody, key) => {
        calls.push({ operation, body: structuredClone(requestBody), key });
        if (operation === 'createCard') return response ? response(f) : {
            success: true, status: 200, data: { order_no: 'OPEN-ORIGINAL', card_id: 42, product_code: 'p1', status: 'success', completed: true }
        };
        if (operation === 'cardDetail') return { success: true, data: {
            card_id: 42, status: 'ACTIVE', product_code: 'p1', balance: '20.00', currency: 'USD'
        } };
        if (operation === 'cardTransaction') return { success: true, data: { list: [], total: 0 } };
        assert.fail(`Unexpected remote operation: ${operation}`);
    } };
    const cards = load('orbitcard-cards-client.js', { './orbitcard-client': api });
    const service = load('orbitcard-card-service.js', { './orbitcard-client': api, './orbitcard-cards-client': cards })(
        { store: f.store, audit() {}, now: () => clock, sleep: async () => {} });
    return { ...f, task, calls, service, methods, body, advance(ms) { clock += ms; } };
}

test('card_pending confirms the acknowledged original issue without authorizing another payment', async () => {
    for (const ownerState of ['active', 'redeemed', 'disabled']) {
        const f = await setup();
        if (ownerState === 'redeemed') f.db.cdks[0].manual_redeemed_at = 'already-redeemed';
        if (ownerState === 'disabled') f.db.cdks[0].is_active = 0;
        await assert.rejects(f.store.assertPaymentAllowed(f.task.jobKey), PaymentStoppedError);
        await f.service.recover(cfg);
        assert.equal(f.db.issues[0].state, 'ready');
        assert.equal(f.db.issues[0].order_no, 'OPEN-ORIGINAL');
        assert.equal(f.db.issues[0].card_id, 42);
        assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending', 'task settlement belongs to order recovery');
        assert.equal(f.db.cards[0].active_job, null);
        assert.deepEqual(f.calls.map(call => call.operation), ['createCard', 'cardDetail', 'cardTransaction']);
        assert.deepEqual(f.calls[0], { operation: 'createCard', body: f.body, key: 'original-key' });
        await f.service.recover(cfg);
        assert.equal(f.calls.length, 3, 'terminal issues must never be replayed');
    }
});

test('confirmed failed or refunded original issues become terminal without opening a replacement', async () => {
    for (const status of ['failed', 'refunded']) {
        const f = await setup({ response: () => ({ success: true, status: 200,
            data: { order_no: 'OPEN-ORIGINAL', status, completed: true } }) });
        await f.service.recover(cfg);
        assert.equal(f.db.issues[0].state, 'failed');
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].key, 'original-key');
        assert.equal(f.db.cards.length, 0);
    }
});

test('issue confirmation and order recovery release the unsubmitted task while preserving manual redemption', async () => {
    for (const redeemed of [false, true]) {
        const f = await setup();
        if (redeemed) f.db.cdks[0].manual_redeemed_at = 'already-redeemed';
        const recovery = require('../order-recovery')({ store: f.store, activeJobs: new Set(), audit() {},
            query: { refresh: async () => assert.fail('an unsubmitted issue must not query or submit membership') } });
        await recovery.refreshTask(f.db.tasks[0]);
        assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending');
        await f.service.recover(cfg);
        const released = await recovery.refreshTask(f.db.tasks[0]);
        assert.equal(released.applied, true);
        assert.equal(f.db.tasks[0].orbitcard_state, redeemed ? 'support_locked' : 'rejected');
        assert.equal(Boolean(f.db.cdks[0].used_at), redeemed);
        assert.equal(f.db.cards[0].active_job, null);
        assert.equal(f.calls.filter(call => call.operation === 'createCard').length, 1);
        await assert.rejects(f.store.assertPaymentAllowed(f.task.jobKey), PaymentStoppedError);
    }
});

test('unacknowledged handed-off issues remain untouched while an unsent prepared intent closes safely', async () => {
    for (const state of ['prepared', 'submitting', 'pending', 'unknown']) {
        const f = await setup({ state, orderNo: null });
        await f.service.recover(cfg);
        assert.equal(f.calls.length, 0);
        assert.equal(f.db.issues[0].state, state === 'prepared' ? 'failed' : state);
        assert.equal(f.db.cards.length, 0);
    }
});

test('a crash before attaching the saved issue cannot release its task until the original intent is reconciled', async () => {
    const f = await setup({ state: 'prepared', orderNo: null, attach: false });
    Object.assign(f.db.tasks[0], { status: 'running', orbitcard_state: 'preparing' });
    assert.equal(f.db.tasks[0].orbitcard_issue_key, undefined);
    assert.equal((await f.store.getCardIssueForTask(f.task.jobKey)).issue_key, 'original-key');
    const premature = await f.store.settleOrbitcardTask(f.task.jobKey, {
        status: 'failed', orbitcardState: 'rejected', expectedState: 'preparing', expectedClientOrderNo: f.task.orbitcardClientOrderNo
    });
    assert.equal(premature.applied, false);
    const recovery = require('../order-recovery')({ store: f.store, activeJobs: new Set(), audit() {},
        query: { refresh: async () => assert.fail('an unsubmitted task must not query membership') } });
    await recovery.refreshTask(f.db.tasks[0]);
    assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending');
    assert.ok(f.db.cdks[0].used_at);
    await f.service.recover(cfg);
    assert.equal(f.db.issues[0].state, 'failed');
    assert.equal(f.calls.length, 0, 'a prepared original intent was never sent');
    assert.equal((await recovery.refreshTask(f.db.tasks[0])).applied, true);
    assert.equal(f.db.tasks[0].orbitcard_state, 'rejected');
    assert.equal(f.db.cdks[0].used_at, null);
});

test('multiple issues linked by task identity or attached key cannot be mistaken for one safe original issue', async () => {
    const f = await setup();
    f.db.issues.push({ ...f.db.issues[0], issue_key: 'second-key' });
    await assert.rejects(f.store.getCardIssueForTask(f.task.jobKey), /多笔开卡申请/);
    const recovery = require('../order-recovery')({ store: f.store, activeJobs: new Set(), audit() {} });
    await assert.rejects(recovery.refreshTask(f.db.tasks[0]), /多笔开卡申请/);
    assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending');
    assert.ok(f.db.cdks[0].used_at);
});

test('issue reconciliation never changes the original credential, request body or order identity', async () => {
    for (const mismatch of ['credential', 'body', 'order']) {
        const f = await setup({ response: () => ({ success: true, status: 200,
            data: { order_no: 'OTHER-ORDER', card_id: 42, status: 'success' } }) });
        if (mismatch === 'credential') f.db.issues[0].credential_hash = 'wrong-account';
        if (mismatch === 'body') f.db.issues[0].request_body = JSON.stringify({ ...f.body, amount: '30.00' });
        await f.service.recover(cfg);
        assert.equal(f.db.issues[0].state, 'unknown');
        assert.equal(f.db.issues[0].order_no, 'OPEN-ORIGINAL');
        assert.equal(f.calls.length, mismatch === 'order' ? 1 : 0);
        assert.equal(f.db.cards.length, 0);
    }
});

test('issue recovery respects retry intervals and retains the acknowledged identity across transient errors', async () => {
    const f = await setup({ response: () => ({ success: false, status: 503, retryAfterMs: 120000, data: null }) });
    await f.service.recover(cfg);
    assert.equal(f.db.issues[0].state, 'unknown');
    assert.equal(f.db.issues[0].order_no, 'OPEN-ORIGINAL');
    f.advance(119999);
    await f.service.recover(cfg);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    await f.service.recover(cfg);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1], f.calls[0]);
});

test('an ended owner cannot fulfill a late issue response', async () => {
    const f = await setup({ response: current => {
        current.db.tasks[0].orbitcard_state = 'rejected';
        return { success: true, status: 200, data: { order_no: 'OPEN-ORIGINAL', card_id: 42, status: 'success' } };
    } });
    await f.service.recover(cfg);
    assert.equal(f.calls.length, 1);
    assert.notEqual(f.db.issues[0].state, 'ready');
    assert.equal(f.db.cards.length, 0);
    await assert.rejects(f.store.assertIssueReconciliationAllowed(f.task.jobKey), PaymentStoppedError);
});
