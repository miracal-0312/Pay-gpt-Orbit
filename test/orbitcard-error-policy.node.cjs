'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyFailure, classifyApiError } = require('../orbitcard-error-policy');
const { disableFailedCard } = require('../orbitcard-card-failure');

const expected = { orderId: 'SUB-POLICY', clientOrderNo: 'policy-client', cardId: 42,
    planType: 'gpt-plus', email: 'buyer@example.test' };
function failed(change = {}) {
    return { task_no: expected.orderId, client_order_no: expected.clientOrderNo, card_id: expected.cardId,
        plan_type: expected.planType, status: 'failed', upstream_status: 'failed', subscription_succeeded: false,
        query_source: 'upstream', targetEmail: expected.email, failureCode: 'card_declined', ...change };
}

test('all documented platform codes provide a bounded repair action without authorizing another payment', () => {
    const cases = [
        [11000, 'fix_configuration'], [30004, 'reconcile'], [59001, 'fix_configuration'],
        [59002, 'fix_configuration'], [59004, 'refresh_session'], [59005, 'replace_card'],
        [59007, 'confirm_authorization'], [59008, 'fix_configuration'], [59009, 'review'],
        [59013, 'fix_configuration'], [59015, 'review_fee'], [59016, 'wait'],
        [59018, 'reconcile'], [59019, 'fix_configuration']
    ];
    assert.equal(cases.length, 14);
    for (const [code, action] of cases) {
        const policy = classifyApiError({ operation: 'createSubscription', status: 400, code });
        assert.equal(policy.action, action, String(code));
        assert.ok(policy.message.length > 0 && policy.message.length <= 255);
        assert.equal(policy.automaticRetry, undefined);
        assert.equal(policy.disableCard, undefined);
        assert.equal(policy.rejected, undefined);
    }
});

test('all documented upstream codes are interpreted within their documented API namespace', () => {
    const groups = [
        [[40030, 40031, 40032, 40033], 'fix_configuration'],
        [[42230, 40934], 'refresh_session'],
        [[42231, 42232, 40935, 40936, 40937, 40938, 40939, 42233, 40940, 40941], 'review_account'],
        [[50233, 40930, 40931, 40932, 50230, 50231, 50232, 50330], 'reconcile'],
        [[42900, 50331], 'wait']
    ];
    assert.equal(groups.flatMap(([codes]) => codes).length, 26);
    for (const [codes, action] of groups) for (const code of codes) {
        const requestError = { source: 'upstream', upstream_code: code };
        const policy = classifyApiError({ operation: '/api/open/v1/assistants/gpt/upgrade-price', status: 502, code: 59018, requestError });
        assert.equal(policy.action, action, String(code));
        assert.notEqual(policy.action, 'replace_card');
        const ordinary = classifyApiError({ operation: 'getSubscription', status: 502, code: 59018, requestError });
        assert.equal(ordinary.category, 'transport', `assistant ${code} must not control subscription repair`);
        const wrongLevel = classifyApiError({ operation: '/api/open/v1/assistants/gpt/session', status: 200, code });
        assert.equal(wrongLevel.category, 'unknown', `top-level ${code} is not an assistant upstream code`);
    }
    assert.equal(classifyApiError({ operation: 'createSubscription', status: 502, code: 59018,
        requestError: { source: 'upstream', upstream_code: 40027 } }).action, 'refresh_session');
    assert.equal(classifyApiError({ operation: 'createCard', status: 502, code: 59018,
        requestError: { source: 'upstream', upstream_code: 40027 } }).action, 'reconcile');
});

test('request errors and transport failures always preserve uncertainty about payment acceptance', () => {
    for (const status of [undefined, 408, 500, 502, 503, 504]) {
        const policy = classifyApiError({ operation: 'createSubscription', status });
        assert.equal(policy.action, 'reconcile');
        assert.equal(policy.stopTracking, false);
        assert.equal(policy.rejected, undefined);
    }
    for (const status of [401, 403, 404, 409, 413]) {
        const policy = classifyApiError({ operation: 'getSubscription', status });
        assert.equal(policy.stopTracking, true);
        assert.notEqual(policy.action, 'replace_card');
    }
    assert.equal(classifyApiError({ operation: 'getSubscription', status: 200, code: 59005 }).action, 'review');
    assert.equal(classifyApiError({ operation: 'getSubscription', status: 502, code: 59018,
        requestError: { code: 'relay_query_busy', retry_after_seconds: 20 } }).retryAfterMs, 20000);
    assert.equal(classifyApiError({ operation: 'getSubscription', status: 502, code: 59018,
        requestError: { code: 'relay_unpublished_error' } }).action, 'reconcile');
    assert.equal(classifyApiError({ operation: '/api/open/v1/assistants/gpt/auto-renewal', status: 502, code: 59018,
        requestError: { code: 'assistant_invalid_response' } }).stopTracking, true);
});

test('contradictory authentication and idempotency responses cannot suggest replacing cards', () => {
    for (const status of [401, 403, 409, 413, 429]) {
        const policy = classifyApiError({ operation: 'createSubscription', status, code: 59005 });
        assert.notEqual(policy.action, 'replace_card');
    }
    const policy = classifyApiError({ operation: 'createSubscription', status: 429, retryAfterMs: 120000,
        requestError: { retry_after_seconds: 180, upstream_code: 40027, source: 'upstream' } });
    assert.equal(policy.action, 'wait');
    assert.equal(policy.retryAfterMs, 180000);
});

test('known card failures permit bounded card replacement classification', () => {
    const codes = ['card_error', 'card_declined', 'card_unavailable', 'card_not_available', 'card_invalid',
        'card_expired', 'card_blocked', 'card_restricted', 'card_not_supported', 'card_limit_exceeded',
        'invalid_card', 'expired_card', 'incorrect_card', 'unsupported_card', 'lost_card', 'stolen_card',
        'restricted_card', 'insufficient_funds', 'incorrect_cvc', 'invalid_cvc', 'do_not_honor',
        'transaction_not_allowed', 'payment_method_declined', 'CardDeclined', 'CARD-EXPIRED', 'card declined'];
    for (const failureCode of codes) {
        const policy = classifyFailure(failed({ failureCode }));
        assert.equal(policy.action, 'replace_card', failureCode);
        assert.equal(policy.automaticRetry, true, failureCode);
        assert.equal(policy.disableCard, true, failureCode);
    }
});

test('Session, account and configuration failures override misleading card text and never use another card', () => {
    for (const failureCode of ['session_expired', 'invalid_session', 'accessTokenExpired', 'cookie_invalid',
        '40027', '59004', 'account_restricted', 'already_subscribed', 'unpaid_invoice', 'plan_not_supported',
        'permission_denied', 'max_service_fee_exceeded', 'captcha_required', 'relay_timeout']) {
        const policy = classifyFailure(failed({ failureCode, failureMessage: 'card declined during payment' }));
        assert.equal(policy.automaticRetry, false, failureCode);
        assert.equal(policy.disableCard, false, failureCode);
    }
    for (const failureMessage of ['Session 已失效，card declined', 'account has insufficient funds',
        '平台账户余额不足，卡片不可用', 'Session invalid: payment method declined']) {
        const policy = classifyFailure(failed({ failureMessage }));
        assert.equal(policy.disableCard, false, failureMessage);
    }
    // Account balance messages cannot accidentally be treated as payment-card funds.
    assert.equal(classifyFailure(failed({ failureCode: 'insufficient_funds', failureMessage: 'wallet balance too low' })).disableCard, false);
});

test('unknown codes are safe by default; text fallback requires explicit card evidence', () => {
    for (const failureCode of ['', 'unknown_failure', '90001', 50230, {}, null]) {
        const policy = classifyFailure(failed({ failureCode }));
        assert.equal(policy.automaticRetry, false);
        assert.equal(policy.disableCard, false);
    }
    for (const failureMessage of ['unknown upstream error', 'request failed', 'insufficient funds', '账号暂时不可用',
        'discard invalid metadata', 'card is not expired', '卡片并未过期', 'payment method was not declined']) {
        assert.equal(classifyFailure(failed({ failureCode: 'provider_error', failureMessage })).disableCard, false);
    }
    for (const failureMessage of ['支付卡已过期', '银行卡拒付', 'payment method declined', 'invalid CVC']) {
        assert.equal(classifyFailure(failed({ failureCode: 'provider_error', failureMessage })).disableCard, true);
    }
    assert.equal(classifyFailure(failed({ failureCode: 59005, failureMessage: 'card unavailable' })).disableCard, false);
});

test('pending, success and request-error evidence veto failure actions regardless of a card message', () => {
    for (const change of [{ status: 'pending' }, { upstream_status: 'processing' }, { status: 'succeeded' },
        { subscription_succeeded: true }, { request_error: { code: 'relay_timeout' } }, { upstream_status: 'not_documented' }]) {
        const policy = classifyFailure(failed(change));
        assert.equal(policy.disableCard, false);
        assert.equal(policy.automaticRetry, false);
    }
});

test('classification exposes safe bounded diagnostics and fixed user messages', () => {
    const policy = classifyFailure(failed({ failureCode: 'provider_error',
        failureMessage: 'card declined cvv=123 access_token=sensitive ' + 'x'.repeat(1000) }));
    assert.equal(policy.disableCard, true);
    assert.ok(policy.reason.length <= 255);
    assert.ok(!policy.reason.includes('123') && !policy.reason.includes('sensitive'));
    assert.ok(!policy.message.includes('sensitive'));
    const api = classifyApiError({ operation: 'getSubscription', status: 200, code: 'secret=value',
        requestError: { message: 'accessToken=secret' }, retryAfterMs: NaN });
    assert.equal(api.action, 'review');
    assert.ok(!JSON.stringify(api).includes('secret'));
    const url = classifyFailure(failed({ failureMessage: 'card declined; https://captcha.test/task#sensitive-ticket' }));
    assert.ok(!url.reason.includes('https://') && !url.reason.includes('sensitive-ticket'));
    assert.equal(classifyFailure(failed({ failureCode: 'provider_error', failureMessage: 'https://card.invalid/path' })).disableCard, false);
});

test('durable disabling requires verified terminal failure and matching original identity', async () => {
    let writes = 0;
    const runExecute = async () => { writes++; };
    const base = { runExecute, scope: 'test-scope', cardId: expected.cardId, jobKey: 'job-policy', expected };
    for (const change of [{ status: 'pending' }, { query_source: 'snapshot' },
        { client_order_no: 'another-client' }, { card_id: 99 }, { task_no: 'another-order' },
        { request_error: { code: 'relay_query_busy' } }, { failureCode: 'session_expired' }]) {
        assert.equal(await disableFailedCard({ ...base, snapshot: failed(change) }), false);
    }
    assert.equal(writes, 0);
    assert.equal(await disableFailedCard({ ...base, snapshot: failed() }), true);
    assert.equal(writes, 1);
});
