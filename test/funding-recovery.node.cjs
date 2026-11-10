'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/card-db.cjs');
const createRecovery = require('../order-recovery');
const { FundingAwaitingError, CardPreparationError, FUNDING_POLL_MS } = require('../orbitcard-card-policy');
const { PaymentStoppedError } = require('../payment-automation');

async function setup({ waiting = true, taskState = 'funding_review', preparationState = 'prepared',
    fundingState = 'pending', orderNo = 'FUND-ORIGINAL' } = {}) {
    const f = fixture();
    await f.addCard();
    const task = await f.claim(), methods = f.store.cardMethods(f.base);
    await methods.reserveCard(42, task.jobKey, 'plus');
    await methods.createFunding({ funding_key: 'fund-original', job_key: task.jobKey, plan_type: 'plus',
        card_id: 42, credential_hash: 'original-key-hash', request_body: '{"card_id":42,"amount":"16.00"}',
        amount: '16.00', target_balance: '21.00000000' });
    await methods.updateFunding('fund-original', { state: fundingState, order_no: orderNo, retry_at: 0 });
    f.db.tasks[0].orbitcard_state = preparationState;
    if (waiting) await f.store.settleOrbitcardTask(task.jobKey, { status: taskState === 'funding_review' ? 'manual' : 'running', progress: 10,
        orbitcardState: taskState, expectedState: preparationState, expectedClientOrderNo: task.orbitcardClientOrderNo,
        message: '等待原补款' });
    const activeJobs = new Set(), events = [];
    const current = () => f.store.getTaskStatus(task.jobKey);
    function recovery(confirmFunding, storeOverrides = {}) {
        return createRecovery({ store: { ...f.store, ...storeOverrides }, activeJobs, now: f.now,
            audit: event => events.push(event), confirmFunding,
            query: { refresh: async () => { throw new Error('Unsubmitted funding must never query/create a subscription'); } } });
    }
    return { ...f, task, methods, activeJobs, events, current, recovery };
}

test('restart reconciliation releases confirmed funds and requires a fresh Session without submitting a subscription', async () => {
    const f = await setup();
    let checks = 0;
    const r = f.recovery(async (task, guard) => {
        checks++; await guard.assertOwned();
        assert.equal(task.status, 'manual'); assert.equal(task.orbitcard_state, 'funding_review');
        assert.equal(task.orbitcard_client_order_no, f.task.orbitcardClientOrderNo);
        await f.methods.updateFunding('fund-original', { state: 'ready' });
        return 42;
    });
    assert.equal((await r.refreshTask(await f.current())).applied, true);
    assert.equal(checks, 1);
    assert.equal(f.db.tasks[0].status, 'retry');
    assert.equal(f.db.tasks[0].orbitcard_state, 'rejected');
    assert.match(f.db.tasks[0].message, /最新 Session/);
    assert.equal(f.db.cdks[0].used_at, null);
    assert.equal(f.db.cards[0].active_job, null);
    assert.equal(f.db.uses[0].state, 'released');
    assert.ok(!JSON.stringify(f.db).includes('accessToken'));
});

test('a detached funding worker becomes a review ticket before read-only reconciliation', async () => {
    const f = await setup({ taskState: 'funding_waiting' }); let checks = 0;
    f.db.fundings[0].retry_at = f.now() + 20000;
    const r = f.recovery(async task => {
        checks++; assert.equal(task.orbitcard_state, 'funding_review');
        await f.methods.updateFunding('fund-original', { state: 'ready' });
        return 42;
    });
    const converted = await r.refreshTask(await f.current());
    assert.equal(converted.applied, true); assert.equal(converted.waitMs, 20000);
    assert.equal(f.db.tasks[0].status, 'manual'); assert.equal(f.db.tasks[0].orbitcard_state, 'funding_review');
    assert.equal(checks, 0); assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    f.advance(19999); await r.refreshTask(await f.current()); assert.equal(checks, 0);
    f.advance(1); await r.refreshTask(await f.current()); assert.equal(checks, 1);
    assert.equal(f.db.tasks[0].orbitcard_state, 'rejected'); assert.equal(f.db.cdks[0].used_at, null);
});

test('interactive review refresh observes a minimum 5 second interval and longer Retry-After', async () => {
    const f = await setup(); let checks = 0;
    assert.equal(FUNDING_POLL_MS, 5000);
    const r = f.recovery(async () => { checks++; throw new FundingAwaitingError('still pending', checks === 1 ? FUNDING_POLL_MS : 90000); });
    assert.equal((await r.refreshTask(await f.current())).waitMs, FUNDING_POLL_MS);
    f.advance(FUNDING_POLL_MS - 1); assert.equal((await r.refreshTask(await f.current())).waitMs, 1); assert.equal(checks, 1);
    f.advance(1); assert.equal((await r.refreshTask(await f.current())).waitMs, 90000); assert.equal(checks, 2);
    f.advance(89999); await r.refreshTask(await f.current()); assert.equal(checks, 2);
    assert.equal(f.db.tasks[0].orbitcard_state, 'funding_review');
    assert.equal(f.db.tasks[0].status, 'manual');
    assert.equal(f.db.cards[0].active_job, f.task.jobKey); assert.ok(f.db.cdks[0].used_at);
});

test('a persisted funding retry_at prevents a restarted worker from querying too early', async () => {
    const f = await setup(); let checks = 0;
    f.db.fundings[0].retry_at = f.now() + 60000;
    const r = f.recovery(async () => { checks++; throw new FundingAwaitingError('pending'); });
    assert.equal((await r.refreshTask(await f.current())).waitMs, 60000); assert.equal(checks, 0);
    f.advance(60000); await r.refreshTask(await f.current()); assert.equal(checks, 1);
});

test('manual handoff and active in-memory funding workers are never resumed by recovery', async () => {
    for (const state of ['funding_waiting', 'funding_review', 'funding_pending', 'card_pending', 'support_locked']) {
        const active = ['funding_waiting', 'funding_review'].includes(state);
        const f = await setup({ taskState: active ? state : 'funding_waiting' }); let checks = 0;
        if (active) f.activeJobs.add(f.task.jobKey);
        else Object.assign(f.db.tasks[0], { status: 'manual', orbitcard_state: state });
        const r = f.recovery(async () => { checks++; return 42; });
        assert.equal((await r.refreshTask(await f.current())).querySkipped, true);
        assert.equal(checks, 0); assert.ok(f.db.cdks[0].used_at);
        assert.equal(f.db.cards[0].active_job, f.task.jobKey);
        assert.equal(f.db.tasks[0].orbitcard_state, state);
    }
});

test('unknown or mismatching funding is handed to support without unlocking the CDK or card', async () => {
    const f = await setup();
    const r = f.recovery(async () => { throw new CardPreparationError('original funding amount mismatch'); });
    assert.equal((await r.refreshTask(await f.current())).applied, true);
    assert.equal(f.db.tasks[0].status, 'manual'); assert.equal(f.db.tasks[0].orbitcard_state, 'funding_pending');
    assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    assert.equal(f.db.uses[0].state, 'reserved');
});

test('confirmed failed funding releases the unsubmitted order, including failure discovered by reconciliation', async () => {
    for (const alreadyFailed of [true, false]) {
        const f = await setup({ fundingState: alreadyFailed ? 'failed' : 'pending' });
        const r = f.recovery(async () => {
            assert.equal(alreadyFailed, false);
            await f.methods.updateFunding('fund-original', { state: 'failed' });
            throw new CardPreparationError('funding failed');
        });
        await r.refreshTask(await f.current());
        assert.equal(f.db.tasks[0].status, 'failed'); assert.equal(f.db.tasks[0].orbitcard_state, 'rejected');
        assert.equal(f.db.cdks[0].used_at, null); assert.equal(f.db.cards[0].active_job, null);
    }
});

test('preparing and legacy prepared recovery only promote a known pending original funding to a review ticket', async () => {
    for (const preparationState of ['preparing', 'prepared']) {
        for (const [fundingState, orderNo, expected] of [['pending', 'FUND-ORIGINAL', 'funding_review'],
            ['pending', '', 'funding_pending'], ['unknown', 'FUND-ORIGINAL', 'funding_pending'],
            ['submitting', 'FUND-ORIGINAL', 'funding_pending']]) {
            const f = await setup({ waiting: false, preparationState, fundingState, orderNo });
            let checks = 0;
            const r = f.recovery(async () => { checks++; throw new FundingAwaitingError('pending'); });
            await r.refreshTask(await f.current());
            assert.equal(f.db.tasks[0].orbitcard_state, expected);
            assert.equal(f.db.tasks[0].status, 'manual'); assert.equal(checks, 0);
            assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, f.task.jobKey);
            f.advance(FUNDING_POLL_MS); await r.refreshTask(await f.current());
            assert.equal(checks, expected === 'funding_review' ? 1 : 0);
        }
    }
});

test('preparing and legacy prepared with completed funding release without submitting a subscription', async () => {
    for (const preparationState of ['preparing', 'prepared']) {
        for (const fundingState of ['ready', 'failed']) {
            const f = await setup({ waiting: false, preparationState, fundingState }); let checks = 0;
            const r = f.recovery(async () => { checks++; return 42; });
            assert.equal((await r.refreshTask(await f.current())).applied, true);
            assert.equal(checks, 0); assert.equal(f.db.tasks[0].orbitcard_state, 'rejected');
            assert.equal(f.db.tasks[0].status, fundingState === 'ready' ? 'retry' : 'failed');
            assert.equal(f.db.cdks[0].used_at, null); assert.equal(f.db.cards[0].active_job, null);
        }
    }
});

test('without a funding callback recovery retains the review ticket instead of querying a nonexistent subscription', async () => {
    const f = await setup(); const r = f.recovery(null);
    assert.equal((await r.refreshTask(await f.current())).waitMs, FUNDING_POLL_MS);
    assert.equal(f.db.tasks[0].orbitcard_state, 'funding_review');
    assert.ok(f.db.cdks[0].used_at);
});

test('losing execution ownership or receiving a manual stop cannot write a recovery settlement', async () => {
    for (const manual of [false, true]) {
        const f = await setup(); let owned = true, released = false;
        const guard = { assertOwned: async () => { if (!owned) throw new Error('lost lock'); }, release: async () => { released = true; } };
        const r = f.recovery(async () => {
            if (manual) throw new PaymentStoppedError('stopped');
            owned = false; throw new Error('transport failure after lock loss');
        }, { acquirePaymentLock: async () => guard });
        if (manual) assert.equal((await r.refreshTask(await f.current())).querySkipped, true);
        else await assert.rejects(r.refreshTask(await f.current()), /lost lock/);
        assert.equal(released, true); assert.equal(f.db.tasks[0].orbitcard_state, 'funding_review');
        assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    }
});

test('a callback cannot release funds without a persisted ready result and matching card identity', async () => {
    for (const persistReady of [false, true]) {
        const f = await setup();
        const r = f.recovery(async () => {
            if (persistReady) await f.methods.updateFunding('fund-original', { state: 'ready' });
            return persistReady ? 999 : 42;
        });
        await r.refreshTask(await f.current());
        assert.equal(f.db.tasks[0].orbitcard_state, 'funding_pending');
        assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    }
});
