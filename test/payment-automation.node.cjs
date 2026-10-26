'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const factory = require('../payment-automation');
const fixture = require('./helpers/card-db.cjs');

test('payment guards reject manual, terminal, missing and manually redeemed owners across process restarts', async () => {
    let task = { job_key: 'job-1', cdk_code: 'CODE-TEST', status: 'running', orbitcard_state: 'prepared' };
    let code = { cdk_code: 'CODE-TEST', is_active: 1 };
    let order = { request_id: 'r1', client_order_no: 'manual-r1', state: 'preparing', cdk_code: 'CODE-TEST' };
    const runQuery = async sql => sql.includes('FROM cdk_codes') ? code ? [code] : []
        : sql.includes('FROM task_logs') ? task ? [task] : [] : order ? [order] : [];
    const create = () => factory({ runQuery });
    await create().assertPaymentAllowed('job-1');
    assert.deepEqual((await create().paymentOwner('job-1')).keys, ['cdk:code-test']);
    for (const state of ['manual','support_locked','funding_pending','card_pending','success','failed','rejected','balance_blocked']) {
        task.orbitcard_state = state;
        await assert.rejects(create().assertPaymentAllowed('job-1'), factory.PaymentStoppedError);
    }
    task.orbitcard_state = 'prepared'; task.status = 'manual';
    await assert.rejects(create().assertPaymentAllowed('job-1'), factory.PaymentStoppedError);
    task.status = 'running'; code.manual_redeemed_at = '2026-10-26';
    await assert.rejects(create().assertPaymentAllowed('job-1'), factory.PaymentStoppedError);
    delete code.manual_redeemed_at;
    await create().assertPaymentAllowed('manual-r1');
    for (const state of ['manual','support_locked','success','failed']) {
        order.state = state;
        await assert.rejects(create().assertPaymentAllowed('manual-r1'), factory.PaymentStoppedError);
    }
    task = null; order = null;
    await assert.rejects(create().assertPaymentAllowed('job-1'), factory.PaymentStoppedError);
    await assert.rejects(create().assertPaymentAllowed('manual-r1'), factory.PaymentStoppedError);
});

test('a pending original-order query cannot undo manual handoff or enable another payment', async () => {
    const f = fixture(), task = await f.claim(); await f.addCard();
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    await f.settle(task, 'submitting'); await f.settle(task, 'manual');
    const pending = await f.settle(task, 'pending');
    assert.equal(pending.status, 'manual');
    assert.equal(f.db.tasks[0].orbitcard_state, 'manual');
    await assert.rejects(f.store.assertPaymentAllowed(task.jobKey), factory.PaymentStoppedError);
    const failure = await f.store.recordOrbitcardPaymentFailure(task.jobKey, { clientOrderNo: task.orbitcardClientOrderNo,
        cardId: 42, orderId: 'SUB-1', raw: JSON.stringify({ task_no: 'SUB-1', status: 'failed', subscription_succeeded: false }) });
    assert.equal(failure.exhausted, true); assert.equal(failure.supportStopped, true);
    assert.equal(failure.nextTask, undefined); assert.equal(f.db.tasks.length, 1);
    assert.equal(f.db.tasks[0].orbitcard_state, 'support_locked');
    assert.equal(f.db.cards[0].active_job, null); assert.ok(f.db.cdks[0].used_at);
});

test('direct failure settlement after handoff retains CDK ownership while success can still settle the original payment', async () => {
    for (const state of ['failed', 'success']) {
        const f = fixture(), task = await f.claim(); await f.addCard();
        await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
        await f.settle(task, 'submitting'); await f.settle(task, 'manual'); await f.settle(task, state);
        assert.equal(f.db.tasks[0].orbitcard_state, state === 'failed' ? 'support_locked' : 'success');
        assert.ok(f.db.cdks[0].used_at);
        assert.equal(f.db.cards[0].active_job, null);
        assert.equal(f.db.cards[0].successful_plus, state === 'success' ? 1 : 0);
    }
});

test('payment worker exits a manual handoff without allocating cards or mutating its saved state', async () => {
    const f = fixture(), task = await f.claim();
    Object.assign(f.db.tasks[0], { status: 'manual', orbitcard_state: 'prepared' });
    const activeJobs = new Set([task.jobKey]), challenges = new Map([[task.jobKey, {}]]), calls = [];
    const core = require('../payment-service')({ store: f.store, cardService: { allocate: async () => assert.fail('must not allocate') },
        worker: { run: async () => assert.fail('must exit before entering payment') }, activeJobs, activeChallenges: challenges,
        audit() {}, broadcast() {}, log: (...args) => calls.push(args), notify: async () => {} });
    await core.run({ task: { ...task, apiConfig: {} }, cdk: 'CODE-1', planType: 'plus', session: {} });
    assert.equal(f.db.tasks[0].status, 'manual'); assert.ok(f.db.cdks[0].used_at);
    assert.equal(activeJobs.size, 0); assert.equal(challenges.size, 0);
    assert.equal(calls.at(-1)[2], 'payment_automation_stopped');
});

test('subscription guard runs immediately before the write and blocks handoff after card preparation', async () => {
    let writes = 0;
    const service = require('../orbitcard-subscription-service')({ request: async () => { writes++; } });
    await assert.rejects(service.submit({ paymentGuard: { assertAllowed: async () => { throw new factory.PaymentStoppedError('stopped'); } } }, {}), factory.PaymentStoppedError);
    assert.equal(writes, 0);
});
