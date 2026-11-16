'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const fixture = require('./helpers/card-db.cjs');
const createFundingService = require('../src/orbitcard/orbitcard-funding-service');
const { FundingPendingError } = require('../src/orbitcard/orbitcard-card-policy');

function load(name, mocks) {
    const filename = path.resolve(__dirname, '..', name), real = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports);
    return module.exports;
}
const cfg = { enabled: true, base_url: 'https://orbitcard.test', api_key: 'fault-recovery-test' };
const keyHash = crypto.createHash('sha256').update(cfg.api_key).digest('hex');

async function fundingFixture(response, acknowledged = false) {
    const f = fixture(), task = await f.claim(), calls = [], audits = [];
    await f.addCard();
    const methods = f.store.cardMethods(f.base);
    await methods.reserveCard(42, task.jobKey, 'plus');
    const funding = await methods.createFunding({ funding_key: 'fund-original-safe', job_key: task.jobKey,
        card_id: 42, plan_type: 'plus', amount: '16.00', target_balance: '21.00', credential_hash: keyHash,
        request_body: JSON.stringify({ card_id: 42, amount: '16.00' }) });
    if (acknowledged) await methods.updateFunding(funding.funding_key, { state: 'pending', order_no: 'FLOW-ORIGINAL' });
    const service = createFundingService({ api: { request: async (_cfg, operation, body, key) => {
        calls.push({ operation, body: structuredClone(body), key }); return response;
    } }, cardsApi: { cardDetail: async () => ({ card_id: 42, provider_status: 'ACTIVE', currency: 'USD', balance_amount: '21.00' }) },
    audit: entry => audits.push(entry), now: f.now, assertPaymentAllowed: async () => {}, assertReconciliationAllowed: async () => {},
    withRecoveryOwner: async (_cfg, _entry, action) => { await action(cfg); return true; } });
    return { ...f, task, methods, calls, audits, service, current: () => methods.fundingForJob(task.jobKey) };
}

test('a successful funding envelope with a request error cannot credit, fail, release or resubmit funds', async () => {
    for (const state of ['success', 'failed', 'refunded']) {
        for (const location of ['top', 'data']) {
            const response = { success: true, status: 200, code: 0,
                data: { order_no: 'UNVERIFIED-FLOW', card_id: 42, amount: '16.00', status: state, completed: true } };
            if (location === 'top') response.requestError = { code: 'relay_query_failed' };
            else response.data.request_error = { code: 'relay_query_failed' };
            const f = await fundingFixture(response);
            await assert.rejects(f.service.confirm(cfg, f.methods, await f.current()), FundingPendingError);
            const saved = await f.current();
            assert.equal(saved.state, 'unknown');
            assert.ok(!saved.order_no, 'an error body must not attach an unverified funding number');
            assert.equal(f.db.cards[0].active_job, f.task.jobKey);
            assert.ok(f.db.cdks[0].used_at);
            f.advance(600000);
            await assert.rejects(f.service.confirm(cfg, f.methods, await f.current()), /禁止重复补款/);
            assert.deepEqual(f.calls.map(call => call.operation), ['rechargeCard']);
            assert.equal(f.calls[0].key, 'fund-original-safe');
        }
    }
});

test('known funding queries retain the original flow and card on transport, permission and nested-row errors', async () => {
    const failures = [
        { success: false, status: 403, data: { order_no: 'FOREIGN', status: 'success', amount: '16.00' } },
        { success: false, status: 429, retryAfterMs: 90000 },
        { success: false, status: 500 },
        { success: true, status: 200, requestError: { code: 'relay_query_failed' }, data: { list: [] } },
        { success: true, status: 200, data: { card_id: 42, type: 'recharge', list: [{ order_no: 'FLOW-ORIGINAL',
            card_id: 42, amount: '16.00', status: 'success', completed: true, request_error: { code: 'relay_query_failed' } }], total: 1 } }
    ];
    for (const response of failures) {
        const f = await fundingFixture(response, true);
        await assert.rejects(f.service.confirm(cfg, f.methods, await f.current(), { readOnly: true }), FundingPendingError);
        const saved = await f.current();
        assert.ok(!['ready', 'failed'].includes(saved.state));
        assert.equal(saved.order_no, 'FLOW-ORIGINAL');
        assert.equal(saved.funding_key, 'fund-original-safe');
        assert.equal(f.db.cards[0].active_job, f.task.jobKey);
        assert.ok(f.db.cdks[0].used_at);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].operation, 'getCardFlow');
        assert.ok(saved.retry_at - f.now() >= (response.status === 403 ? 300000 : response.retryAfterMs || 5000));
        await assert.rejects(f.service.confirm(cfg, f.methods, await f.current(), { readOnly: true }), FundingPendingError);
        assert.equal(f.calls.length, 1, 'persisted cooldown must stop a repeated read');
    }
});

async function issueFixture(response) {
    const f = fixture(), task = await f.claim(), calls = [];
    const methods = f.store.cardMethods(f.base), body = { product_code: 'p1', amount: '20.00', quantity: 1 };
    await f.seedHistoricalIssue({ issue_key: 'open-original-safe', job_key: task.jobKey, plan_type: 'plus',
        product_code: 'p1', amount: '20.00', credential_hash: keyHash, request_body: JSON.stringify(body) });
    await methods.updateIssue('open-original-safe', { state: 'pending', order_no: 'OPEN-ORIGINAL' });
    Object.assign(f.db.tasks[0], { orbitcard_issue_key: 'open-original-safe', status: 'manual', orbitcard_state: 'card_pending' });
    const api = { request: async (_cfg, operation, requestBody, key) => {
        calls.push({ operation, body: structuredClone(requestBody), key });
        assert.equal(operation, 'createCard', 'a failed response must not fetch or deliver a card');
        return response;
    } };
    const cards = load('src/orbitcard/orbitcard-cards-client.js', { './orbitcard-client': api });
    const service = load('src/orbitcard/orbitcard-card-service.js', { './orbitcard-client': api, './orbitcard-cards-client': cards })(
        { store: f.store, audit() {}, now: f.now, sleep: async () => {} });
    return { ...f, task, methods, body, calls, service };
}

test('opening recovery never accepts success or terminal failure with top-level or nested request errors', async () => {
    for (const status of ['success', 'failed', 'refunded']) {
        for (const location of ['top', 'data']) {
            const response = { success: true, status: 200, code: 0,
                data: { order_no: 'OPEN-ORIGINAL', card_id: 42, product_code: 'p1', status, completed: true } };
            if (location === 'top') response.requestError = { code: 'relay_query_failed' };
            else response.data.request_error = { code: 'relay_query_failed' };
            const f = await issueFixture(response);
            await f.service.recover(cfg);
            assert.equal(f.db.issues[0].state, 'unknown');
            assert.equal(f.db.issues[0].order_no, 'OPEN-ORIGINAL');
            assert.equal(f.db.cards.length, 0);
            assert.ok(f.db.cdks[0].used_at);
            assert.equal(f.db.tasks[0].orbitcard_state, 'card_pending');
            await f.service.recover(cfg);
            assert.equal(f.calls.length, 1);
            f.advance(600000);
            await f.service.recover(cfg);
            assert.equal(f.calls.length, 2);
            for (const call of f.calls) assert.deepEqual(call, { operation: 'createCard', body: f.body, key: 'open-original-safe' });
            assert.equal(f.db.issues.length, 1);
        }
    }
});

test('permission, rate and server errors keep the opening identity/body and persist the relevant delay', async () => {
    for (const response of [{ success: false, status: 403 }, { success: false, status: 429, retryAfterMs: 120000 },
        { success: false, status: 500 }]) {
        const f = await issueFixture(response);
        await f.service.recover(cfg);
        assert.equal(f.db.issues[0].state, 'unknown');
        assert.equal(f.db.issues[0].order_no, 'OPEN-ORIGINAL');
        assert.equal(f.db.issues[0].issue_key, 'open-original-safe');
        assert.equal(f.db.issues[0].request_body, JSON.stringify(f.body));
        assert.ok(f.db.issues[0].retry_at - f.now() >= (response.status === 403 ? 300000 : response.retryAfterMs || 5000));
        if (response.status === 403) assert.match(f.db.issues[0].message, /权限/);
        assert.equal(f.db.issues.length, 1);
        assert.equal(f.calls.length, 1);
    }
});
