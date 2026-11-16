'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name), module = { exports: {} }, real = createRequire(filename);
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : id === './runtime-log' ? { push() {} } : real(id), module, module.exports);
    return module.exports;
}
const api = load('orbitcard-client.js', { axios: { request: async () => { throw Error('real transport is forbidden'); } } });
const createService = require('../orbitcard-subscription-service');
const { confirmedFailure, confirmedRejection, retryableFailure } = require('../payment-retry-policy');
const expected = { clientOrderNo: 'payment-original-1', planType: 'gpt-plus', cardId: 42, email: 'target@example.test' };
const prepared = { expected, body: { client_order_no: expected.clientOrderNo, card_id: 42, plan_type: 'gpt-plus' } };
const identity = { task_no: 'SUB-ORIGINAL', client_order_no: expected.clientOrderNo, card_id: 42, plan_type: 'gpt-plus' };

function service(response) {
    const calls = [], audits = [];
    const provider = { ...api, request: async (...args) => { calls.push(args); return response; } };
    return { gateway: createService(provider, entry => audits.push(entry)), calls, audits };
}

test('59005 rejection produces durable bound evidence, including explicit rejected request errors', async () => {
    for (const requestError of [undefined, { code: 'relay_card_unavailable', submission_outcome: 'rejected' }]) {
        const f = service({ success: false, status: 400, code: 59005, data: null, requestError });
        const created = await f.gateway.submit({}, prepared);
        assert.equal(created.cardRejected, true);
        assert.equal(created.rejected, true);
        assert.equal(created.orderId, undefined);
        assert.equal(created.snapshot.request_error, undefined);
        assert.equal(confirmedFailure(created.snapshot, expected), true);
        assert.equal(retryableFailure(created.snapshot, expected), true);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0][3], expected.clientOrderNo);
    }
});

test('59005 cannot override accepted, foreign, incomplete or contradictory response evidence', async () => {
    const responses = [
        { data: { ...identity } },
        { data: { task_no: 'UNPROVEN' } },
        { data: { client_order_no: 'OTHER' } },
        { data: { card_id: 77 } },
        { data: { plan_type: 'gpt-pro-20x' } },
        { data: { targetEmail: 'other@example.test' } },
        { data: { status: 'processing' } },
        { data: { upstream_status: 'failed' } },
        { data: { subscription_succeeded: false } },
        { data: { subscription_succeeded: true } },
        { data: { result_source: 'upstream' } },
        { data: { query_source: 'snapshot' } },
        { data: { stage: 'awaiting_captcha' } },
        { requestError: { submission_outcome: 'unknown' } },
        { requestError: { submission_outcome: 'rejected' }, data: { request_error: { submission_outcome: 'unknown' } } },
        { status: 401 }, { status: 403 }, { status: 409 }, { status: 429 }, { status: 500 },
        { requestError: { source: 'upstream', upstream_code: 40027, submission_outcome: 'rejected' } }
    ];
    for (const variant of responses) {
        const f = service({ success: false, status: 400, code: 59005, ...variant });
        const result = await f.gateway.submit({}, prepared);
        assert.equal(result.rejected, false, JSON.stringify(variant));
        assert.equal(result.cardRejected, false, JSON.stringify(variant));
        assert.equal(confirmedFailure(result.snapshot, expected), false, JSON.stringify(variant));
        assert.equal(f.calls.length, 1);
    }
});

test('ordinary rejection binds evidence only when any local task number has proven ownership', async () => {
    for (const data of [undefined, { ...identity, status: 'failed' }]) {
        const f = service({ success: false, status: 502, code: 59018, data,
            requestError: { source: 'upstream', upstream_code: 40027, submission_outcome: 'rejected' } });
        const result = await f.gateway.submit({}, prepared);
        assert.equal(result.rejected, true);
        assert.equal(result.cardRejected, false);
        assert.equal(result.disposition.action, 'refresh_session');
        assert.equal(confirmedRejection(result.snapshot, { ...expected, orderId: result.orderId }), true);
        assert.equal(retryableFailure(result.snapshot, expected), false);
    }
    for (const data of [{ task_no: 'UNPROVEN' }, { ...identity, client_order_no: 'OTHER' },
        { ...identity, result_source: 'upstream', status: 'failed' },
        { ...identity, upstream_status: 'pending' }, { ...identity, subscription_succeeded: true }]) {
        const result = await service({ success: false, code: 59018, data,
            requestError: { submission_outcome: 'rejected' } }).gateway.submit({}, prepared);
        assert.equal(result.rejected, false);
    }
});

test('all query errors remain unresolved, preserve identity and expose repair or wait action', async () => {
    const cases = [
        [{ status: 401 }, 'fix_configuration', true],
        [{ status: 403 }, 'fix_configuration', true],
        [{ status: 404 }, 'review', true],
        [{ code: 59009 }, 'review', true],
        [{ code: 59004 }, 'refresh_session', true],
        [{ status: 429, retryAfterMs: 90000 }, 'wait', false],
        [{ status: 502, code: 59018, requestError: { code: 'relay_timeout', submission_outcome: 'unknown' } }, 'reconcile', false],
        [{ code: 59005 }, 'review', true]
    ];
    for (const [failure, action, stop] of cases) {
        const f = service({ success: false, ...failure });
        const result = await f.gateway.query({}, expected);
        assert.equal(result.success, false);
        assert.equal(result.disposition.action, action);
        assert.equal(result.stopTracking, stop);
        assert.ok(result.retryAfterMs >= (stop ? 300000 : failure.retryAfterMs || 5000));
        assert.deepEqual(f.calls[0].slice(1, 3), ['getSubscription', { client_order_no: expected.clientOrderNo }]);
    }
});

test('request errors and contradictory source/success fields cannot become a terminal outcome', async () => {
    for (const override of [{ request_error: { code: 'relay_timeout' } }, { result_source: 'relay' },
        { subscription_succeeded: 'true' }, { subscription_succeeded: 1 }, { status: 'failed', subscription_succeeded: true }]) {
        const data = { ...identity, status: 'succeeded', ...override };
        assert.equal(api.outcome(data, true), 'pending');
        const result = await service({ success: true, data }).gateway.query({}, expected);
        assert.notEqual(result.state, 'success');
        assert.notEqual(result.state, 'failed');
    }
});

test('summary preserves numeric order correlation keys exactly instead of redacting them as card numbers', () => {
    const data = { task_no: '2026111612345678901', client_order_no: expected.clientOrderNo, order_no: '2026111600000123' };
    assert.deepEqual(api.summary(data), data);
    assert.equal(api.summary({ task_no: '{"accessToken":"LEAK_ME"}' }).task_no, undefined);
});

test('safe persisted errors retain classification but never upstream payloads, credentials or verification URLs', async t => {
    const oldKey = process.env.ORBITCARD_API_KEY, oldSecret = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_KEY = 'test-error-key'; process.env.ORBITCARD_API_SECRET = 'test-error-secret';
    t.after(() => {
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY = oldKey;
        if (oldSecret === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = oldSecret;
    });
    const events = [];
    const client = load('orbitcard-client.js', { './runtime-log': { push: e => events.push(e) }, axios: { request: async () => ({
        status: 502, headers: {}, data: { code: 59018, request_error: {
            code: 'relay_authentication_failed', source: 'upstream', upstream_code: 40027,
            submission_outcome: 'rejected', upstream_http_status: 400, retry_after_seconds: 8,
            message: 'accessToken=LEAK_ME', session: { accessToken: 'LEAK_ME' }, url: 'https://verify.test/#LEAK_ME'
        }, data: { failureMessage: 'Session invalid https://verify.test/#LEAK_ME', session: { accessToken: 'LEAK_ME' } } }
    }) } });
    const response = await client.request({}, 'getSubscription', { client_order_no: expected.clientOrderNo });
    const snapshot = client.summary({ ...response.data, request_error: response.requestError });
    assert.equal(snapshot.request_error.upstream_code, 40027);
    assert.equal(snapshot.request_error.submission_outcome, 'rejected');
    assert.equal(response.disposition.action, 'refresh_session');
    assert.equal(response.retryAfterMs, 8000);
    assert.ok(!JSON.stringify([events, snapshot, response.requestError]).includes('LEAK_ME'));
    for (const code of ['https://verify.test/#LEAK_ME', '{"accessToken":"LEAK_ME"}', 'Bearer LEAK_ME', '1234567890123456']) {
        const safe = client.safeRequestError({ code, source: code, upstream_code: code, submission_outcome: code });
        assert.deepEqual(safe, { code: 'relay_unclassified_error' });
    }
});

test('worker sends one POST then only queries its original identity after unknown or contradictory rejection', async t => {
    const oldSecret = process.env.ORBITCARD_API_SECRET; process.env.ORBITCARD_API_SECRET = 'test-only';
    t.after(() => { if (oldSecret === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = oldSecret; });
    for (const response of [{ success: false, status: 502, code: 59018 },
        { success: false, code: 59005, data: { client_order_no: 'FOREIGN' } },
        { success: false, requestError: { submission_outcome: 'rejected' }, data: { task_no: 'UNPROVEN' } }]) {
        const calls = [], states = [];
        const provider = { ...api, fetchPlans: async () => ({ success: true, plans: [{ type: 'gpt-plus' }] }),
            request: async (_cfg, operation, body, key) => {
                calls.push({ operation, body, key });
                return operation === 'createSubscription' ? response : { success: false, status: 401 };
            } };
        const worker = load('orbitcard-worker.js', { './orbitcard-client': provider });
        const result = await worker.run({ cfg: {}, planType: 'plus', session: { accessToken: 'test', user: { email: expected.email }, account: {} },
            clientOrderNo: expected.clientOrderNo, selectCard: async () => 42,
            setProgress: async (...args) => states.push(args), onSubmission: async () => {}, broadcast() {}, sleep: async () => {}, maxPolls: 3,
            onConfirmedFailure: async () => { throw Error('must not release or disable card'); } });
        assert.equal(result, false);
        assert.deepEqual(calls.map(call => call.operation), ['createSubscription', 'getSubscription']);
        assert.deepEqual(calls[1].body, { client_order_no: expected.clientOrderNo });
        assert.equal(states.at(-1)[3].orbitcardState, 'pending');
        assert.match(states.at(-1)[2], /保留原订单/);
    }
});
