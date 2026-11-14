'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/diagnostics.js'), 'utf8');
const adminSource = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const QUEUE_MESSAGE = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';

function order(overrides = {}) {
    return { request_id: 'original-request', client_order_no: 'manual-original-request',
        plan_type: 'gpt-plus', plan_name: 'Plus', mode: 'test', state: 'retry_waiting',
        card_id: 41, attempt: 1, message: '首次支付已明确失败', ...overrides };
}

function setup({ reportErrors = false } = {}) {
    const nodes = new Map(), stored = new Map(), calls = [], routes = [], events = new Map(), notices = [];
    let currentOrder = order(), interval, randomIds = 0, submissionError = null;
    let now = Date.now();
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, {
            value: '', textContent: '', checked: false, disabled: false, options: [], children: [], events: new Map(),
            addEventListener(name, handler) { this.events.set(name, handler); },
            replaceChildren(...children) { this.children = children; if (id === 'diagPlan') this.options = children; },
            add(option) { this.options.push(option); },
            append(child) { this.children.push(child); },
            showModal() { this.open = true; this.openCount = (this.openCount || 0) + 1; }, close() { this.open = false; },
            focus() { this.focused = true; }, scrollIntoView() {}
        });
        return nodes.get(id);
    };
    const context = vm.createContext({
        $: node, Date: ClockDate, URL, selected: 'diagnostics', selectedDiagnostic: 'payment', SECONDARY_KEY: 'secondary',
        sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
        localStorage: { getItem: () => 'verified' },
        crypto: { randomUUID: () => { randomIds++; return 'new-request'; } },
        document: { hidden: false, querySelectorAll: () => [], addEventListener: (name, handler) => events.set(name, handler), createElement: () => ({}) },
        Option: function(text, value) { this.text = text; this.value = value; },
        setInterval(handler) { interval = handler; },
        async perform(handler) { try { return await handler(); } catch (error) { if (!reportErrors) throw error; context.reportError(error); } },
        async selectView(route) { routes.push(route); context.selectedDiagnostic = route.split('/')[1]; },
        notice: (...args) => notices.push(args),
        async request(url, body) {
            calls.push({ url, body });
            if (url.startsWith('/api/admin/orbitcard/diagnostics/logs/')) {
                return { entries: [{ ts: Date.now(), text: url.includes('attempt-') ? 'retry-log' : 'original-log' }],
                    next_cursor: 1, revision: 'fixture', exists: true, has_more: false };
            }
            assert.match(url, /^\/api\/admin\/manual\/orders\/original-request(?:\/refresh)?$/);
            return { order: currentOrder };
        },
        async diagnosticFetch(url, body) { calls.push({ url, body }); if (submissionError) throw submissionError; return { order: currentOrder }; }
    });
    vm.runInContext(adminSource.slice(adminSource.indexOf('const PAYMENT_QUEUE_FULL_MESSAGE'), adminSource.indexOf('const pendingRequests')), context);
    vm.runInContext(source, context);
    node('diagAutoLogs').checked = true;
    return { context, node, stored, calls, routes, notices, events,
        setOrder(value) { currentOrder = value; }, failSubmission(error) { submissionError = error; }, advance(ms) { now += ms; }, tick: () => interval(), get randomIds() { return randomIds; } };
}

test('selecting an earlier attempt log keeps that log selected while the original test order is polled', async () => {
    const f = setup();
    const second = order({ client_order_no: 'manual-original-request-attempt-2', state: 'pending', card_id: 42, attempt: 2 });
    await f.context.diagResumeOrder(second);
    f.setOrder(order({ client_order_no: 'manual-original-request-attempt-3', state: 'pending', card_id: 43, attempt: 3 }));
    f.events.get('click')({ target: { closest: () => ({ dataset: { debugTrace: 'manual-original-request' } }) } });
    await Promise.resolve();
    await f.tick();
    assert.equal(f.node('diagTraceId').value, 'manual-original-request');
    assert.match(f.node('diagTraceLog').textContent, /original-log/);
    assert.match(f.node('diagOrderState').textContent, /第 3 \/ 3 次尝试/);
    assert.ok(f.calls.some(call => call.url.endsWith('/original-request/refresh')));
    assert.equal(f.context.selectedDiagnostic, 'trace');
});

test('manually reading a trace pins it, while explicitly querying the test resumes following its latest attempt', async () => {
    const f = setup();
    await f.context.diagResumeOrder(order());
    f.node('diagTraceId').value = 'manual-original-request';
    await f.node('diagReadLogs').onclick();
    f.setOrder(order({ client_order_no: 'manual-original-request-attempt-2', state: 'pending', card_id: 42, attempt: 2 }));
    await f.context.diagQueryOrder();
    assert.equal(f.node('diagTraceId').value, 'manual-original-request');
    await f.node('diagQueryOrder').onclick();
    assert.equal(f.node('diagTraceId').value, 'manual-original-request-attempt-2');
    assert.match(f.node('diagTraceLog').textContent, /retry-log/);
    f.setOrder(order({ client_order_no: 'manual-original-request-attempt-3', state: 'pending', card_id: 43, attempt: 3 }));
    await f.context.diagQueryOrder();
    assert.equal(f.node('diagTraceId').value, 'manual-original-request-attempt-3');
});

test('resuming an order restores its request and plan and requires fresh Session and authorization', async () => {
    const f = setup();
    f.node('diagPlan').options = [{ value: 'another-plan' }];
    f.node('diagPlan').value = 'another-plan';
    f.node('diagSession').value = 'old-account-session';
    f.node('diagSessionFile').value = 'old-session.json';
    f.node('diagAuthorized').checked = true;
    const persisted = order({ plan_type: 'pro_5x', plan_name: 'Pro 100', attempt: 2, client_order_no: 'manual-original-request-attempt-2' });
    await f.context.diagResumeOrder(persisted);
    assert.deepEqual(f.routes, ['diagnostics/payment']);
    assert.equal(f.node('diagRequestId').value, persisted.request_id);
    assert.equal(f.node('diagPlan').value, 'pro_5x');
    assert.equal(f.node('diagPlan').options.filter(option => option.value === 'pro_5x').length, 1);
    assert.equal(f.node('diagSession').value, '');
    assert.equal(f.node('diagSessionFile').value, '');
    assert.equal(f.node('diagAuthorized').checked, false);
    assert.equal(f.node('diagSession').focused, true);
    assert.deepEqual([...f.stored], [['orbitcard_debug_request_id', 'original-request']]);
    assert.deepEqual(f.calls, [], 'resuming the form must not submit a payment');
    await f.context.diagResumeOrder(persisted);
    assert.equal(f.node('diagPlan').options.filter(option => option.value === 'pro_5x').length, 1);
    assert.equal(f.randomIds, 0);
});

test('retry_waiting can resubmit a fresh Session under the same request, and pending states cannot start another test', async () => {
    const f = setup();
    await f.context.diagResumeOrder(order());
    assert.equal(f.node('diagPay').disabled, false);
    assert.equal(f.node('diagNewTest').disabled, true);
    assert.match(f.node('diagPay').textContent, /换卡重试/);
    assert.match(f.node('diagOrderState').textContent, /第 1 \/ 3 次尝试/);
    await assert.rejects(f.node('diagPay').onclick(), /确认目标账号授权/);
    assert.deepEqual(f.calls, []);
    f.node('diagSession').value = '{"user":{"email":"authorized@example.test"}}';
    f.node('diagAuthorized').checked = true;
    f.setOrder(order({ client_order_no: 'manual-original-request-attempt-2', state: 'pending', attempt: 2, card_id: 42 }));
    await f.node('diagPay').onclick();
    const submission = f.calls.find(call => call.url === '/api/admin/manual/orders');
    assert.equal(submission.body.request_id, 'original-request');
    assert.equal(submission.body.plan_type, 'gpt-plus');
    assert.equal(submission.body.mode, 'test');
    assert.equal(submission.body.authorized, true);
    assert.equal(JSON.parse(submission.body.session).user.email, 'authorized@example.test');
    assert.equal(f.randomIds, 0);
    assert.equal(f.node('diagSession').value, '');
    assert.equal(f.node('diagAuthorized').checked, false);
    assert.equal(f.node('diagPay').disabled, true);
    assert.equal(f.node('diagNewTest').disabled, true);
    assert.equal(f.node('diagTraceId').value, 'manual-original-request-attempt-2');
    assert.match(f.node('diagOrderState').textContent, /第 2 \/ 3 次尝试/);
    f.node('diagNewTest').onclick();
    assert.equal(f.node('diagRequestId').value, 'original-request');
});

test('unknown and blocked outcomes keep payment controls disabled; confirmed terminal outcomes allow a new test', () => {
    const f = setup();
    for (const state of ['pending', 'manual', 'submitting', 'funding_waiting', 'funding_review', 'support_locked']) {
        f.context.diagShowOrder(order({ state, attempt: 3 }));
        assert.equal(f.node('diagPay').disabled, true, state);
        assert.equal(f.node('diagNewTest').disabled, true, state);
    }
    for (const state of ['success', 'failed', 'rejected']) {
        f.context.diagShowOrder(order({ state, attempt: 3 }));
        assert.equal(f.node('diagPay').disabled, true, state);
        assert.equal(f.node('diagNewTest').disabled, false, state);
    }
});

test('a queued preparing order cannot be submitted again but keeps querying its original request', async () => {
    const f = setup();
    const queued = order({ state: 'preparing', queued: true, message: '正在等待支付卡' });
    f.setOrder(queued);
    await f.context.diagResumeOrder(queued);
    assert.equal(f.node('diagPay').disabled, true);
    assert.equal(f.node('diagNewTest').disabled, true);
    assert.match(f.node('diagOrderState').textContent, /排队等待/);
    await assert.rejects(f.node('diagPay').onclick(), /正在排队/);
    await f.tick();
    assert.ok(f.calls.some(call => call.url.endsWith('/original-request/refresh')));
    assert.equal(f.calls.filter(call => call.url === '/api/admin/manual/orders').length, 0);
    assert.equal(f.node('diagPay').disabled, true);
});

test('queue-full HTTP rejection preserves Session and opens a modal without querying an unknown payment', async () => {
    const f = setup({ reportErrors: true });
    await f.context.diagResumeOrder(order());
    f.node('diagSession').value = '{"accessToken":"private-session"}';
    f.node('diagAuthorized').checked = true;
    f.failSubmission(Object.assign(new Error(QUEUE_MESSAGE), { httpStatus: 429, error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600 }));
    await f.node('diagPay').onclick();
    assert.equal(f.node('diagSession').value, '{"accessToken":"private-session"}');
    assert.equal(f.node('diagAuthorized').checked, true);
    assert.equal(f.node('diagRequestId').value, 'original-request');
    assert.equal(f.node('diagPay').disabled, false);
    assert.equal(f.node('diagOrderState').textContent, QUEUE_MESSAGE);
    assert.equal(f.node('paymentQueueDialog').open, true);
    assert.equal(f.node('paymentQueueMessage').textContent, QUEUE_MESSAGE);
    assert.equal(f.calls.length, 1);
    await f.tick();
    assert.equal(f.calls.length, 1, 'a rejected request must not start background order queries');
});

test('queue-full order results show the same modal once while timeout and stopped failures remain ordinary results', () => {
    const f = setup();
    f.context.diagShowOrder(order({ state: 'failed', error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600 }));
    assert.equal(f.node('paymentQueueDialog').open, true);
    f.node('paymentQueueDialog').close();
    f.context.diagShowOrder(order({ state: 'failed', error_code: 'PAYMENT_QUEUE_FULL' }));
    assert.equal(f.node('paymentQueueDialog').open, false);
    assert.equal(f.node('paymentQueueDialog').openCount, 1);
    for (const error_code of ['PAYMENT_QUEUE_TIMEOUT', 'PAYMENT_QUEUE_STOPPED']) {
        f.context.diagShowOrder(order({ request_id: error_code, state: 'failed', error_code }));
        assert.equal(f.node('paymentQueueDialog').open, false);
    }
});

test('queued tests retain a fixed 45-minute tracking window through card retries', async () => {
    const f = setup();
    const queued = order({ state: 'preparing', queued: true });
    await f.context.diagResumeOrder(queued);
    f.setOrder(queued); await f.tick();
    f.advance(16 * 60 * 1000);
    f.setOrder(order({ state: 'pending', queued: false, client_order_no: 'manual-original-request-attempt-2', attempt: 2 }));
    await f.tick();
    assert.equal(f.calls.filter(call => call.url.endsWith('/original-request/refresh')).length, 2);
    assert.equal(f.node('diagAutoLogs').checked, true);
    f.advance(28 * 60 * 1000);
    f.setOrder(order({ state: 'pending', queued: false, client_order_no: 'manual-original-request-attempt-3', attempt: 3 }));
    await f.tick();
    const calls = f.calls.length;
    f.advance(60 * 1000); await f.tick();
    assert.equal(f.calls.length, calls, 'later attempts must not restart the original tracking clock');
    assert.equal(f.node('diagAutoLogs').checked, false);
    assert.match(f.node('diagLogState').textContent, /自动跟踪已暂停/);
});

test('ordinary tests keep 15 minutes and starting a new test clears the previous queue extension', async () => {
    const f = setup();
    await f.context.diagResumeOrder(order({ state: 'preparing', queued: true }));
    f.context.diagShowOrder(order({ state: 'success', queued: false }));
    f.node('diagNewTest').onclick();
    assert.equal(f.node('diagRequestId').value, '');
    const next = order({ request_id: 'next-request', client_order_no: 'manual-next-request', state: 'pending', queued: false });
    await f.context.diagResumeOrder(next);
    const calls = f.calls.length;
    f.advance(15 * 60 * 1000); await f.tick();
    assert.equal(f.calls.length, calls);
    assert.equal(f.node('diagAutoLogs').checked, false);
});
