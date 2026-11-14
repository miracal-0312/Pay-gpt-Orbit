'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/diagnostics.js'), 'utf8');

function order(overrides = {}) {
    return { request_id: 'original-request', client_order_no: 'manual-original-request',
        plan_type: 'gpt-plus', plan_name: 'Plus', mode: 'test', state: 'retry_waiting',
        card_id: 41, attempt: 1, message: '首次支付已明确失败', ...overrides };
}

function setup() {
    const nodes = new Map(), stored = new Map(), calls = [], routes = [], events = new Map(), notices = [];
    let currentOrder = order(), interval, randomIds = 0;
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, {
            value: '', textContent: '', checked: false, disabled: false, options: [], children: [], events: new Map(),
            addEventListener(name, handler) { this.events.set(name, handler); },
            replaceChildren(...children) { this.children = children; if (id === 'diagPlan') this.options = children; },
            add(option) { this.options.push(option); },
            append(child) { this.children.push(child); },
            focus() { this.focused = true; }, scrollIntoView() {}
        });
        return nodes.get(id);
    };
    const context = vm.createContext({
        $: node, Date, URL, selected: 'diagnostics', selectedDiagnostic: 'payment', SECONDARY_KEY: 'secondary',
        sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
        localStorage: { getItem: () => 'verified' },
        crypto: { randomUUID: () => { randomIds++; return 'new-request'; } },
        document: { hidden: false, querySelectorAll: () => [], addEventListener: (name, handler) => events.set(name, handler), createElement: () => ({}) },
        Option: function(text, value) { this.text = text; this.value = value; },
        setInterval(handler) { interval = handler; },
        async perform(handler) { return handler(); },
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
        async diagnosticFetch(url, body) { calls.push({ url, body }); return { order: currentOrder }; }
    });
    vm.runInContext(source, context);
    node('diagAutoLogs').checked = true;
    return { context, node, stored, calls, routes, notices, events,
        setOrder(value) { currentOrder = value; }, tick: () => interval(), get randomIds() { return randomIds; } };
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
