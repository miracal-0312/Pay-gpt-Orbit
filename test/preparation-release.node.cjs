'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/card-db.cjs');

async function setup(state = 'ready') {
    const f = fixture(), task = await f.claim(), methods = f.store.cardMethods(f.base);
    const issue = await methods.createIssue({ issue_key: 'issue-original', job_key: task.jobKey, plan_type: 'plus',
        product_code: 'p1', amount: '20.00', credential_hash: 'original-key', request_body: '{}' });
    await methods.attachIssue(task.jobKey, issue.issue_key);
    await methods.updateIssue(issue.issue_key, { state, card_id: state === 'ready' ? 42 : null, order_no: 'ISSUE-ORIGINAL' });
    await f.store.settleOrbitcardTask(task.jobKey, { status: 'manual', orbitcardState: 'card_pending', message: 'pending' });
    const release = () => f.store.settleOrbitcardTask(task.jobKey, { status: 'retry', orbitcardState: 'rejected',
        expectedState: 'card_pending', expectedClientOrderNo: task.orbitcardClientOrderNo, message: 'confirmed' });
    return { ...f, task, methods, release };
}

test('confirmed original card applications release unsubmitted tasks without creating subscriptions', async () => {
    for (const state of ['ready', 'failed']) for (const redeemed of [false, true]) {
        const f = await setup(state);
        if (redeemed) f.db.cdks[0].manual_redeemed_at = 'done';
        const recovery = require('../order-recovery')({ store: f.store, activeJobs: new Set(), audit() {},
            query: { refresh: async () => assert.fail('subscription was never submitted') } });
        assert.equal((await recovery.refreshTask(f.db.tasks[0])).applied, true);
        assert.equal(f.db.tasks[0].orbitcard_state, redeemed ? 'support_locked' : 'rejected');
        assert.equal(Boolean(f.db.cdks[0].used_at), redeemed);
        assert.equal(f.db.tasks.length, 1);
    }
});

test('card review cannot release a missing, unresolved or foreign original issue', async () => {
    for (const mismatch of ['pending', 'missing', 'scope', 'plan', 'job', 'credential', 'card', 'submitted']) {
        const f = await setup(mismatch === 'pending' ? 'pending' : 'ready');
        if (mismatch === 'missing') f.db.issues.length = 0;
        if (mismatch === 'scope') f.db.issues[0].scope = 'foreign';
        if (mismatch === 'plan') f.db.issues[0].plan_type = 'pro100';
        if (mismatch === 'job') f.db.issues[0].job_key = 'other-job';
        if (mismatch === 'credential') f.db.tasks[0].orbitcard_api_key_hash = 'different-key';
        if (mismatch === 'card') f.db.issues[0].card_id = null;
        if (mismatch === 'submitted') f.db.tasks[0].gpt_api_order_id = 'SUBMITTED';
        assert.equal((await f.release()).applied, false, mismatch);
        assert.ok(f.db.cdks[0].used_at, mismatch);
        assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending', mismatch);
    }
});

test('card review retains a reserved card when original funding is unresolved', async () => {
    const f = fixture(), task = await f.claim(), methods = f.store.cardMethods(f.base);
    await f.addCard(); await methods.reserveCard(42, task.jobKey, 'plus');
    await methods.createIssue({ issue_key: 'i', job_key: task.jobKey, plan_type: 'plus', product_code: 'p1', amount: '20.00', credential_hash: 'key', request_body: '{}' });
    await methods.attachIssue(task.jobKey, 'i'); await methods.updateIssue('i', { state: 'ready', card_id: 42 });
    await methods.createFunding({ funding_key: 'f', job_key: task.jobKey, plan_type: 'plus', card_id: 42,
        credential_hash: 'key', request_body: '{"card_id":42,"amount":"1.00"}', amount: '1.00', target_balance: '21.00' });
    await f.store.settleOrbitcardTask(task.jobKey, { status: 'manual', orbitcardState: 'card_pending' });
    const input = { status: 'retry', orbitcardState: 'rejected', expectedState: 'card_pending', expectedClientOrderNo: task.orbitcardClientOrderNo };
    assert.equal((await f.store.settleOrbitcardTask(task.jobKey, input)).applied, false);
    assert.equal(f.db.cards[0].active_job, task.jobKey);
    await methods.updateFunding('f', { state: 'ready' });
    f.db.failRelease = true;
    await assert.rejects(f.store.settleOrbitcardTask(task.jobKey, input), /injected card release/);
    assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending'); assert.ok(f.db.cdks[0].used_at);
    f.db.failRelease = false;
    assert.equal((await f.store.settleOrbitcardTask(task.jobKey, input)).applied, true);
    assert.equal(f.db.cards[0].active_job, null); assert.equal(f.db.cdks[0].used_at, null);
});
