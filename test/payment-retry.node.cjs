'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./helpers/card-db.cjs');
const hash = crypto.createHash('sha256').update('retry-key').digest('hex');

async function failedAttempt(f = fixture()) {
    f.db.cdks.push({ cdk_code: 'RETRY-CDK', is_active: 1, type: '自助', plan_type: 'plus' });
    const task = await f.store.createOrbitcardTask({ cdk: 'RETRY-CDK', planType: 'plus', email: 'buyer@example.test', baseUrl: f.base, apiKeyHash: hash });
    await f.addCard(42);
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    await f.store.settleOrbitcardTask(task.jobKey, { status: 'running', orbitcardState: 'prepared', expectedState: 'preparing', expectedClientOrderNo: task.orbitcardClientOrderNo });
    await f.settle(task, 'submitting');
    const failure = { clientOrderNo: task.orbitcardClientOrderNo, cardId: 42, orderId: 'SUB-1', raw: JSON.stringify({
        task_no: 'SUB-1', client_order_no: task.orbitcardClientOrderNo, card_id: 42, plan_type: 'gpt-plus',
        targetEmail: 'buyer@example.test', status: 'failed', subscription_succeeded: false, query_source: 'upstream'
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
    const recovery = require('../order-recovery')({ store: f.store, query: { refresh: async () => assert.fail('failed attempt needs no new query') }, activeJobs: new Set(), audit() {} });
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
