'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const createAutomation = require('../src/payments/payment-automation');
const createTaskStore = require('../src/db/orbitcard-cdk-store');
const createManualStore = require('../src/db/orbitcard-manual-store');
const createCardStore = require('../src/db/orbitcard-card-store');
const { cardScope } = require('../src/orbitcard/orbitcard-card-policy');
const cfg = { enabled: true, base_url: 'https://release.test', api_key: 'release-test-key' };
const scope = cardScope(cfg.base_url), credential = crypto.createHash('sha256').update(cfg.api_key).digest('hex');
const released = '2026-11-18 00:00:00';
function taskRow() {
    return { job_key: 'old-job', cdk_code: 'CODE-1', status: 'manual', orbitcard_state: 'manual',
        orbitcard_client_order_no: 'old-client', orbitcard_card_id: 7, orbitcard_plan_type: 'plus',
        orbitcard_base_url: cfg.base_url, orbitcard_api_key_hash: credential, orbitcard_email: 'customer@example.test',
        gpt_api_order_id: 'OLD-SUB', manual_result: 'failed', manual_local_released_at: released };
}
function snapshot(row, outcome = 'failed') {
    return { task_no: row.gpt_api_order_id || row.task_no, client_order_no: row.orbitcard_client_order_no || row.client_order_no,
        card_id: 7, plan_type: 'gpt-plus', status: outcome, upstream_status: outcome,
        subscription_succeeded: outcome === 'succeeded', query_source: 'upstream', result_source: 'upstream', failureCode: 'card_declined' };
}
function intent(job, extra = {}) {
    return { job_key: job, scope, plan_type: 'plus', card_id: 7, credential_hash: credential,
        state: 'ready', funding_key: 'original-funding', order_no: 'OLD-FUND', local_released_at: released, ...extra };
}
function storage(row, { manual = false, fundings = [], issues = [] } = {}) {
    const writes = [], reads = [], card = { scope, card_id: 7, active_job: 'new-job' };
    const code = { cdk_code: 'CODE-1', is_active: 1, used_at: 'new-reservation' };
    const store = { withTransaction: async fn => fn({ fixture: true }),
        runQuery: async (sql, args) => {
            reads.push(sql);
            if (sql.includes('FROM cdk_codes')) return [{ ...code }];
            if (sql.includes('FROM orbitcard_admin_orders')) return manual ? [{ ...row }] : [];
            if (sql.includes('FROM task_logs')) return sql.includes('ORDER BY id DESC') ? [{ job_key: 'new-job' }] : [{ ...row }];
            if (sql.includes('FROM orbitcard_card_fundings')) return structuredClone(fundings);
            if (sql.includes('FROM orbitcard_card_issues')) return structuredClone(issues);
            if (sql.includes('FROM orbitcard_managed_cards')) return [{ ...card }];
            if (sql.includes('FROM orbitcard_card_uses')) return [{ job_key: row.job_key, scope, card_id: 7, plan_type: 'plus', state: 'released' }];
            throw Error('Unexpected query: ' + sql);
        },
        runExecute: async (sql, args) => { writes.push({ sql, args }); return { affectedRows: 1 }; },
        settleCardUse: async () => assert.fail('Released order must not settle a card use'),
        enqueueRedemption: async () => assert.fail('Released order must not redeem a reused CDK'),
        createTaskLog: async () => assert.fail('Released order must not create a payment retry') };
    return { row, store, writes, reads, card, code };
}

for (const manual of [false, true]) test(`${manual ? 'admin' : 'task'} release permanently stops new payments while retaining original reconciliation`, async () => {
    const row = manual ? { client_order_no: 'manual-old', request_id: 'old', cdk_code: 'CODE-1', state: 'preparing' } : taskRow();
    row.manual_local_released_at = released;
    const code = { is_active: 1, used_at: 'new-order' };
    const automation = createAutomation({ runQuery: async sql => [sql.includes('cdk_codes') ? code : row] });
    const job = manual ? row.client_order_no : row.job_key, owner = await automation.paymentOwner(job);
    assert.equal(owner.allowed, false); assert.equal(owner.canReconcileFunding, true); assert.equal(owner.canReconcileIssue, true);
    assert.deepEqual(owner.keys, [`reconcile:${job}`]);
    await assert.rejects(automation.assertPaymentAllowed(job), /停止/);
    await automation.assertFundingReconciliationAllowed(job); await automation.assertIssueReconciliationAllowed(job);
    assert.equal(code.used_at, 'new-order');
});

test('the later owner remains payable and either manual marker prevents automatic retries', async () => {
    const row = { ...taskRow(), job_key: 'new-job', status: 'running', orbitcard_state: 'preparing', manual_result: null, manual_local_released_at: null };
    const automation = createAutomation({ runQuery: async sql => [sql.includes('cdk_codes') ? { is_active: 1 } : row] });
    assert.equal((await automation.paymentOwner('new-job')).allowed, true);
    Object.assign(row, { orbitcard_state: 'retry_waiting', orbitcard_retry_attempt_no: 1, gpt_api_raw: JSON.stringify(snapshot(row)) });
    const retryable = require('../src/payments/payment-retry-policy').retryableTask;
    assert.equal(retryable(row), true);
    row.manual_result = 'failed'; assert.equal(retryable(row), false);
    row.manual_result = null; row.manual_local_released_at = released; assert.equal(retryable(row), false);
});

test('late task success or failure updates only its original record after CDK/card reassignment', async () => {
    for (const outcome of ['succeeded', 'failed']) {
        const f = storage(taskRow()), store = createTaskStore(f.store), raw = JSON.stringify(snapshot(f.row, outcome));
        const result = outcome === 'succeeded'
            ? await store.settleOrbitcardTask('old-job', { status: 'success', orbitcardState: 'success', gptApiOrderId: 'OLD-SUB', gptApiRaw: raw })
            : await store.recordOrbitcardPaymentFailure('old-job', { clientOrderNo: 'old-client', cardId: 7, orderId: 'OLD-SUB', raw });
        assert.equal(result.applied, true); assert.equal(result.retry, false);
        assert.equal(f.writes.length, 1); assert.match(f.writes[0].sql, /^UPDATE task_logs/);
        assert.equal(f.card.active_job, 'new-job'); assert.equal(f.code.used_at, 'new-reservation');
        assert.equal(f.row.manual_result, 'failed'); assert.equal(f.row.manual_local_released_at, released);
    }
});

test('released task rejects mismatching late evidence and cannot recreate a retry', async () => {
    const row = taskRow(), f = storage(row), store = createTaskStore(f.store);
    assert.equal((await store.settleOrbitcardTask(row.job_key, { status: 'success', orbitcardState: 'success',
        gptApiRaw: JSON.stringify({ ...snapshot(row, 'succeeded'), client_order_no: 'other-client' }) })).applied, false);
    Object.assign(row, { status: 'running', orbitcard_state: 'retry_waiting' });
    assert.equal(await store.claimOrbitcardRetry(row.job_key, { email: row.orbitcard_email, baseUrl: cfg.base_url, apiKeyHash: credential }), null);
    assert.deepEqual(f.writes, []);
});

test('released original provider success cannot be downgraded by stale fee queries', async () => {
    for (const outcome of ['pending', 'failed']) {
        const row = { ...taskRow(), status: 'success', orbitcard_state: 'success', manual_result: 'success' };
        row.gpt_api_raw = JSON.stringify(snapshot(row, 'succeeded'));
        const f = storage(row), store = createTaskStore(f.store);
        const input = { status: outcome, orbitcardState: outcome, gptApiOrderId: row.gpt_api_order_id,
            gptApiRaw: JSON.stringify(snapshot(row, outcome)) };
        assert.equal((await store.settleOrbitcardTask(row.job_key, input)).applied, false);
        assert.deepEqual(f.writes, []);
        // An operator's success alone must still allow recording provider truth.
        row.gpt_api_raw = null;
        assert.equal((await store.settleOrbitcardTask(row.job_key, input)).applied, true);
        assert.equal(f.writes.length, 1);
    }
});

test('customer status retains the latest released order until a newer order exists', async () => {
    const rows = [{ ...taskRow(), id: 1, manual_result: 'success' }];
    const store = createTaskStore({ runQuery: async (sql, args) => {
        assert.equal(args[0], 'CODE-1');
        assert.match(sql, /ORDER BY t\.id DESC LIMIT 1/);
        assert.doesNotMatch(sql, /manual_local_released_at IS NULL/);
        return [rows.at(-1)];
    } });
    assert.equal((await store.getOrbitcardTaskByCdk('CODE-1')).job_key, 'old-job');
    rows.push({ id: 2, job_key: 'new-job', manual_local_released_at: null });
    assert.equal((await store.getOrbitcardTaskByCdk('CODE-1')).job_key, 'new-job');
});

test('released task funding review completes without reclaiming the reused CDK or card', async () => {
    const row = { ...taskRow(), orbitcard_state: 'funding_pending', gpt_api_order_id: null };
    const f = storage(row, { fundings: [intent(row.job_key)] });
    const result = await createTaskStore(f.store).settleOrbitcardTask(row.job_key, { status: 'retry', orbitcardState: 'rejected',
        expectedState: 'funding_pending', expectedClientOrderNo: row.orbitcard_client_order_no,
        message: 'CDK 已释放，请重新验证继续充值' });
    assert.equal(result.applied, true); assert.equal(f.writes.length, 1); assert.match(f.writes[0].sql, /^UPDATE task_logs/);
    assert.equal(f.writes[0].args[2], '原平台或资金记录已核对；此前人工结果和本地释放记录保留');
});

function manualRow() {
    return { request_id: 'old-admin', client_order_no: 'manual-old', cdk_code: 'CODE-1', state: 'manual', scope,
        api_key_hash: credential, card_id: 7, plan_type: 'gpt-plus', task_no: 'OLD-SUB',
        target_email: 'customer@example.test', manual_result: 'failed', manual_local_released_at: released };
}
test('late administrator subscription results never release another owner or notify redemption', async () => {
    for (const outcome of ['succeeded', 'failed']) {
        const row = manualRow(), f = storage(row, { manual: true });
        await createManualStore(f.store).settleManualOrder(row.request_id, { state: outcome === 'succeeded' ? 'success' : 'failed',
            taskNo: row.task_no, snapshot: snapshot(row, outcome), retryAllowed: true, expectedClientOrderNo: row.client_order_no });
        assert.equal(f.writes.length, 1); assert.match(f.writes[0].sql, /^UPDATE orbitcard_admin_orders/);
        assert.equal(f.card.active_job, 'new-job'); assert.equal(f.code.used_at, 'new-reservation');
    }
});
test('administrator original funding and issue completion only updates the released old order', async () => {
    for (const type of ['funding', 'issue']) {
        const row = { ...manualRow(), state: type === 'funding' ? 'funding_pending' : 'card_pending', task_no: null };
        const f = storage(row, { manual: true, fundings: type === 'funding' ? [intent(row.client_order_no)] : [],
            issues: type === 'issue' ? [intent(row.client_order_no, { issue_key: 'original-issue' })] : [] });
        const store = createManualStore(f.store);
        if (type === 'funding') await store.releaseManualFunding(row.request_id, row.client_order_no, 'confirmed');
        else await store.failManualPreparation(row.request_id, row.client_order_no, 'confirmed');
        assert.equal(f.writes.length, 1); assert.match(f.writes[0].sql, /^UPDATE orbitcard_admin_orders/);
        assert.equal(f.card.active_job, 'new-job'); assert.equal(f.code.used_at, 'new-reservation');
    }
});
test('manual failure without explicit release retains its CDK when original funding finishes', async () => {
    for (const manual of [false, true]) {
        const row = manual ? { ...manualRow(), state: 'funding_review', task_no: null, manual_local_released_at: null }
            : { ...taskRow(), orbitcard_state: 'funding_review', gpt_api_order_id: null, manual_local_released_at: null };
        const job = manual ? row.client_order_no : row.job_key;
        const f = storage(row, { manual, fundings: [intent(job, { local_released_at: null })] });
        f.card.active_job = job;
        const query = f.store.runQuery;
        f.store.runQuery = (sql, args) => sql.includes('FROM task_logs') && sql.includes('ORDER BY id DESC')
            ? Promise.resolve([{ job_key: job }]) : query(sql, args);
        f.store.settleCardUse = async () => {};
        if (manual) await createManualStore(f.store).releaseManualFunding(row.request_id, job, 'confirmed');
        else assert.equal((await createTaskStore(f.store).settleOrbitcardTask(job, { status: 'retry', orbitcardState: 'rejected',
            expectedState: 'funding_review', expectedClientOrderNo: row.orbitcard_client_order_no })).applied, true);
        assert.equal(f.writes.some(write => /UPDATE cdk_codes SET used_at = NULL/.test(write.sql)), false);
        assert.ok(f.writes.some(write => write.args.includes('support_locked')));
    }
});

test('a new task ignores explicitly released blockers while an already manually redeemed CDK stays unusable', async () => {
    const code = { cdk_code: 'CODE-1', is_active: 1, type: '自助', plan_type: 'plus', used_at: null }, writes = [];
    const store = createTaskStore({ withTransaction: async fn => fn({}), createTaskLog: async () => ({ jobKey: 'new-job' }),
        runQuery: async sql => {
            if (sql.includes('FROM cdk_codes')) return [code];
            assert.match(sql, /manual_local_released_at IS NULL/);
            return []; // The only previous task has an immutable release marker.
        }, runExecute: async (sql, args) => { writes.push({ sql, args }); return { affectedRows: 1 }; } });
    assert.equal((await store.createOrbitcardTask({ cdk: 'CODE-1', planType: 'plus', email: 'customer@example.test', baseUrl: cfg.base_url, apiKeyHash: credential })).jobKey, 'new-job');
    code.manual_redeemed_at = released; writes.length = 0;
    assert.equal(await store.createOrbitcardTask({ cdk: 'CODE-1', planType: 'plus', email: 'customer@example.test', baseUrl: cfg.base_url }), null);
    assert.deepEqual(writes, []);
});
test('released reservation and funding creation are denied even if an old preparation state survives', async () => {
    const row = { ...taskRow(), orbitcard_state: 'preparing' }, f = storage(row);
    const store = createCardStore({ ...f.store, openLockConnection: async () => assert.fail('No connection required') });
    const methods = store.cardMethods(cfg.base_url);
    await assert.rejects(methods.reserveCard(7, row.job_key, 'plus'), /不能预占/);
    await assert.rejects(methods.createFunding(intent(row.job_key)), /不能创建新的补款/);
    await store.settleCardUse(row.job_key, 'success', { connection: {} });
    assert.deepEqual(f.writes, []);
});

test('released funding confirms the exact original flow without using a later card balance or resending money', async () => {
    const calls = [], updates = [], funding = intent('old-job', { state: 'pending', amount: '20.00', target_balance: '21.00',
        request_body: JSON.stringify({ card_id: 7, amount: '20.00' }) });
    const service = require('../src/orbitcard/orbitcard-funding-service')({ now: () => 100000, audit() {},
        assertPaymentAllowed: async () => assert.fail('No new payments'), assertReconciliationAllowed: async () => {},
        cardsApi: { cardDetail: async () => assert.fail('New owner balance must not gate old funding') },
        api: { request: async (_cfg, operation) => { calls.push(operation); assert.equal(operation, 'getCardFlow');
            return { success: true, status: 200, data: { list: [{ order_no: 'OLD-FUND', card_id: 7, amount: '20.00', status: 'success' }], total: 1 } }; } } });
    const locked = { deferFunding: async () => {}, updateFunding: async (_key, patch) => updates.push(patch), syncCards: async () => assert.fail('Do not mutate reused card') };
    assert.deepEqual(await service.confirm(cfg, locked, funding, { readOnly: true, localReleased: true }), { card_id: 7 });
    assert.deepEqual(calls, ['getCardFlow']); assert.equal(updates.at(-1).state, 'ready');
    calls.length = 0; updates.length = 0;
    await assert.rejects(service.confirm(cfg, locked, { ...funding, order_no: null, state: 'prepared' },
        { readOnly: true, releaseOnly: true, localReleased: true }), /缺少平台订单号/);
    assert.deepEqual(calls, []); assert.deepEqual(updates, []);
});

function load(filename, mocks) {
    const file = path.resolve(__dirname, '..', filename), realRequire = createRequire(file), module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(name => mocks[name] || realRequire(name), module, module.exports);
    return module.exports;
}
test('released original issue uses only its saved key and no released failure creates replacement cards', async () => {
    for (const initialState of ['pending', 'prepared']) {
    const body = { product_code: 'product-1', amount: '20.00', quantity: 1 }, calls = [];
    const issue = intent('old-job', { issue_key: 'ORIGINAL-KEY', funding_key: undefined, order_no: 'OLD-ISSUE', state: initialState,
        amount: '20.00', product_code: 'product-1', request_body: JSON.stringify(body) });
    const card = { scope, card_id: 7, active_job: 'new-job', provider_status: 'ACTIVE' };
    const disabled = { scope, card_id: 8, active_job: null, disabled_at: released, disabled_job_key: 'old-job', disabled_code: 'card_declined' };
    const locked = { listFundings: async () => [], pendingIssue: async (plan, includeReleased) => includeReleased && plan === 'plus' && ['pending','prepared'].includes(issue.state) ? issue : null,
        listCards: async () => [card, disabled], updateIssue: async (_key, patch) => Object.assign(issue, patch),
        syncCards: async () => {}, completeIssue: async () => { issue.state = 'ready'; },
        replacementForCard: async () => assert.fail('Released failure must not create a replacement'),
        createManualIssue: async () => assert.fail('No new issue') };
    const owner = { allowed: false, localReleased: true, canReconcileIssue: true, canReconcileFunding: true, state: 'card_pending', keys: ['reconcile:old-job'] };
    const store = { paymentOwner: async () => owner, withCardAllocationLock: async (_base, fn) => fn(locked),
        acquirePaymentLock: async () => ({ assertOwned: async () => {}, release: async () => {} }),
        assertIssueReconciliationAllowed: async () => {}, assertPaymentAllowed: async () => assert.fail('No payment authorization') };
    const api = { request: async (_config, operation, requestBody, key) => { calls.push({ operation, body: requestBody, key });
        return { success: true, status: 200, data: { order_no: 'OLD-ISSUE', card_id: 7, status: 'success', completed: true } }; } };
    const cardsApi = { issueResult: data => ({ ...data, fees: {}, retryAfterMs: 0 }),
        cardDetail: async () => ({ card_id: 7, product_code: 'product-1', provider_status: 'ACTIVE' }) };
    const create = load('src/orbitcard/orbitcard-card-service.js', { './orbitcard-client': api, './orbitcard-cards-client': cardsApi });
    const service = create({ store, audit() {}, now: () => 100000 });
    await service.recover(cfg);
    assert.deepEqual(calls, []); assert.equal(issue.state, initialState);
    await service.recover(cfg, { confirmIssues: true });
    assert.equal(issue.state, 'ready'); assert.equal(card.active_job, 'new-job');
    assert.deepEqual(calls, [{ operation: 'createCard', body, key: 'ORIGINAL-KEY' }]);
    }
});

test('scheduled recovery retains released historical tasks even after a later task owns the CDK', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/db/mysql-store.js'), 'utf8');
    const start = source.indexOf('async function listRecoverableOrbitcardTasks(');
    const body = source.slice(start, source.indexOf('async function noteQueryAttempt(', start));
    const rows = [{ id: 1, manual_local_released_at: released, orbitcard_state: 'manual' },
        { id: 2, manual_local_released_at: null, orbitcard_state: 'pending' }];
    const select = new Function('runQuery', body + '\nreturn listRecoverableOrbitcardTasks;')(async (sql, args) => {
        assert.match(sql, /AND \(t\.manual_local_released_at IS NOT NULL OR t\.id = \(SELECT MAX\(id\)/);
        assert.match(sql, /c\.is_active = 1 OR t\.manual_local_released_at IS NOT NULL/);
        assert.equal(args[0], 50);
        return rows;
    });
    assert.deepEqual(await select(), rows);
});

test('CDK editing ignores released old results but respects current occupancy and manual redemption', async () => {
    const create = require('../src/payments/cdk-status-service');
    for (const state of ['manual', 'success', 'preparing']) for (const current of ['unused', 'processing', 'redeemed']) {
        const code = { id: 1, cdk_code: 'CODE-1', is_active: 1, used_at: current === 'processing' ? 'new-owner' : null,
            manual_redeemed_at: current === 'redeemed' ? released : null };
        const task = { status: state, orbitcard_state: state, manual_local_released_at: released };
        const order = { state, manual_local_released_at: released };
        const update = create({ withTransaction: async fn => fn({}),
            acquirePaymentLock: async () => ({ assertOwned: async () => {}, release: async () => {} }),
            runQuery: async sql => [sql.includes('FROM cdk_codes') ? code : sql.includes('FROM task_logs') ? task : order],
            runExecute: async () => assert.fail('Unchanged CDK edit must not mutate'),
            enqueueRedemption: async () => assert.fail('No new manual redemption requested') });
        const result = await update({ cdk: code.cdk_code, shipped: false, expectedStatus: current, reason: '核对当前使用状态', adminEmail: 'admin@example.test' });
        assert.equal(result.status, current); assert.equal(result.changed, false);
        if (current === 'unused') {
            Object.assign(task, { status: 'running', orbitcard_state: 'pending', manual_local_released_at: null });
            assert.equal((await update({ cdk: code.cdk_code, shipped: false, expectedStatus: 'processing', reason: '核对新订单', adminEmail: 'admin@example.test' })).status, 'processing');
        }
    }
});

const replacementCard = { card_id: 9, product_code: 'product-1', provider_status: 'ACTIVE', currency: 'USD', balance_amount: '20.00' };
const selectionStoreMethods = {
    fundingForJob: async () => null, issueForJob: async () => null,
    reserveCard: async () => replacementCard
};
const selectionCardReads = {
    listCards: async () => [{ card_id: 8, provider_status: 'ACTIVE' }],
    cardDetailsInBatches: async (_cfg, ids) => ids.includes(9) ? [replacementCard] : []
};
const selectionConfig = { ...cfg, orbitcard_plan_prices: { plus: '20.00' } };

function replacementRace({ existing = false, releaseBeforeLock = false } = {}) {
    let held = false, isReleased = false, generated = 0, issue = existing ? {
        issue_key: 'SAVED-KEY', scope, job_key: null, replacement_for_job_key: 'old-job', replacement_for_card_id: 8,
        plan_type: 'plus', state: 'prepared', product_code: 'product-1', amount: '20.00', credential_hash: credential,
        request_body: JSON.stringify({ product_code: 'product-1', amount: '20.00', quantity: 1 }) } : null;
    const calls = [], deniedReleases = [];
    const locked = { ...selectionStoreMethods, listFundings: async () => [], pendingIssue: async plan => issue && plan === 'plus' && !['ready','failed'].includes(issue.state) ? issue : null,
        listCards: async () => [{ card_id: 8, disabled_at: released, disabled_code: 'card_declined', disabled_job_key: 'old-job', active_job: null },
            ...(issue?.state === 'ready' ? [{ ...replacementCard, successful_order_count: 0 }] : [])],
        replacementForCard: async () => issue, listIssues: async () => issue ? [issue] : [],
        createManualIssue: async input => { assert.equal(held, true); generated++; issue = { ...input, scope, state: 'prepared' }; return issue; },
        updateIssue: async (_key, patch) => Object.assign(issue, patch), syncCards: async () => {},
        completeIssue: async () => { issue.state = 'ready'; } };
    const store = { cardMethods: () => locked, withCardAllocationLock: async (_url, fn) => fn(locked),
        paymentOwner: async job => job === 'old-job' ? { allowed: false, keys: ['cdk:code-1'], localReleased: isReleased, canReconcileIssue: isReleased }
            : { allowed: true, keys: [] },
        acquirePaymentLock: async () => {
            if (held) return null;
            if (releaseBeforeLock) isReleased = true;
            held = true;
            return { assertOwned: async () => assert.equal(held, true), release: async () => { held = false; } };
        }, assertPaymentAllowed: async job => assert.ok(job == null || job === 'new-job'), assertIssueReconciliationAllowed: async () => {} };
    const attemptRelease = async () => {
        const guard = await store.acquirePaymentLock(['cdk:code-1']);
        if (!guard) { deniedReleases.push(true); return false; }
        isReleased = true; await guard.release(); return true;
    };
    const api = { request: async (_config, operation, body, key) => {
        assert.equal(held, true); assert.equal(await attemptRelease(), false);
        calls.push({ operation, body, key });
        if (operation === 'getAccountBalance') return { success: true, data: { available_balance: '100.00' } };
        assert.equal(operation, 'createCard');
        return { success: true, status: 200, data: { order_no: 'ORIGINAL-OPEN', card_id: 9, status: 'success', completed: true } };
    } };
    const cardsApi = { ...selectionCardReads, products: async () => {
        assert.equal(held, true); assert.equal(await attemptRelease(), false);
        return [{ product_code: 'product-1' }];
    }, chooseOpeningProduct: () => ({ product_code: 'product-1', amount: '20.00' }),
    createCardBody: selected => ({ ...selected, quantity: 1 }),
    cardDetail: async () => replacementCard,
    issueResult: data => ({ ...data, fees: {}, retryAfterMs: 0 }) };
    const create = load('src/orbitcard/orbitcard-card-service.js', { './orbitcard-client': api, './orbitcard-cards-client': cardsApi });
    return { service: create({ store, audit() {}, now: () => 100000 }), calls, deniedReleases,
        attemptRelease, generated: () => generated, held: () => held };
}
test('replacement creation and saved-intent submission hold the failed order lock across all awaits', async () => {
    for (const existing of [false, true]) {
        const f = replacementRace({ existing });
        assert.equal(await f.service.allocate(selectionConfig, 'new-job', 'plus'), 9);
        assert.ok(f.deniedReleases.length > 0); assert.equal(f.held(), false);
        assert.equal(f.generated(), existing ? 0 : 1);
        assert.equal(f.calls.filter(call => call.operation === 'createCard').length, 1);
        assert.equal(await f.attemptRelease(), true);
        f.calls.length = 0;
        await f.service.recover(cfg);
        assert.deepEqual(f.calls, []);
    }
});
test('a release committed between replacement discovery and execution-lock acquisition prevents every POST', async () => {
    for (const existing of [false, true]) {
        const f = replacementRace({ existing, releaseBeforeLock: true });
        await assert.rejects(f.service.allocate(selectionConfig, 'new-job', 'plus'), /没有可用|原补开/);
        assert.deepEqual(f.calls, []); assert.equal(f.generated(), 0); assert.equal(f.held(), false);
    }
});
test('old administrator attempt aliases share the current request lock and release marker', async () => {
    const id = '36aad0bb-5eb7-4771-93f5-1ebd049b29e0', old = `manual-${id}`;
    const row = { request_id: id, client_order_no: `${old}-attempt-2`, cdk_code: 'CODE-1', state: 'preparing' };
    const automation = createAutomation({ runQuery: async sql => sql.includes('cdk_codes') ? [{ is_active: 1 }]
        : sql.includes('request_id') ? [row] : [] });
    let owner = await automation.paymentOwner(old);
    assert.equal(owner.allowed, false); assert.deepEqual(owner.keys, [`manual:${id}`, 'cdk:code-1']);
    row.manual_result = 'failed';
    owner = await automation.paymentOwner(old);
    assert.equal(owner.manualClosed, true); assert.equal(owner.localReleased, false); assert.equal(owner.canReconcileIssue, true);
    row.manual_local_released_at = released;
    owner = await automation.paymentOwner(old);
    assert.equal(owner.localReleased, true); assert.equal(owner.canReconcileIssue, true); assert.equal(owner.allowed, false);
});
test('historical tasks without a CDK share the manual control task lock', async () => {
    const row = { job_key: 'OLD-JOB', orbitcard_state: 'failed' };
    const automation = createAutomation({ runQuery: async () => [row] });
    assert.deepEqual((await automation.paymentOwner(row.job_key)).keys, ['task:old-job']);
});
test('manual results still permit original successful subscription fee reconciliation', async () => {
    for (const localRelease of [null, released]) {
        const row = { ...taskRow(), status: 'success', orbitcard_state: 'success', manual_result: 'success', manual_local_released_at: localRelease };
        let queries = 0;
        const recovery = require('../src/payments/order-recovery')({ activeJobs: new Set(), audit() {},
            store: { acquirePaymentLock: async () => ({ assertOwned: async () => {}, release: async () => {} }),
                getTaskStatus: async () => row, getGptApiConfig: async () => cfg },
            query: { refresh: async ({ task }) => { assert.equal(task.job_key, row.job_key); queries++; return { success: true, applied: false }; } } });
        await recovery.refreshTask(row);
        assert.equal(queries, 1);
    }
});

function closedIssueFixture({ manualResult = 'failed', existing = false, orderNo = null, bound = false,
    closeBeforeLock = false, closeDuringProducts = false } = {}) {
    const owner = { ...taskRow(), orbitcard_state: 'support_locked', manual_result: manualResult, manual_local_released_at: null };
    let held = false, generated = 0, deniedClosures = 0;
    let issue = existing ? { issue_key: 'SAVED-OPEN-KEY', scope, plan_type: 'plus', state: 'prepared',
        job_key: bound ? owner.job_key : null, replacement_for_job_key: bound ? null : owner.job_key,
        replacement_for_card_id: bound ? null : 8, order_no: orderNo,
        credential_hash: credential, product_code: 'product-1', amount: '20.00',
        request_body: JSON.stringify({ product_code: 'product-1', amount: '20.00', quantity: 1 }) } : null;
    const calls = [], patches = [];
    const locked = {
        ...selectionStoreMethods,
        listFundings: async () => [],
        pendingIssue: async plan => plan === 'plus' && issue && !['ready', 'failed'].includes(issue.state) ? issue : null,
        listCards: async () => [{ card_id: 8, disabled_at: released, disabled_code: 'card_declined', disabled_job_key: owner.job_key },
            ...(issue?.state === 'ready' ? [{ ...replacementCard, successful_order_count: 0 }] : [])],
        listIssues: async () => issue ? [issue] : [], replacementForCard: async () => issue,
        createManualIssue: async input => {
            if (input.replacement_for_job_key) assert.equal(held, true);
            generated++; issue = { ...input, scope, state: 'prepared' }; return issue;
        },
        updateIssue: async (_key, patch) => { patches.push(patch); Object.assign(issue, patch); },
        syncCards: async () => {}, completeIssue: async () => { issue.state = 'ready'; }
    };
    const automation = createAutomation({ runQuery: async sql => sql.includes('FROM cdk_codes') ? [{ is_active: 1 }] : [owner] });
    const store = { ...automation, cardMethods: () => locked, withCardAllocationLock: async (_base, fn) => fn(locked),
        assertPaymentAllowed: async job => { if (job !== 'new-job') await automation.assertPaymentAllowed(job); },
        paymentOwner: async job => job === 'new-job' ? { allowed: true, keys: [] } : automation.paymentOwner(job),
        acquirePaymentLock: async keys => {
            assert.deepEqual(keys, ['cdk:code-1']);
            if (held) return null;
            if (closeBeforeLock) owner.manual_result = 'failed';
            held = true;
            return { assertOwned: async () => assert.equal(held, true), release: async () => { held = false; } };
        } };
    async function attemptClose() {
        const guard = await store.acquirePaymentLock(['cdk:code-1']);
        if (!guard) { deniedClosures++; return false; }
        owner.manual_result = 'failed'; await guard.release(); return true;
    }
    async function assertOriginalLocked() {
        assert.equal(held, true); assert.equal(await attemptClose(), false);
    }
    const api = { request: async (_cfg, operation, body, key) => {
        if (issue?.replacement_for_job_key || issue?.job_key || !issue && !owner.manual_result) await assertOriginalLocked();
        calls.push({ operation, body, key });
        if (operation === 'getAccountBalance') return { success: true, data: { available_balance: '100.00' } };
        assert.equal(operation, 'createCard');
        return { success: true, status: 200, data: { order_no: orderNo || 'ORIGINAL-OPEN', card_id: 9, status: 'success', completed: true } };
    } };
    const cardsApi = {
        ...selectionCardReads,
        products: async () => {
            calls.push({ operation: 'getProductCode' });
            if (!owner.manual_result) await assertOriginalLocked();
            if (closeDuringProducts) owner.manual_result = 'failed';
            return [{ product_code: 'product-1' }];
        },
        chooseOpeningProduct: () => ({ product_code: 'product-1', amount: '20.00' }),
        createCardBody: selected => ({ ...selected, quantity: 1 }),
        issueResult: data => ({ ...data, fees: {}, retryAfterMs: 0 }),
        cardDetail: async () => replacementCard
    };
    const create = load('src/orbitcard/orbitcard-card-service.js', { './orbitcard-client': api, './orbitcard-cards-client': cardsApi });
    return { service: create({ store, audit() {}, now: () => 100000 }), owner, store, calls, patches, attemptClose,
        issue: () => issue, generated: () => generated, held: () => held, deniedClosures: () => deniedClosures };
}

test('manual closure without local release prevents new replacements and submission of an unsent saved replacement', async () => {
    for (const manualResult of ['success', 'failed']) for (const [existing, bound] of [[false, false], [true, false], [true, true]]) {
        const f = closedIssueFixture({ manualResult, existing, bound });
        const owner = await f.store.paymentOwner('old-job');
        assert.equal(owner.manualClosed, true); assert.equal(owner.localReleased, false); assert.equal(owner.allowed, false);
        await assert.rejects(f.service.allocate(selectionConfig, 'new-job', 'plus'), /没有可用|原补开|待确认开卡申请/);
        assert.deepEqual(f.calls, []); assert.deepEqual(f.patches, []); assert.equal(f.generated(), 0);
        if (existing) {
            await assert.rejects(f.service.apply(cfg), bound ? /存在其他待确认开卡申请/ : /原补开申请不可继续提交/);
            assert.deepEqual(f.calls, []); assert.equal(f.issue().state, 'prepared');
        }
    }
});

test('closed orders reconcile only their saved issued order number and key, including prepared snapshots', async () => {
    for (const manualResult of ['success', 'failed']) for (const bound of [false, true]) {
        const f = closedIssueFixture({ manualResult, bound, existing: true, orderNo: 'SAVED-ORDER' });
        const original = { key: f.issue().issue_key, body: f.issue().request_body };
        await f.service.recover(cfg);
        assert.deepEqual(f.calls, []);
        await f.service.recover(cfg, { confirmIssues: true });
        assert.equal(f.generated(), 0); assert.equal(f.issue().state, 'ready'); assert.equal(f.held(), false);
        assert.deepEqual(f.calls, [{ operation: 'createCard', key: original.key, body: JSON.parse(original.body) }]);
        assert.equal(f.patches.some(patch => patch.state === 'failed'), false);
        assert.equal(f.owner.manual_result, manualResult); assert.equal(f.owner.manual_local_released_at, null);
    }
});

test('administrator apply reconciles a closed existing replacement under the original owner lock', async () => {
    const f = closedIssueFixture({ existing: true, orderNo: 'SAVED-ORDER' });
    assert.equal((await f.service.apply(cfg)).card_id, 9);
    assert.deepEqual(f.calls, [{ operation: 'createCard', key: 'SAVED-OPEN-KEY', body: JSON.parse(f.issue().request_body) }]);
    assert.equal(f.generated(), 0); assert.ok(f.deniedClosures() > 0); assert.equal(f.held(), false);
});

test('replacement locks reject an intervening manual closure and retain the same guard through remote awaits', async () => {
    for (const existing of [false, true]) {
        const stopped = closedIssueFixture({ manualResult: null, existing, closeBeforeLock: true });
        await assert.rejects(stopped.service.allocate(selectionConfig, 'new-job', 'plus'), /没有可用|原补开/);
        assert.deepEqual(stopped.calls, []); assert.equal(stopped.generated(), 0); assert.equal(stopped.held(), false);
        const normal = closedIssueFixture({ manualResult: null, existing });
        normal.owner.orbitcard_state = 'manual'; // A pause alone keeps the existing replacement policy.
        assert.equal(await normal.service.allocate(selectionConfig, 'new-job', 'plus'), 9);
        assert.equal(normal.calls.filter(call => call.operation === 'createCard').length, 1);
        assert.ok(normal.deniedClosures() > 0); assert.equal(normal.held(), false);
        assert.equal(await normal.attemptClose(), true);
    }
    const changed = closedIssueFixture({ manualResult: null, closeDuringProducts: true });
    await assert.rejects(changed.service.allocate(selectionConfig, 'new-job', 'plus'), /人工闭单/);
    assert.equal(changed.generated(), 0); assert.equal(changed.calls.some(call => call.operation === 'createCard'), false);
    assert.equal(changed.held(), false);
});

test('explicit independent administrator card applications still work after an unrelated manual closure', async () => {
    const f = closedIssueFixture();
    assert.equal((await f.service.apply(cfg)).card_id, 9);
    assert.equal(f.generated(), 1); assert.equal(f.issue().replacement_for_job_key, undefined);
    assert.equal(f.issue().job_key, undefined); assert.equal(f.owner.manual_result, 'failed');
    assert.equal(f.calls.filter(call => call.operation === 'createCard').length, 1);
});
