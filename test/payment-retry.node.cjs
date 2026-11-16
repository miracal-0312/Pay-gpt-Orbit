'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./helpers/card-db.cjs');
const hash = crypto.createHash('sha256').update('retry-key').digest('hex');

async function failedAttempt(f = fixture(), snapshotOverrides = {}) {
    f.db.cdks.push({ cdk_code: 'RETRY-CDK', is_active: 1, type: '自助', plan_type: 'plus' });
    const task = await f.store.createOrbitcardTask({ cdk: 'RETRY-CDK', planType: 'plus', email: 'buyer@example.test', baseUrl: f.base, apiKeyHash: hash });
    await f.addCard(42);
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    await f.store.settleOrbitcardTask(task.jobKey, { status: 'running', orbitcardState: 'prepared', expectedState: 'preparing', expectedClientOrderNo: task.orbitcardClientOrderNo });
    await f.settle(task, 'submitting');
    const failure = { clientOrderNo: task.orbitcardClientOrderNo, cardId: 42, orderId: 'SUB-1', raw: JSON.stringify({
        task_no: 'SUB-1', client_order_no: task.orbitcardClientOrderNo, card_id: 42, plan_type: 'gpt-plus',
        targetEmail: 'buyer@example.test', status: 'failed', subscription_succeeded: false, query_source: 'upstream', failureCode: 'card_declined', ...snapshotOverrides
    }) };
    const result = await f.store.recordOrbitcardPaymentFailure(task.jobKey, failure);
    return { ...f, task, failure, result, credentials: { email: 'buyer@example.test', baseUrl: f.base, apiKeyHash: hash } };
}

test('concurrent retry claims produce one new durable attempt and preserve the first failure', async () => {
    const f = await failedAttempt();
    assert.equal(f.result.retry, true);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials)));
    assert.equal(results.filter(Boolean).length, 1); assert.equal(f.db.tasks.length, 2);
    assert.equal(f.db.tasks[0].gpt_api_order_id, 'SUB-1'); assert.equal(f.db.tasks[0].orbitcard_state, 'failed');
    assert.equal(f.db.tasks[1].orbitcard_retry_attempt_no, 2); assert.equal(f.db.tasks[1].orbitcard_retry_first_card_id, 42);
    assert.notEqual(f.db.tasks[0].orbitcard_client_order_no, f.db.tasks[1].orbitcard_client_order_no);
    assert.ok(f.db.cdks[0].used_at);
});

test('a card-specific failure and its disable marker roll back with failed reservation release', async () => {
    const f = await failedAttempt(fixture(), { failureCode: 'session_expired' });
    Object.assign(f.db.tasks[0], { orbitcard_state: 'pending', status: 'running' });
    f.db.uses[0].state = 'reserved'; f.db.cards[0].active_job = f.task.jobKey;
    f.db.failRelease = true;
    f.failure.raw = JSON.stringify({ ...JSON.parse(f.failure.raw), failureCode: 'card_declined' });
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(f.task.jobKey, f.failure), /release failure/);
    assert.equal(f.db.cards[0].disabled_at, undefined);
    assert.equal(f.db.cards[0].active_job, f.task.jobKey);
});

test('Session failures release the attempt without disabling the payment card', async () => {
    const f = await failedAttempt(fixture(), { failureCode: 'session_expired', failureMessage: 'Session 已失效，请重新登录' });
    assert.equal(f.db.cards[0].disabled_at, undefined);
    assert.equal(f.result.retry, false);
    assert.equal(f.db.tasks[0].orbitcard_state, 'support_locked');
    assert.equal(f.db.cards[0].active_job, null);
    assert.equal(await f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials), null);
    assert.match(f.db.tasks[0].message, /Session/);
});

test('documented card-unavailable rejection supports retry without an accepted upstream order', async () => {
    const f = fixture();
    f.db.cdks.push({ cdk_code: 'REJECTED-CARD', is_active: 1, type: '自助', plan_type: 'plus' });
    const task = await f.store.createOrbitcardTask({ cdk: 'REJECTED-CARD', planType: 'plus',
        email: 'buyer@example.test', baseUrl: f.base, apiKeyHash: hash });
    await f.addCard(42);
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    await f.store.settleOrbitcardTask(task.jobKey, { status: 'running', orbitcardState: 'prepared',
        expectedState: 'preparing', expectedClientOrderNo: task.orbitcardClientOrderNo });
    await f.settle(task, 'submitting');
    const provider = { request: async () => ({ success: false, status: 400, code: 59005, data: null }), summary: () => ({}) };
    const service = require('../src/orbitcard/orbitcard-subscription-service')(provider);
    const created = await service.submit({}, { body: {}, expected: { clientOrderNo: task.orbitcardClientOrderNo,
        cardId: 42, planType: 'gpt-plus' } });
    assert.equal(created.cardRejected, true);
    const result = await f.store.recordOrbitcardPaymentFailure(task.jobKey, { clientOrderNo: task.orbitcardClientOrderNo,
        cardId: 42, orderId: null, raw: JSON.stringify(created.snapshot) });
    assert.equal(result.retry, true); assert.equal(f.db.cards[0].disabled_code, 'card_unavailable');
    const recovery = require('../src/payments/order-recovery')({ store: f.store, query: { refresh: async () => assert.fail('rejected create must not query a nonexistent upstream order') }, activeJobs: new Set(), audit() {} });
    await recovery.refreshTask(f.db.tasks[0]);
    assert.equal(f.db.tasks[0].orbitcard_state, 'retry_waiting');
    const next = await f.store.claimOrbitcardRetry(task.jobKey, { email: 'buyer@example.test', baseUrl: f.base, apiKeyHash: hash });
    assert.equal(next.orbitcardRetryAttemptNo, 2);
});

test('unknown terminal failure is preserved for review without another payment or permanent card disable', async () => {
    const f = await failedAttempt(fixture(), { failureCode: 'undocumented_provider_failure', failureMessage: 'Unknown' });
    assert.equal(f.result.retry, false);
    assert.equal(f.db.tasks[0].orbitcard_state, 'support_locked');
    assert.ok(f.db.cdks[0].used_at);
    assert.equal(f.db.cards[0].disabled_at, undefined);
    assert.equal(await f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials), null);
});

test('legacy retry state cannot bypass new failure classification through activation or recovery', async () => {
    const f = await failedAttempt(fixture(), { failureCode: 'session_expired' });
    Object.assign(f.db.tasks[0], { orbitcard_state: 'retry_waiting', status: 'running' });
    assert.equal(await f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials), null);
    const recovery = require('../src/payments/order-recovery')({ store: f.store, query: { refresh: async () => assert.fail('no query') }, activeJobs: new Set(), audit() {} });
    await recovery.refreshTask(f.db.tasks[0]);
    assert.equal(f.db.tasks[0].orbitcard_state, 'support_locked');
    assert.equal(f.db.tasks.length, 1);
});

test('recovery closes exhausted or malformed retry counters without reopening payment', async () => {
    for (const attempt of [3, 4, 0, -1, 1.5, undefined, 'invalid']) {
        const f = await failedAttempt();
        f.db.tasks[0].orbitcard_retry_attempt_no = attempt;
        assert.equal(await f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials), null);
        const recovery = require('../src/payments/order-recovery')({ store: f.store, query: { refresh: async () => assert.fail('no new payment') }, activeJobs: new Set(), audit() {} });
        await recovery.refreshTask(f.db.tasks[0]);
        assert.equal(f.db.tasks[0].orbitcard_state, 'support_locked', String(attempt));
        assert.equal(f.db.tasks.length, 1);
    }
});

test('a legacy retry with missing evidence preserves any original card reservation for manual reconciliation', async () => {
    const f = await failedAttempt();
    Object.assign(f.db.tasks[0], { orbitcard_state: 'retry_waiting', status: 'running', gpt_api_raw: '{broken' });
    Object.assign(f.db.uses[0], { state: 'reserved' }); f.db.cards[0].active_job = f.task.jobKey;
    const recovery = require('../src/payments/order-recovery')({ store: f.store, query: { refresh: async () => assert.fail('no automatic payment') }, activeJobs: new Set(), audit() {} });
    await recovery.refreshTask(f.db.tasks[0]);
    assert.equal(f.db.tasks[0].orbitcard_state, 'support_locked');
    assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    assert.equal(f.db.uses[0].state, 'reserved');
});

test('even confirmed subscription failure cannot release an unresolved funding intent', async () => {
    const f = await failedAttempt();
    Object.assign(f.db.tasks[0], { orbitcard_state: 'pending', status: 'running' });
    Object.assign(f.db.uses[0], { state: 'reserved' }); f.db.cards[0].active_job = f.task.jobKey;
    f.db.fundings.push({ funding_key: 'unresolved', job_key: f.task.jobKey, state: 'unknown' });
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(f.task.jobKey, f.failure), /资金仍待核对/);
    assert.equal(f.db.tasks[0].orbitcard_state, 'pending');
    assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    assert.equal(f.db.tasks.length, 1);
});

test('failure settlement cannot disable or release a card currently owned by another task', async () => {
    const f = await failedAttempt(fixture(), { failureCode: 'session_expired' });
    Object.assign(f.db.tasks[0], { orbitcard_state: 'pending', status: 'running' });
    Object.assign(f.db.uses[0], { state: 'reserved' }); f.db.cards[0].active_job = 'another-task';
    const raw = JSON.stringify({ ...JSON.parse(f.failure.raw), failureCode: 'card_declined' });
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(f.task.jobKey, { ...f.failure, raw }), /占用或归属不一致/);
    assert.equal(f.db.tasks[0].orbitcard_state, 'pending');
    assert.equal(f.db.cards[0].active_job, 'another-task');
    assert.equal(f.db.cards[0].disabled_at, undefined);
    assert.equal(f.db.uses[0].state, 'reserved');
});

test('forged rejection and failed snapshots cannot release a submitted payment', async () => {
    const f = await failedAttempt();
    Object.assign(f.db.tasks[0], { orbitcard_state: 'pending', status: 'running' });
    Object.assign(f.db.uses[0], { state: 'reserved' }); f.db.cards[0].active_job = f.task.jobKey;
    const original = JSON.parse(f.failure.raw);
    for (const raw of [
        { ...original, client_order_no: 'different' },
        { ...original, request_error: { code: 'relay_timeout' } },
        { ...original, upstream_status: 'processing' },
        { ...original, subscription_succeeded: true },
        { ...original, plan_type: 'gpt-pro-20x' },
        { ...original, subscription_succeeded: 'false' },
        { ...original, result_source: 'relay' }
    ]) {
        await assert.rejects(f.store.recordOrbitcardPaymentFailure(f.task.jobKey, { ...f.failure, raw: JSON.stringify(raw) }));
        assert.equal(f.db.tasks[0].orbitcard_state, 'pending');
        assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    }
    for (const state of ['success', 'failed', 'rejected']) {
        const result = await f.store.settleOrbitcardTask(f.task.jobKey, {
            status: state === 'success' ? 'success' : 'failed', orbitcardState: state,
            gptApiRaw: JSON.stringify({ task_no: 'SUB-1', status: state })
        });
        assert.equal(result.applied, false);
    }
    assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    assert.ok(f.db.cdks[0].used_at);
});

test('retry claims enforce the original account and platform credentials without consuming another attempt', async () => {
    const f = await failedAttempt();
    for (const change of [{ email: 'other@example.test' }, { baseUrl: 'https://other.test' }, { apiKeyHash: 'other' }]) {
        await assert.rejects(f.store.claimOrbitcardRetry(f.task.jobKey, { ...f.credentials, ...change }), /不一致/);
        assert.equal(f.db.tasks.length, 1); assert.equal(f.db.tasks[0].orbitcard_state, 'retry_waiting');
    }
    f.db.cdks[0].manual_redeemed_at = 'done';
    assert.equal(await f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials), null);
});

test('a restarted service waits for Session and fresh credentials resume without resetting the count', async () => {
    const f = await failedAttempt();
    const recovery = require('../src/payments/order-recovery')({ store: f.store, query: { refresh: async () => assert.fail('failed attempt needs no new query') }, activeJobs: new Set(), audit() {} });
    await recovery.refreshTask(f.db.tasks[0]);
    assert.equal(f.db.tasks[0].orbitcard_state, 'retry_waiting'); assert.equal(f.db.tasks.length, 1);
    const next = await f.store.claimOrbitcardRetry(f.task.jobKey, f.credentials);
    assert.equal(next.orbitcardRetryAttemptNo, 2);
    await f.addCard(43);
    assert.equal(await f.store.cardMethods(f.base).reserveCard(42, next.jobKey, 'plus'), null);
    assert.ok(await f.store.cardMethods(f.base).reserveCard(43, next.jobKey, 'plus'));
    await f.store.settleOrbitcardTask(next.jobKey, { status: 'failed', orbitcardState: 'rejected', expectedState: 'preparing', expectedClientOrderNo: next.orbitcardClientOrderNo });
    assert.equal(f.db.tasks[1].orbitcard_state, 'support_locked'); assert.ok(f.db.cdks[0].used_at);
    assert.equal(await f.store.createOrbitcardTask({ cdk: 'RETRY-CDK', planType: 'plus', email: f.credentials.email, baseUrl: f.base, apiKeyHash: hash }), null);
});

test('failure settlement rolls back the retry queue when releasing the failed card fails', async () => {
    const f = await failedAttempt();
    // Reconstruct a still-pending original to exercise the same settlement transaction.
    Object.assign(f.db.tasks[0], { orbitcard_state: 'pending', status: 'running' });
    Object.assign(f.db.uses[0], { state: 'reserved' }); f.db.cards[0].active_job = f.task.jobKey;
    f.db.failRelease = true;
    await assert.rejects(f.store.recordOrbitcardPaymentFailure(f.task.jobKey, f.failure), /release failure/);
    assert.equal(f.db.tasks[0].orbitcard_state, 'pending'); assert.equal(f.db.cards[0].active_job, f.task.jobKey);
    assert.equal(f.db.tasks.length, 1); assert.ok(f.db.cdks[0].used_at);
});
