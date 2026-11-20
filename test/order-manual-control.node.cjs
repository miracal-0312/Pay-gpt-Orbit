'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createService = require('../src/payments/order-manual-control');
const { cardScope } = require('../src/orbitcard/orbitcard-card-policy');

const scope = cardScope('https://cards.example');
const keyHash = 'a'.repeat(64);
function fixture(kind = 'task') {
    const task = { id: 1, job_key: 'job-1', cdk_code: 'CODE-1', status: 'manual', orbitcard_state: 'support_locked', progress: 90,
        orbitcard_client_order_no: 'client-1', orbitcard_base_url: 'https://cards.example', orbitcard_plan_type: 'plus',
        orbitcard_api_key_hash: keyHash, orbitcard_card_id: 7, orbitcard_email: 'customer@example.com',
        session_payload: 'SECRET_SESSION', gpt_api_raw: '{"original":"snapshot"}', updated_at: '2026-11-17 12:00:00' };
    const admin = { request_id: 'request-1', client_order_no: 'manual-request-1', cdk_code: 'CODE-1', state: 'support_locked',
        mode: 'fulfillment', scope, api_key_hash: keyHash, plan_type: 'plus', card_id: 7,
        target_email: 'customer@example.com', snapshot: '{"original":"snapshot"}', created_at: '2026-11-17 12:00:00' };
    let state = {
        tasks: kind === 'task' ? [task] : [], admins: kind === 'admin' ? [admin] : [],
        code: { cdk_code: 'CODE-1', is_active: 1, used_at: '2026-11-17 12:00:00' },
        fundings: [], issues: [], cards: [{ scope, card_id: 7, active_job: kind === 'task' ? task.job_key : admin.client_order_no }],
        uses: kind === 'task' ? [{ job_key: 'job-1', scope, card_id: 7, plan_type: 'plus', state: 'reserved' }] : [], history: []
    };
    const id = kind === 'task' ? task.job_key : admin.request_id, reads = [], writes = [], events = [];
    let busy = false, lost = false, enqueueError = false, beforeTransaction = null;
    const clone = value => structuredClone(value);
    const store = {
        acquirePaymentLock: async keys => {
            events.push(['lock', keys]);
            return busy ? null : { assertOwned: async () => { if (lost) throw new Error('private lock failure'); }, release: async () => events.push(['released']) };
        },
        withTransaction: async fn => {
            if (beforeTransaction) { beforeTransaction(); beforeTransaction = null; }
            const snapshot = clone(state), writeCount = writes.length, eventCount = events.length;
            try { return await fn({ transaction: true }); } catch (error) {
                state = snapshot; writes.length = writeCount; events.splice(eventCount); events.push(['rollback']); throw error;
            }
        },
        runQuery: async (sql, args, options) => {
            reads.push({ sql, args, options });
            if (sql.endsWith('FOR UPDATE')) assert.equal(options?.connection?.transaction, true);
            if (sql.includes('FROM order_manual_actions')) return clone(state.history.filter(row => row.order_kind === args[0] && row.order_id === args[1]).slice().reverse().slice(0, 100));
            if (sql.includes('FROM task_logs')) return clone(sql.includes('WHERE cdk_code')
                ? state.tasks.filter(row => row.cdk_code === args[0]).sort((a, b) => b.id - a.id).slice(0, 1)
                : state.tasks.filter(row => row.job_key === args[0]));
            if (sql.includes('FROM orbitcard_admin_orders')) return clone(sql.includes('WHERE cdk_code')
                ? state.admins.filter(row => row.cdk_code === args[0]).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.request_id.localeCompare(a.request_id))
                : state.admins.filter(row => sql.includes('WHERE client_order_no') ? row.client_order_no === args[0] : row.request_id === args[0]));
            if (sql.includes('FROM cdk_codes')) return clone(state.code?.cdk_code === args[0] ? [state.code] : []);
            if (sql.includes('FROM orbitcard_card_fundings')) return clone(state.fundings.filter(row => row.job_key === args[0]));
            if (sql.includes('FROM orbitcard_card_issues')) return clone(state.issues.filter(row => row.job_key === args[0] || row.issue_key === args[1] || row.replacement_for_job_key === args[2]));
            if (sql.includes('FROM orbitcard_managed_cards')) return clone(state.cards.filter(row => row.scope === args[0] && row.card_id === args[1]));
            if (sql.includes('FROM orbitcard_card_uses')) return clone(state.uses.filter(row => row.job_key === args[0]));
            throw new Error('Unexpected read: ' + sql);
        },
        runExecute: async (sql, args, options) => {
            assert.equal(options?.connection?.transaction, true); writes.push({ sql, args });
            if (/^UPDATE (task_logs|orbitcard_admin_orders) SET manual_result =/.test(sql)) {
                const row = sql.startsWith('UPDATE task_logs') ? state.tasks.find(row => row.job_key === args[3]) : state.admins.find(row => row.request_id === args[3]);
                Object.assign(row, { manual_result: args[0], manual_result_reason: args[1], manual_result_by: args[2], manual_result_at: '2026-11-17 13:00:00' });
            } else if (/^UPDATE (task_logs|orbitcard_admin_orders) SET manual_local_released_by =/.test(sql)) {
                const row = sql.startsWith('UPDATE task_logs') ? state.tasks.find(row => row.job_key === args[2]) : state.admins.find(row => row.request_id === args[2]);
                assert.equal(Boolean(row.manual_local_released_at), false);
                Object.assign(row, { manual_local_released_by: args[0], manual_local_release_reason: args[1], manual_local_released_at: '2026-11-17 13:00:00' });
            } else if (/^UPDATE orbitcard_card_(fundings|issues) SET local_released_by =/.test(sql)) {
                const intents = sql.startsWith('UPDATE orbitcard_card_fundings') ? state.fundings : state.issues;
                const row = intents.find(row => (row.funding_key || row.issue_key) === args[2]);
                assert.ok(row); assert.equal(Boolean(row.local_released_at), false);
                const replacement = sql.includes('job_key IS NULL');
                assert.equal(replacement ? row.replacement_for_job_key : row.job_key, args[3]);
                if (replacement) assert.equal(row.replacement_for_card_id, args[4]);
                const offset = replacement ? 5 : 4;
                assert.deepEqual([row.scope, row.credential_hash, row.plan_type], args.slice(offset));
                Object.assign(row, { local_released_by: args[0], local_release_reason: args[1], local_released_at: '2026-11-17 13:00:00' });
            } else if (sql.startsWith('UPDATE task_logs')) {
                Object.assign(state.tasks.find(row => row.job_key === args[4]), { status: args[0], progress: args[1], message: args[2], orbitcard_state: args[3], session_payload: null });
            } else if (sql.startsWith('UPDATE orbitcard_admin_orders')) {
                Object.assign(state.admins.find(row => row.request_id === args[2]), { state: args[0], message: args[1] });
            } else if (sql.startsWith('UPDATE cdk_codes')) {
                if (sql.includes('SET used_at = NULL')) { if (!state.code.manual_redeemed_at) state.code.used_at = null; }
                else state.code.used_at ||= '2026-11-17 13:00:00';
                if (sql.includes('manual_redeemed_at') && !state.code.manual_redeemed_at) {
                    if (!sql.includes('SET used_at = NULL')) Object.assign(state.code, { manual_redeemed_at: '2026-11-17 13:00:00', manual_redeemed_by: args[0], manual_redemption_reason: args[1] });
                }
            } else if (sql.startsWith('UPDATE orbitcard_card_uses')) {
                state.uses.find(row => row.job_key === args[0] && row.state === 'reserved').state = 'released';
            } else if (sql.startsWith('UPDATE orbitcard_managed_cards')) {
                const card = state.cards.find(row => row.scope === args[0] && row.card_id === args[1] && row.active_job === args[2]);
                assert.ok(card); card.active_job = null;
            } else if (sql.startsWith('INSERT INTO order_manual_actions')) {
                const [order_kind, order_id, action, reason, admin_email, previous_status, next_status, previous_state, next_state, release_local_hold] = args;
                state.history.push({ id: state.history.length + 1, order_kind, order_id, action, reason, admin_email, previous_status, next_status, previous_state, next_state, release_local_hold, created_at: '2026-11-17 13:00:00' });
            } else throw new Error('Unexpected write: ' + sql);
            return { affectedRows: 1 };
        },
        enqueueRedemption: async (data, options) => {
            assert.equal(options?.connection?.transaction, true);
            if (enqueueError) throw new Error('private webhook credential error');
            events.push(['redemption', data]);
        }
    };
    const service = createService(store);
    return { kind, id, reads, writes, events, store, service,
        get state() { return state; }, get row() { return (kind === 'task' ? state.tasks : state.admins)[0]; },
        get job() { return kind === 'task' ? state.tasks[0].job_key : state.admins[0].client_order_no; },
        get: () => service.getOrderManualControl({ kind, id }),
        async save(action = 'success', extra = {}) {
            const view = await service.getOrderManualControl({ kind, id });
            return service.applyOrderManualControl({ kind, id, action, expectedRevision: view.revision, reason: '人工核对完成', adminEmail: 'admin@example.com', ...extra });
        },
        setState(value) { if (kind === 'task') state.tasks[0].orbitcard_state = value; else state.admins[0].state = value; },
        lock() { busy = true; }, loseLock() { lost = true; }, failEnqueue() { enqueueError = true; },
        beforeTransaction(fn) { beforeTransaction = fn; },
        intent(type, overrides = {}) {
            const value = { job_key: this.job, scope, plan_type: 'plus', card_id: 7, credential_hash: keyHash, state: 'ready', ...overrides };
            if (type === 'issue') { value.issue_key ||= 'issue-1'; state.issues.push(value); }
            else { value.funding_key ||= 'funding-1'; state.fundings.push(value); }
            return value;
        }
    };
}

async function assertHeld(f, action = 'success') {
    const original = structuredClone({ fundings: f.state.fundings, issues: f.state.issues, cards: f.state.cards, uses: f.state.uses });
    const snapshot = f.kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot;
    const view = await f.get();
    assert.equal(view.actions.find(item => item.value === action).enabled, true);
    assert.equal(view.settlement.allowed, false);
    const result = await f.save(action);
    assert.equal(result.manual_result, action); assert.equal(result.manual_result_by, 'admin@example.com');
    assert.deepEqual({ fundings: f.state.fundings, issues: f.state.issues, cards: f.state.cards, uses: f.state.uses }, original);
    assert.equal(f.kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot, snapshot);
    assert.equal(f.writes.some(write => /UPDATE orbitcard_(managed_cards|card_uses|card_fundings|card_issues)/.test(write.sql)), false);
    assert.equal(Boolean(f.row.manual_local_released_at), false);
    assert.equal(result.history[0].release_local_hold, false);
    assert.equal(f.events.some(event => event[0] === 'redemption'), action === 'success');
    return result;
}

for (const kind of ['task', 'admin']) {
    test(`${kind}: every terminal, unknown and historical order has a note without taking execution lock`, async () => {
        for (const state of ['success', 'failed', 'support_locked', 'closed', 'unrecognized']) {
            const f = fixture(kind); f.setState(state); f.lock();
            if (kind === 'task') f.state.tasks.push({ ...f.row, id: 2, job_key: 'new-task' });
            const before = structuredClone(f.state), initial = await f.get(), saved = await f.save('note');
            assert.equal(initial.actions.find(action => action.value === 'note').enabled, true);
            assert.equal(saved.history[0].action, 'note'); assert.notEqual(saved.revision, initial.revision);
            assert.deepEqual(f.state.tasks, before.tasks); assert.deepEqual(f.state.admins, before.admins);
            assert.deepEqual(f.state.cards, before.cards); assert.deepEqual(f.state.code, before.code);
            assert.equal(f.events.some(event => event[0] === 'lock'), false);
            assert.equal(f.writes.length, 1);
        }
    });
    test(`${kind}: stopped preparation may complete by human delivery without forging platform evidence`, async () => {
        const f = fixture(kind); f.setState('preparing');
        const snapshot = kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot;
        const saved = await f.save('success');
        assert.equal(saved.status, 'success'); assert.equal(saved.state, 'success');
        assert.equal(f.state.code.manual_redeemed_by, 'admin@example.com');
        assert.equal(f.state.code.manual_redemption_reason, '人工核对完成');
        assert.equal(f.state.cards[0].active_job, null);
        assert.equal(kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot, snapshot);
        if (kind === 'task') { assert.equal(f.state.uses[0].state, 'released'); assert.equal(f.row.session_payload, null); }
        assert.equal(f.writes.some(write => /successful_orders|email_notification|gpt_api_raw|snapshot\s*=/.test(write.sql)), false);
        assert.equal(f.events.filter(event => event[0] === 'redemption').length, 1);
        await f.save('success');
        assert.equal(f.events.filter(event => event[0] === 'redemption').length, 1);
        assert.equal(f.state.history.length, 2);
    });
    test(`${kind}: unknown funding and issue states allow manual results while retaining original money`, async () => {
        for (const type of ['funding', 'issue']) for (const intentState of ['prepared', 'submitting', 'pending', 'unknown', 'unexpected']) {
            for (const action of ['success', 'failed']) for (const orderState of ['manual', 'support_locked']) {
                const f = fixture(kind); f.setState(orderState); f.intent(type, { state: intentState });
                await assertHeld(f, action);
            }
        }
    });
    test(`${kind}: final funding and issue still require exact scope, plan, credential, card and cardinality`, async () => {
        for (const type of ['funding', 'issue']) for (const state of ['ready', 'failed']) {
            for (const mismatch of [{ scope: 'wrong' }, { plan_type: 'pro100' }, { credential_hash: 'wrong' }, { card_id: 99 }, 'duplicate', 'job']) {
                const f = fixture(kind);
                const intent = f.intent(type, { state, ...(typeof mismatch === 'object' ? mismatch : {}) });
                if (mismatch === 'duplicate') f.intent(type, { state });
                if (mismatch === 'job') {
                    if (type === 'funding') { f.setState('funding_pending'); intent.job_key = 'someone-else'; }
                    else { if (kind === 'task') f.row.orbitcard_issue_key = intent.issue_key; else f.row.issue_key = intent.issue_key; intent.job_key = 'someone-else'; }
                }
                await assertHeld(f);
            }
        }
    });
    test(`${kind}: missing original issue and missing funding-review record cannot be closed`, async () => {
        for (const scenario of ['linked-issue', 'funding_pending', 'card_pending']) {
            const f = fixture(kind);
            if (scenario === 'linked-issue') { if (kind === 'task') f.row.orbitcard_issue_key = 'missing'; else f.row.issue_key = 'missing'; }
            else f.setState(scenario);
            await assertHeld(f, 'failed');
        }
    });
    test(`${kind}: resolved original money records allow a manual result and remain untouched`, async () => {
        for (const action of ['success', 'failed']) for (const intentState of ['ready', 'failed']) {
            const f = fixture(kind); f.intent('funding', { state: intentState }); f.intent('issue', { state: intentState });
            const before = structuredClone({ fundings: f.state.fundings, issues: f.state.issues });
            await f.save(action);
            assert.deepEqual({ fundings: f.state.fundings, issues: f.state.issues }, before);
            assert.equal(f.events.some(event => event[0] === 'redemption'), action === 'success');
        }
    });
    test(`${kind}: pause retains reconciliation and original snapshots, while stopping new automatic payment`, async () => {
        for (const [previous, expected] of [['submitting', 'manual'], ['pending', 'manual'], ['funding_waiting', 'funding_review'],
            ['funding_review', 'funding_review'], ['funding_pending', 'funding_pending'], ['card_pending', 'card_pending'],
            ['retry_waiting', 'support_locked'], ['preparing', 'support_locked'], ['prepared', 'support_locked'], ['balance_blocked', 'support_locked']]) {
            const f = fixture(kind); f.setState(previous);
            if (previous.startsWith('funding')) f.intent('funding', { state: 'pending' });
            if (previous === 'card_pending') f.intent('issue', { state: 'pending' });
            const saved = await f.save('pause');
            assert.equal(saved.state, expected); assert.equal(f.state.cards[0].active_job, f.job);
            assert.equal(f.state.code.used_at, '2026-11-17 12:00:00');
            const automation = require('../src/payments/payment-automation')({ runQuery: f.store.runQuery });
            const owner = await automation.paymentOwner(f.job);
            assert.equal(owner.allowed, false);
            if (previous.startsWith('funding')) assert.equal(owner.canReconcileFunding, true);
            if (previous === 'card_pending') assert.equal(owner.canReconcileIssue, true);
        }
        for (const type of ['funding', 'issue']) {
            const f = fixture(kind); f.setState('preparing'); f.intent(type, { state: 'unknown' });
            assert.equal((await f.save('pause')).state, type === 'funding' ? 'funding_pending' : 'card_pending');
        }
    });
    test(`${kind}: lock contention, lock loss and stale confirmation never mutate the order`, async () => {
        for (const scenario of ['busy', 'lost', 'stale']) {
            const f = fixture(kind);
            if (scenario === 'busy') f.lock();
            if (scenario === 'lost') f.loseLock();
            if (scenario === 'stale') f.beforeTransaction(() => { f.row.message = 'Background update within same second'; });
            await assert.rejects(f.save(), error => error.status === 409);
            assert.equal(f.writes.length, 0);
        }
    });
    test(`${kind}: all mutations and audit roll back if redemption enqueue fails`, async () => {
        const f = fixture(kind), original = structuredClone(f.state); f.failEnqueue();
        await assert.rejects(f.save(), error => error.status === 500 && !/credential/.test(error.message));
        assert.deepEqual(f.state, original); assert.equal(f.writes.length, 0);
        assert.equal(f.events.at(-1)[0], 'released');
    });
    test(`${kind}: failed manual resolution preserves prior CDK redemption, while success cannot downgrade`, async () => {
        const f = fixture(kind);
        Object.assign(f.state.code, { manual_redeemed_at: 'original', manual_redeemed_by: 'other@example.com', manual_redemption_reason: 'Delivered earlier' });
        const code = structuredClone(f.state.code); await f.save('failed');
        assert.deepEqual(f.state.code, code); assert.equal(f.events.some(event => event[0] === 'redemption'), false);
        f.setState('success');
        await assert.rejects(f.save('failed'), error => error.status === 409 && /成功/.test(error.message));
    });
    test(`${kind}: a current card belonging to another flow cannot be released`, async () => {
        const f = fixture(kind); f.setState('preparing'); f.state.cards[0].active_job = 'other-order';
        await assertHeld(f);
        await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
        assert.equal(f.state.cards[0].active_job, 'other-order');
    });
    test(`${kind}: card reused after a final result is never released a second time`, async () => {
        const f = fixture(kind); f.setState('failed');
        if (kind === 'task') { f.row.status = 'failed'; f.state.uses[0].state = 'released'; }
        f.state.cards[0].active_job = 'other-order';
        await f.save('success');
        assert.equal(f.state.cards[0].active_job, 'other-order');
        assert.equal(f.writes.some(write => /UPDATE orbitcard_(managed_cards|card_uses)/.test(write.sql)), false);
    });
}

test('historical task cannot mutate latest CDK task; another admin flow cannot be overwritten', async () => {
    for (const scenario of ['newer-task', 'other-admin', 'admin-has-task', 'older-admin']) {
        const kind = scenario.startsWith('admin') || scenario === 'older-admin' ? 'admin' : 'task', f = fixture(kind);
        if (scenario === 'newer-task') f.state.tasks.push({ ...f.row, id: 2, job_key: 'job-2' });
        if (scenario === 'other-admin') f.state.admins.push({ request_id: 'other', cdk_code: 'CODE-1', state: 'manual', created_at: '2026-11-17' });
        if (scenario === 'admin-has-task') f.state.tasks.push({ id: 2, job_key: 'job-2', cdk_code: 'CODE-1', status: 'failed' });
        if (scenario === 'older-admin') f.state.admins.push({ ...f.row, request_id: 'request-2', state: 'failed', created_at: '2026-11-18' });
        await assert.rejects(f.save(), error => error.status === 409);
        assert.equal(f.writes.length, 0); await f.save('note'); assert.equal(f.writes.length, 1);
    }
});

test('append-only note revisions change even with identical status and timestamp, and secret remarks are redacted', async () => {
    const f = fixture(), first = await f.get();
    const saved = await f.save('note', { reason: 'api_key=PRIVATE 4242 4242 4242 4242 Bearer SECRETTOKEN' });
    assert.notEqual(saved.revision, first.revision);
    assert.equal(saved.history[0].admin_email, 'admin@example.com');
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|SECRETTOKEN|4242 4242|SECRET_SESSION|key-hash/);
    await assert.rejects(f.save('note', { expectedRevision: first.revision }), error => error.status === 409);
    assert.equal(f.state.history.length, 1);
    assert.equal(f.writes.every(write => write.sql.startsWith('INSERT INTO order_manual_actions')), true);
});

test('legacy orders without platform metadata or CDK keep a manual entry and have only local side effects', async () => {
    const f = fixture();
    Object.assign(f.row, { cdk_code: null, orbitcard_client_order_no: null, orbitcard_state: null, orbitcard_base_url: null,
        orbitcard_card_id: null, orbitcard_plan_type: null, orbitcard_api_key_hash: null });
    f.state.uses = []; f.state.cards = [];
    await f.save('success');
    assert.equal(f.row.status, 'success');
    assert.equal(f.events.some(event => event[0] === 'redemption'), false);
    assert.deepEqual(f.events.find(event => event[0] === 'lock'), ['lock', 'task:job-1']);
});

test('consumed use cannot become a failure even when legacy task status is inconsistent', async () => {
    const f = fixture(); f.state.uses[0].state = 'consumed'; f.state.cards[0].active_job = 'other-order';
    await assert.rejects(f.save('failed'), error => error.status === 409 && /成功/.test(error.message));
    assert.equal(f.writes.length, 0);
});

test('validation requires a supported action, actor, a short reason and a current revision', async () => {
    for (const override of [{ action: 'retry' }, { adminEmail: '' }, { reason: '' }, { reason: 'a'.repeat(256) }, { expectedRevision: '' }]) {
        const f = fixture(); await assert.rejects(f.save('note', override), error => error.status === 400); assert.equal(f.writes.length, 0);
    }
});

for (const kind of ['task', 'admin']) {
    test(`${kind}: uncertain subscriptions allow independent manual results while retaining the original payment`, async () => {
        for (const state of ['submitting', 'pending', 'manual', 'support_locked', 'failed']) for (const action of ['success', 'failed']) {
            const f = fixture(kind); f.setState(state);
            if (kind === 'task') f.row.gpt_api_order_id = 'upstream-1'; else f.row.task_no = 'upstream-1';
            await assertHeld(f, action);
        }
        const f = fixture(kind); f.setState('submitting');
        await f.save('pause');
        await assertHeld(f, 'failed');
        await f.save('note');
        assert.equal(f.state.cards[0].active_job, f.job);
    });
    test(`${kind}: bound platform rejection resolves the original subscription and allows manual delivery`, async () => {
        const f = fixture(kind); f.setState('manual');
        const snapshot = { submission_outcome: 'rejected', platform_code: 59005, status: 'failed',
            client_order_no: kind === 'task' ? f.row.orbitcard_client_order_no : f.row.client_order_no,
            card_id: 7, plan_type: 'gpt-plus' };
        if (kind === 'task') f.row.gpt_api_raw = JSON.stringify(snapshot); else f.row.snapshot = JSON.stringify(snapshot);
        await f.save('success');
        assert.equal(f.state.cards[0].active_job, null); assert.equal(f.state.code.manual_redeemed_by, 'admin@example.com');
        assert.deepEqual(JSON.parse(kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot), snapshot);
    });
    test(`${kind}: revisions cover funding, issues, current card, CDK and peer evidence`, async () => {
        for (const mutate of [f => f.intent('funding'), f => f.intent('issue'), f => { f.state.cards[0].balance = 49; },
            f => { f.state.code.manual_redeemed_at = 'changed'; }, f => {
                f.state.admins.push({ request_id: 'older-failed', cdk_code: 'CODE-1', state: 'failed', created_at: '2026-11-01' });
            }]) {
            const f = fixture(kind), view = await f.get(); mutate(f);
            await assert.rejects(f.save('note', { expectedRevision: view.revision }), error => error.status === 409);
            assert.equal(f.writes.length, 0);
        }
    });
    test(`${kind}: case-insensitive SQL identity aliases cannot create separate audit histories`, async () => {
        const f = fixture(kind), canonicalRow = structuredClone(f.row);
        const service = createService({ ...f.store, runQuery: async (sql, args, options) => {
            if (sql.includes(kind === 'task' ? 'WHERE job_key = ?' : 'WHERE request_id = ?')) return [canonicalRow];
            return f.store.runQuery(sql, args, options);
        } });
        await assert.rejects(service.getOrderManualControl({ kind, id: f.id.toUpperCase() }), error => error.status === 404);
        assert.equal(f.writes.length, 0);
    });
}

test('an active modern task without a card-use reservation cannot settle or release its card', async () => {
    for (const state of ['preparing', 'support_locked', 'failed']) {
        const f = fixture(); f.setState(state); f.state.uses = [];
        await assertHeld(f);
        await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
    }
});

for (const kind of ['task', 'admin']) {
    test(`${kind}: malformed or inconclusive subscription snapshots never imply an unsubmitted order`, async () => {
        for (const snapshot of [null, [], 4, 'value', true, { status: 'processing', client_order_no: 'client-1' },
            { status: 'succeeded', client_order_no: 'client-1' }, { request_error: { message: 'timeout' } }]) {
            const f = fixture(kind); f.setState('support_locked');
            if (kind === 'task') f.row.gpt_api_raw = JSON.stringify(snapshot); else f.row.snapshot = JSON.stringify(snapshot);
            await assertHeld(f);
        }
    });
    test(`${kind}: invalid stored card identifiers cannot be silently treated as no card`, async () => {
        for (const cardId of [-1, 'invalid', '9007199254740993', 0.5]) {
            const f = fixture(kind); f.state.uses = [];
            if (kind === 'task') f.row.orbitcard_card_id = cardId; else f.row.card_id = cardId;
            await assertHeld(f);
            await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
        }
        const f = fixture(kind); f.state.uses = []; f.setState('preparing');
        if (kind === 'task') f.row.orbitcard_card_id = 0; else f.row.card_id = 0;
        f.intent('issue', { state: 'failed', card_id: 'invalid' });
        await assertHeld(f);
        await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
    });
}

test('an active admin order must retain its original card reservation before manual settlement', async () => {
    for (const state of ['preparing', 'support_locked']) for (const activeJob of [null, 'other-order']) {
        const f = fixture('admin'); f.setState(state); f.state.cards[0].active_job = activeJob;
        await assertHeld(f);
        await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
    }
});

const remoteRecord = value => {
    const { local_released_at, local_released_by, local_release_reason, ...remote } = value;
    return remote;
};

for (const kind of ['task', 'admin']) {
    test(`${kind}: explicit local release preserves unresolved funding and issue facts without refund claims`, async () => {
        for (const type of ['funding', 'issue']) for (const state of ['prepared', 'submitting', 'pending', 'unknown']) for (const action of ['success', 'failed']) {
            const f = fixture(kind); f.setState(type === 'funding' ? 'funding_pending' : 'card_pending');
            const intent = f.intent(type, { state, request_body: '{"original":"immutable"}', order_no: 'original-provider-order' });
            const original = structuredClone(intent), snapshot = kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot;
            const view = await f.get(); assert.equal(view.release.allowed, true); assert.equal(view.settlement.allowed, false);
            const saved = await f.save(action, { releaseLocalHold: true });
            assert.equal(saved.manual_result, action); assert.equal(saved.release.released, true);
            assert.equal(saved.history[0].release_local_hold, true); assert.equal(saved.settlement.allowed, false);
            assert.equal(f.row.manual_local_released_by, 'admin@example.com');
            assert.equal(f.state.cards[0].active_job, null);
            if (kind === 'task') { assert.equal(f.state.uses[0].state, 'released'); assert.equal(f.row.status, 'manual'); }
            assert.deepEqual(remoteRecord(intent), original);
            assert.equal(intent.local_released_by, 'admin@example.com');
            assert.equal(kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot, snapshot);
            assert.equal(f.state.code.used_at === null, action === 'failed');
            assert.equal(Boolean(f.state.code.manual_redeemed_at), action === 'success');
            assert.equal(f.events.some(event => event[0] === 'redemption'), action === 'success');
            assert.equal(f.writes.some(write => /SET.*(?:state|request_body|order_no)\s*=/.test(write.sql) && /UPDATE orbitcard_card_(fundings|issues)/.test(write.sql)), false);
        }
    });
    test(`${kind}: explicit release of an uncertain subscription changes only local ownership`, async () => {
        const f = fixture(kind); f.setState('pending');
        const raw = JSON.stringify({ status: 'processing', client_order_no: kind === 'task' ? f.row.orbitcard_client_order_no : f.row.client_order_no });
        if (kind === 'task') { f.row.gpt_api_raw = raw; f.row.gpt_api_order_id = 'original'; }
        else { f.row.snapshot = raw; f.row.task_no = 'original'; }
        const saved = await f.save('success', { releaseLocalHold: true });
        assert.equal(saved.state, 'manual'); assert.equal(saved.settlement.allowed, false); assert.equal(saved.release.released, true);
        assert.equal(kind === 'task' ? f.row.gpt_api_raw : f.row.snapshot, raw);
        assert.equal(kind === 'task' ? f.row.gpt_api_order_id : f.row.task_no, 'original');
        assert.equal(f.state.cards[0].active_job, null);
    });
    test(`${kind}: existing mismatched money records deny explicit release but allow a retained manual result`, async () => {
        for (const type of ['funding', 'issue']) for (const mismatch of [{ scope: 'b'.repeat(64) }, { credential_hash: 'b'.repeat(64) },
            { plan_type: 'pro100' }, { card_id: 99 }, 'duplicate', 'wrong-issue-owner']) {
            if (type === 'funding' && mismatch === 'wrong-issue-owner') continue;
            const f = fixture(kind); f.setState(type === 'funding' ? 'funding_pending' : 'card_pending');
            const intent = f.intent(type, { state: 'pending', ...(typeof mismatch === 'object' ? mismatch : {}) });
            if (mismatch === 'duplicate') f.intent(type, { state: 'pending' });
            if (mismatch === 'wrong-issue-owner') {
                if (kind === 'task') f.row.orbitcard_issue_key = intent.issue_key; else f.row.issue_key = intent.issue_key;
                intent.job_key = 'other-job';
            }
            const original = structuredClone(f.state);
            await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
            assert.deepEqual(f.state, original); assert.equal(f.writes.length, 0);
            await assertHeld(f);
        }
    });
    test(`${kind}: missing original intents do not prevent explicit release of proven local reservations`, async () => {
        for (const state of ['funding_pending', 'card_pending']) {
            const f = fixture(kind); f.setState(state);
            if (state === 'card_pending') { if (kind === 'task') f.row.orbitcard_issue_key = 'missing'; else f.row.issue_key = 'missing'; }
            const saved = await f.save('failed', { releaseLocalHold: true });
            assert.equal(saved.manual_result, 'failed'); assert.equal(saved.state, state); assert.equal(saved.settlement.allowed, false);
            assert.equal(f.state.cards[0].active_job, null); assert.equal(f.state.code.used_at, null);
            assert.equal(f.state.issues.length, 0); assert.equal(f.state.fundings.length, 0);
            assert.equal(f.writes.some(write => /UPDATE orbitcard_card_(issues|fundings)/.test(write.sql)), false);
        }
    });
    test(`${kind}: an unassigned pending card issue can be released locally without fabricating a card`, async () => {
        const f = fixture(kind); f.setState('card_pending');
        if (kind === 'task') f.row.orbitcard_card_id = 0; else f.row.card_id = 0;
        f.state.cards = []; f.state.uses = []; const issue = f.intent('issue', { state: 'pending', card_id: null });
        const saved = await f.save('failed', { releaseLocalHold: true });
        assert.equal(saved.release.released, true); assert.equal(issue.state, 'pending'); assert.equal(issue.card_id, null);
        assert.ok(issue.local_released_at); assert.equal(f.state.cards.length, 0); assert.equal(f.state.uses.length, 0);
    });
    test(`${kind}: manual success may release the remaining hold later without duplicate redemption`, async () => {
        const f = fixture(kind); f.setState('funding_pending'); f.intent('funding', { state: 'pending' });
        await assertHeld(f, 'success');
        const saved = await f.save('success', { releaseLocalHold: true });
        assert.equal(saved.manual_result, 'success'); assert.equal(saved.release.released, true);
        assert.equal(f.state.cards[0].active_job, null); assert.equal(f.events.filter(event => event[0] === 'redemption').length, 1);
        await assert.rejects(f.save('failed', { releaseLocalHold: true }), error => error.status === 409);
    });
    test(`${kind}: repeated release preserves first authorization and never touches a card now owned elsewhere`, async () => {
        const f = fixture(kind); f.setState('funding_pending'); const funding = f.intent('funding', { state: 'pending' });
        await f.save('failed', { releaseLocalHold: true, reason: '第一次释放', adminEmail: 'first@example.com' });
        f.state.cards[0].active_job = 'other-order';
        const firstAt = f.row.manual_local_released_at, intentAt = funding.local_released_at;
        const writeCount = f.writes.length;
        await f.save('failed', { releaseLocalHold: true, reason: '再次确认', adminEmail: 'second@example.com' });
        assert.equal(f.row.manual_local_released_at, firstAt); assert.equal(f.row.manual_local_released_by, 'first@example.com');
        assert.equal(f.row.manual_local_release_reason, '第一次释放'); assert.equal(funding.local_released_at, intentAt);
        assert.equal(funding.local_released_by, 'first@example.com'); assert.equal(f.state.cards[0].active_job, 'other-order');
        assert.equal(f.writes.slice(writeCount).some(write => /UPDATE orbitcard_(managed_cards|card_uses|card_fundings|card_issues)/.test(write.sql)), false);
        await f.save('failed'); assert.equal(f.state.code.used_at, null); assert.equal(f.row.manual_result, 'failed');
    });
    test(`${kind}: failure with explicit release never reverses an existing manual CDK redemption`, async () => {
        const f = fixture(kind); f.setState('funding_pending'); f.intent('funding', { state: 'pending' });
        Object.assign(f.state.code, { manual_redeemed_at: 'first', manual_redeemed_by: 'original', manual_redemption_reason: 'already delivered' });
        const code = structuredClone(f.state.code);
        await f.save('failed', { releaseLocalHold: true });
        assert.deepEqual(f.state.code, code); assert.equal(f.state.cards[0].active_job, null);
    });
    test(`${kind}: local release and all result/audit changes roll back if redemption enqueue fails`, async () => {
        const f = fixture(kind); f.setState('funding_pending'); f.intent('funding', { state: 'pending' });
        const original = structuredClone(f.state); f.failEnqueue();
        await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 500);
        assert.deepEqual(f.state, original); assert.equal(f.writes.length, 0);
    });
    test(`${kind}: manual result stays visible after original funding later reaches a terminal state`, async () => {
        const f = fixture(kind); f.setState('funding_pending'); const funding = f.intent('funding', { state: 'pending' });
        await f.save('success');
        const at = f.row.manual_result_at; funding.state = 'ready';
        const recovered = await f.get();
        assert.equal(recovered.manual_result, 'success'); assert.equal(recovered.manual_result_at, at);
        assert.equal(recovered.settlement.allowed, true); assert.equal(f.state.cards[0].active_job, f.job);
    });
}

for (const kind of ['task', 'admin']) {
    test(`${kind}: saving a manual result closes the business order even while original funds remain pending`, async () => {
        for (const action of ['success', 'failed']) for (const releaseLocalHold of [false, true]) {
            const f = fixture(kind); f.setState('funding_pending');
            const funding = f.intent('funding', { state: 'pending' });
            const saved = await f.save(action, { releaseLocalHold });
            assert.equal(saved.business_status, 'closed');
            assert.equal(saved.business_result, action);
            assert.equal(saved.business_closed_at, f.row.manual_result_at);
            assert.equal(saved.state, 'funding_pending');
            assert.equal(funding.state, 'pending');
            assert.match(f.row.message, /订单已关闭/);
            assert.equal(saved.actions.find(item => item.value === 'pause').enabled, false);
            await assert.rejects(f.save('pause'), error => error.status === 409);
            const noted = await f.save('note');
            assert.equal(noted.business_status, 'closed');
            assert.equal(noted.business_result, action);
            assert.equal(noted.business_closed_at, saved.business_closed_at);
        }
    });
}

test('local release requires an explicit strict boolean on a manual result action', async () => {
    for (const releaseLocalHold of ['true', 'false', 1, 0, null, [], {}]) {
        const f = fixture(); await assert.rejects(f.save('success', { releaseLocalHold }), error => error.status === 400); assert.equal(f.writes.length, 0);
    }
    for (const action of ['note', 'pause']) {
        const f = fixture(); await assert.rejects(f.save(action, { releaseLocalHold: true }), error => error.status === 400); assert.equal(f.writes.length, 0);
    }
    const f = fixture(); await assert.rejects(f.save('success', { releaseLocalHold: true, release_local_hold: false }), error => error.status === 400);
});

test('an earlier manual action without release is not evidence that an admin card was settled', async () => {
    const f = fixture('admin'); f.setState('funding_pending'); f.intent('funding', { state: 'pending' });
    await f.save('success'); f.state.cards[0].active_job = 'other-order';
    const view = await f.get(); assert.equal(view.actions.find(action => action.value === 'success').enabled, true); assert.equal(view.release.allowed, false);
    await assert.rejects(f.save('success', { releaseLocalHold: true }), error => error.status === 409);
    assert.equal(f.state.cards[0].active_job, 'other-order'); assert.equal(Boolean(f.row.manual_local_released_at), false);
});

test('local release includes the original owned replacement issue without releasing another assigned card', async () => {
    const f = fixture(); f.setState('funding_pending'); f.intent('funding', { state: 'pending' }); f.intent('issue');
    const replacement = f.intent('issue', { issue_key: 'replacement-1', job_key: null, replacement_for_job_key: f.job,
        replacement_for_card_id: 7, card_id: 99, state: 'pending', request_body: 'original replacement request' });
    f.state.cards.push({ scope, card_id: 99, active_job: 'other-order' });
    const original = structuredClone(replacement);
    await f.save('success', { releaseLocalHold: true });
    assert.ok(replacement.local_released_at); assert.deepEqual(remoteRecord(replacement), original);
    assert.equal(f.state.cards[0].active_job, null); assert.equal(f.state.cards[1].active_job, 'other-order');
});

test('current self-service orders can be handled while an older released admin order still reconciles', async () => {
    const f = fixture(); f.row.created_at = '2026-11-17 12:00:00';
    f.state.admins.push({ request_id: 'old-admin', cdk_code: 'CODE-1', state: 'funding_pending',
        created_at: '2026-11-16 12:00:00', manual_local_released_at: '2026-11-16 13:00:00' });
    await f.save('success'); assert.equal(f.row.manual_result, 'success');
    assert.equal(f.state.admins[0].state, 'funding_pending');
});

test('current admin orders can be handled after a released self-service order without modifying it', async () => {
    const f = fixture('admin');
    const previous = { id: 1, job_key: 'old-task', cdk_code: 'CODE-1', status: 'manual', orbitcard_state: 'funding_pending',
        created_at: '2026-11-16 12:00:00', manual_local_released_at: '2026-11-16 13:00:00' };
    f.state.tasks.push(previous); const original = structuredClone(previous);
    await f.save('success'); assert.equal(f.row.manual_result, 'success'); assert.deepEqual(previous, original);
});

test('released historical orders cannot reclaim a CDK from a newer cross-kind order', async () => {
    for (const kind of ['task', 'admin']) for (const peerReleased of [false, true]) {
        const f = fixture(kind); f.row.created_at = '2026-11-16 12:00:00'; f.row.manual_local_released_at = '2026-11-16 13:00:00';
        const newer = { cdk_code: 'CODE-1', created_at: '2026-11-17 12:00:00',
            manual_local_released_at: peerReleased ? '2026-11-17 13:00:00' : null };
        if (kind === 'task') f.state.admins.push({ ...newer, request_id: 'new-admin', state: peerReleased ? 'failed' : 'pending' });
        else f.state.tasks.push({ ...newer, id: 2, job_key: 'new-task', status: peerReleased ? 'failed' : 'running', orbitcard_state: 'pending' });
        await assert.rejects(f.save('success'), error => error.status === 409); assert.equal(f.writes.length, 0);
        await f.save('note'); assert.equal(f.writes.length, 1);
    }
});

test('immutable first release timestamps disambiguate orders created within the same second', async () => {
    const f = fixture('admin'); f.row.created_at = '2026-11-17 12:00:00'; f.row.manual_local_released_at = '2026-11-17 12:00:00.900';
    f.state.tasks.push({ id: 1, job_key: 'old-task', cdk_code: 'CODE-1', created_at: '2026-11-17 12:00:00',
        manual_local_released_at: '2026-11-17 12:00:00.100' });
    await f.save('success'); assert.equal(f.row.manual_result, 'success');
});

test('released orders include the original reconciliation lock while still protecting current CDK ownership', async () => {
    for (const kind of ['task', 'admin']) {
        const f = fixture(kind); f.row.manual_local_released_at = '2026-11-17 12:00:00';
        const attempted = [];
        f.store.acquirePaymentLock = async keys => { attempted.push(keys); return null; };
        await assert.rejects(f.save('success'), error => error.status === 409 && /查单/.test(error.message));
        assert.equal(f.writes.length, 0);
        assert.ok(attempted[0].includes(`reconcile:${f.job.toLowerCase()}`));
        assert.ok(attempted[0].includes('cdk:code-1'));
        if (kind === 'admin') assert.ok(attempted[0].includes('manual:request-1'));
        await f.save('note'); assert.equal(f.writes.length, 1); assert.equal(attempted.length, 1);
    }
});
