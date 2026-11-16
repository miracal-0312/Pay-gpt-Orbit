'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { OPERATIONS } = require('../src/orbitcard/orbitcard-api-contract');
const { PROVIDER_PLANS } = require('../src/config/plan-registry');
const { cardScope } = require('../src/orbitcard/orbitcard-card-policy');
const createDiagnostics = require('../src/diagnostics/orbitcard-interface-diagnostics');
const cfg = { base_url: 'https://saved.test', api_key: 'saved-secret-key' };
const hash = crypto.createHash('sha256').update(cfg.api_key).digest('hex');
function order(overrides = {}) { return { client_order_no: 'local-client-order', task_no: 'original-task',
    card_id: 42, plan_type: 'plus', state: 'success', base_url: cfg.base_url, api_key_hash: hash,
    updated_at: '2026-11-01T00:00:00Z', ...overrides }; }
function fixture(overrides = {}) {
    const calls = [], queries = [], state = { cards: [{ card_id: 42, provider_status: 'ACTIVE' }], cdk: [], manual: [], ...overrides };
    let configReads = 0;
    const store = {
        getGptApiConfig: async () => { configReads++; return cfg; },
        cardMethods: base => { assert.equal(base, cfg.base_url); return { listCards: async () => state.cards }; },
        runQuery: async (sql, params) => { queries.push({ sql, params });
            assert.match(sql, /^SELECT /); assert.match(sql, /LIMIT 1$/); assert.doesNotMatch(sql, /SELECT \*/);
            return sql.includes('FROM task_logs') ? state.cdk : state.manual; }
    };
    const provider = { request: async (config, operation, body) => {
        assert.equal(config.base_url, cfg.base_url); assert.equal(config.api_key, cfg.api_key);
        assert.equal(OPERATIONS[operation].write, false, 'Diagnostics cannot call financial APIs');
        calls.push({ operation, body });
        if (state.response) return state.response(operation, body);
        const data = {
            getSubscriptionList: {items:[],total:0},
            getAccountBalance: { available_balance: '15.00000000' }, getProductCode: { list: [{ product_code: 'SAVE' }] },
            getSubscriptionPlans: { enabled: true, plans: Object.values(PROVIDER_PLANS).map(type => ({ type })) },
            getSubscriptionPaymentRegions: { plan_type: body.plan_type, payment_regions: [{ code: 'US' }] },
            getCardList: { list: [{ card_id: 42, status: 'ACTIVE' }], total: 1 }, cardDetail: { card_id: body.card_id, status: 'ACTIVE' },
            cardTransaction: { list: [], total: 0 }, getCardFlow: { card_id: body.card_id, type: 'recharge', list: [], total: 0 },
            getSubscription: { task_no: 'original-task', client_order_no: 'local-client-order', plan_type: 'gpt-plus', card_id: 42, status: 'succeeded' }
        }[operation];
        return { success: true, status: 200, code: 0, data };
    } };
    return { service: createDiagnostics({ store, provider }), store, calls, queries, state, configReads: () => configReads };
}

test('manifest covers exactly 14 registered interfaces, uses saved target and orders card dependencies', async () => {
    const f = fixture(), result = await f.service.manifest();
    assert.equal(result.success, true); assert.equal(result.target, cfg.base_url);
    assert.deepEqual(result.operations.map(row => row.operation).sort(), Object.keys(OPERATIONS).sort());
    assert.equal(result.operations.filter(row => row.mode === 'live_read').length, 10);
    assert.equal(result.operations.filter(row => row.mode === 'local_simulation').length, 4);
    for (const row of result.operations) { assert.equal(row.path, OPERATIONS[row.operation].path); assert.ok(row.label); }
    assert.ok(result.operations.findIndex(row => row.operation === 'getCardList') < result.operations.findIndex(row => row.operation === 'cardDetail'));
    assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(result).includes(cfg.api_key));
});

test('each registered read is called exactly once except the four explicit region subchecks', async () => {
    const f = fixture({ cdk: [order()] });
    for (const [operation, spec] of Object.entries(OPERATIONS).filter(([, spec]) => !spec.write)) {
        const previous = f.calls.length, result = await f.service.run({ operation });
        assert.equal(result.success, true); assert.equal(result.result.status, 'passed', operation);
        assert.equal(result.result.mode, 'live_read'); assert.equal(result.result.path, spec.path);
        assert.equal(f.calls.length - previous, operation === 'getSubscriptionPaymentRegions' ? 4 : 1);
        assert.ok(f.calls.slice(previous).every(call => call.operation === operation));
        if (operation === 'getSubscriptionPaymentRegions') assert.deepEqual(result.result.checks.map(row => row.plan_type), Object.values(PROVIDER_PLANS));
        else { assert.equal(result.result.http_status, 200); assert.equal(result.result.platform_code, 0); }
    }
    assert.equal(f.configReads(), 10);
    assert.deepEqual(f.calls.find(call => call.operation === 'cardDetail').body, { card_id: 42, reveal_sensitive: false });
    assert.deepEqual(f.calls.find(call => call.operation === 'getCardFlow').body, { card_id: 42, type: 'recharge', page: 1, page_size: 100 });
    assert.deepEqual(f.calls.find(call => call.operation === 'getSubscription').body, { task_no: 'original-task' });
    assert.deepEqual(f.queries.map(query => query.params), [[cfg.base_url, hash], [cardScope(cfg.base_url), hash]]);
});

test('all financial interfaces run only the local request-contract simulation', async () => {
    const f = fixture();
    for (const [operation, spec] of Object.entries(OPERATIONS).filter(([, spec]) => spec.write)) {
        const { result } = await f.service.run({ operation });
        assert.equal(result.status, 'passed'); assert.equal(result.mode, 'local_simulation');
        assert.deepEqual(result.summary, { validation: 'request_contract', sent_to_platform: false });
        assert.match(result.message, /未发送平台请求.*未验证真实写入权限/);
        assert.ok(result.checks.length >= 4); assert.ok(result.checks.every(check => check.status === 'passed'));
        assert.equal(result.path, spec.path);
    }
    assert.equal(f.calls.length, 0); assert.equal(f.queries.length, 0); assert.equal(f.configReads(), 4);
});

test('unknown operations, arbitrary config/body and sensitive flags are rejected before reading config', async () => {
    const f = fixture();
    for (const input of [null, [], { operation: 'freezeCard' }, { operation: 'toString' }, { operation: '../getAccountBalance' },
        { operation: 'getAccountBalance', base_url: 'https://attacker.invalid' }, { operation: 'cardDetail', reveal_sensitive: true },
        { operation: 'createSubscription', body: {} }, { operation: 'getCardList', card_id: 42 },
        ...[0, -1, true, {}, 1.5, '1e2', '42;DROP', Number.MAX_SAFE_INTEGER + 1].map(card_id => ({ operation: 'cardDetail', card_id }))]) {
        await assert.rejects(f.service.run(input));
    }
    assert.equal(f.calls.length, 0); assert.equal(f.configReads(), 0);
});

test('missing card or same-identity submitted order is skipped without sending requests', async () => {
    const f = fixture({ cards: [{ card_id: 17, provider_status: 'DELETED' }] });
    for (const operation of ['cardDetail', 'cardTransaction', 'getCardFlow', 'getSubscription']) {
        assert.equal((await f.service.run({ operation })).result.status, 'skipped');
    }
    assert.equal(f.calls.length, 0);
});

test('a live list candidate may be used for a later read without changing the local card snapshot', async () => {
    const f = fixture({ cards: [] });
    const first = await f.service.run({ operation: 'getCardList' });
    assert.equal(first.result.summary.selected_card_id, 42);
    assert.equal((await f.service.run({ operation: 'cardDetail', card_id: 42 })).result.status, 'passed');
    assert.deepEqual(f.state.cards, []); assert.equal(f.calls.length, 2);
});

test('order selection rejects wrong account/platform and pre-submission state without remote lookup', async () => {
    for (const bad of [order({ api_key_hash: 'wrong' }), order({ base_url: 'https://other.test' }), order({ state: 'prepared' }),
        order({ state: 'preparing' }), order({ state: 'funding_waiting' }), order({ task_no: null, state: 'failed' }),
        order({ card_id: null }), order({ client_order_no: '' })]) {
        const f = fixture({ cdk: [bad] });
        assert.equal((await f.service.run({ operation: 'getSubscription' })).result.status, 'skipped');
        assert.equal(f.calls.length, 0);
    }
});

test('order selection prefers successful orders, then the newer same-account order across both sources', async () => {
    const f = fixture({ cdk: [order({ state: 'pending', updated_at: '2026-11-14' })], manual: [order({ base_url: undefined,
        scope: cardScope(cfg.base_url), updated_at: '2026-11-01', task_no: 'admin-original' })] });
    await f.service.run({ operation: 'getSubscription' });
    assert.deepEqual(f.calls[0].body, { task_no: 'admin-original' });
    f.state.cdk[0].state = 'success'; f.calls.length = 0;
    await f.service.run({ operation: 'getSubscription' });
    assert.deepEqual(f.calls[0].body, { task_no: 'original-task' });
});

test('submitted orders without platform number are queried by their original client identity', async () => {
    const f = fixture({ cdk: [order({ task_no: null, state: 'submitting' })] });
    assert.equal((await f.service.run({ operation: 'getSubscription' })).result.status, 'passed');
    assert.deepEqual(f.calls[0].body, { client_order_no: 'local-client-order' });
});

test('order mismatch and malformed successful response fail without returning raw upstream data', async () => {
    for (const [operation, data] of [['getSubscription', { task_no: 'different', client_order_no: 'local-client-order', plan_type: 'gpt-plus' }],
        ['cardDetail', { card_id: 43 }], ['getProductCode', {}], ['getAccountBalance', { available_balance: 'secret' }],
        ['getCardFlow', { card_id: 42, list: [{ card_id: 43 }] }]]) {
        const f = fixture({ cdk: [order()], response: () => ({ success: true, status: 200, code: 0, data: { ...data, cvv: 'secret' } }) });
        const { result } = await f.service.run({ operation });
        assert.equal(result.status, 'failed', operation); assert.ok(!JSON.stringify(result).includes('secret'));
    }
});

test('sanitized summaries omit card credentials, session, emails, arbitrary strings and transaction bodies', async () => {
    const sensitive = { card_number: '4111111111111111', cvv: '987', session_json: { accessToken: 'hidden-session' }, email: 'hidden@example.invalid',
        message: 'hidden-message', status: 'hidden-status' };
    const f = fixture({ response: (operation, body) => ({ success: true, status: 200, code: 0,
        data: operation === 'cardDetail' ? { ...sensitive, card_id: body.card_id }
            : { ...sensitive, card_id: 42, list: [{ ...sensitive, card_id: 42 }], total: 1 } }) });
    for (const operation of ['getCardList', 'cardDetail', 'cardTransaction', 'getCardFlow', 'getProductCode']) {
        const result = await f.service.run({ operation });
        assert.equal(result.result.status, 'passed');
        for (const secret of ['4111111111111111', '987', 'hidden-', 'hidden@', 'session_json', 'cvv', 'card_number']) {
            assert.ok(!JSON.stringify(result).includes(secret), secret);
        }
    }
});

test('remote failures, thrown transport errors and nested request errors are bounded and sanitized', async () => {
    for (const response of [() => ({ success: false, status: 403, code: 9, error: 'secret-key' }),
        () => { throw Error('secret-key'); }, () => ({ success: true, status: 200, code: 0, data: { request_error: { secret: 'secret-key' } } })]) {
        const f = fixture({ response }), result = await f.service.run({ operation: 'getAccountBalance' });
        assert.equal(result.result.status, 'failed'); assert.equal(f.calls.length, 1);
        assert.ok(!JSON.stringify(result).includes('secret-key'));
    }
});

test('each region is attempted once and an individual failure remains visible', async () => {
    const f = fixture({ response: (_, body) => body.plan_type === 'gpt-pro-20x' ? { success: false, status: 403, code: 4 }
        : { success: true, status: 200, code: 0, data: { plan_type: body.plan_type, payment_regions: [{ code: 'US' }] } } });
    const { result } = await f.service.run({ operation: 'getSubscriptionPaymentRegions' });
    assert.equal(result.status, 'failed'); assert.equal(result.checks.length, 4); assert.equal(f.calls.length, 4);
    assert.equal(result.checks.filter(row => row.status === 'failed').length, 1);
});

test('empty or invalid regions fail, while the summary counts only unique valid region codes', async () => {
    for (const payment_regions of [[], [{ code: 'SECRET' }]]) {
        const f = fixture({ response: (_, body) => ({ success: true, status: 200, code: 0, data: { plan_type: body.plan_type, payment_regions } }) });
        assert.equal((await f.service.run({ operation: 'getSubscriptionPaymentRegions' })).result.status, 'failed');
    }
    const f = fixture({ response: (_, body) => ({ success: true, data: { plan_type: body.plan_type,
        payment_regions: [{ code: 'US' }, { code: 'SECRET' }, { code: 'US' }, { code: 'PH' }] } }) });
    const { result } = await f.service.run({ operation: 'getSubscriptionPaymentRegions' });
    assert.equal(result.status, 'passed');
    for (const check of result.checks) { assert.equal(check.summary.region_count, 2); assert.deepEqual(check.summary.regions, ['US', 'PH']); }
});

test('single card detail accepts existing client wrappers and aliases but rejects failed or mismatched wrappers', async () => {
    for (const data of [{ card_id: 42, success: true, data: { status: 'ACTIVE' } },
        { card: { cardId: 42, card_status: 'ACTIVE' } }, { cardId: 42, data: { card_id: 42, status: 'CANCELLED' } }]) {
        const f = fixture({ response: () => ({ success: true, data }) });
        assert.equal((await f.service.run({ operation: 'cardDetail' })).result.status, 'passed');
    }
    for (const data of [{ card_id: 42, success: false, data: { status: 'ACTIVE' } },
        { card_id: 43, data: { card_id: 42, status: 'ACTIVE' } }, { card_id: 42, data: { card_id: 43, status: 'ACTIVE' } },
        { card_id: 42, data: null }, { card_id: 42 }, { status: 'ACTIVE' },
        { success: true, data: { status: 'ACTIVE' } }, { card: { status: 'ACTIVE' } }]) {
        const f = fixture({ response: () => ({ success: true, data }) });
        assert.equal((await f.service.run({ operation: 'cardDetail' })).result.status, 'failed');
    }
});

test('new HTTP routes use saved config without secondary auth and preserve existing secondary-auth routes', async t => {
    const express = require('express'), app = express(); app.use(express.json());
    const f = fixture(), filename = path.resolve(__dirname, '../src/http/orbitcard-diagnostics-http.js'), module = { exports: {} }, real = createRequire(filename);
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        name => name === '../diagnostics/orbitcard-interface-diagnostics' ? () => f.service : real(name), module, module.exports);
    module.exports(app, { store: f.store, logs: { push() {} }, requireSecondaryAuth: (_, res) => res.status(403).json({ success: false }) });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/admin/orbitcard/diagnostics`;
    const manifest = await fetch(`${base}/interfaces`); assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('cache-control'), 'no-store'); assert.equal((await manifest.json()).operations.length, 14);
    const send = body => fetch(`${base}/interface-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const simulation = await send({ operation: 'deleteCard' }); assert.equal(simulation.status, 200);
    assert.equal((await simulation.json()).result.mode, 'local_simulation'); assert.equal(f.calls.length, 0);
    assert.equal((await send({ operation: 'getAccountBalance', base_url: 'https://arbitrary.invalid' })).status, 400);
    const read = await send({ operation: 'getAccountBalance' }); assert.equal(read.status, 200); assert.equal(f.calls.length, 1);
    assert.equal((await fetch(`${base}/preflight`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/logs/example`)).status, 403);
});
