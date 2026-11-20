'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const message = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';
const queueError = () => Object.assign(new Error(message), { httpStatus: 429, error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600 });

function setup() {
    const nodes = new Map(), calls = [], notices = [];
    let failure = null, order = { request_id: 'same-request', client_order_no: 'manual-same-request', plan_type: 'gpt-plus',
        target_email: 'buyer@example.test', created_at: new Date().toISOString(), mode: 'fulfillment', state: 'preparing', queued: true };
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', checked: true, disabled: false, textContent: '', innerHTML: '', events: {},
            addEventListener(name, fn) { this.events[name] = fn; },
            querySelector: () => node('manualSubmit'),
            showModal() { this.open = true; }, close() { this.open = false; } });
        return nodes.get(id);
    };
    const context = vm.createContext({
        $: node, Date, manualCatalog: { plans: [{ type: 'gpt-plus' }] }, manualOrders: [], manualQueuedRequest: '',
        crypto: { randomUUID: () => 'same-request' },
        escapeHtml: value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
        status: value => value, notice: (...args) => notices.push(args),
        diagFollow() {}, async diagReadLogs() {}, async selectView() {},
        async request(url, body) {
            calls.push({ url, body });
            if (body && failure) throw failure;
            return body ? { order } : { orders: [order] };
        }
    });
    vm.runInContext(source.slice(source.indexOf('const PAYMENT_QUEUE_FULL_MESSAGE'), source.indexOf('const pendingRequests')), context);
    vm.runInContext(source.slice(source.indexOf('function form('), source.indexOf("form('unlockForm'")), context);
    vm.runInContext(source.slice(source.indexOf('function renderManualOrders('), source.indexOf("form('apiForm'")), context);
    node('manualPlan').value = 'gpt-plus'; node('manualCdk').value = 'KEEP-CDK';
    node('manualSession').value = '{"accessToken":"keep-session"}';
    return { context, node, calls, notices, fail(error) { failure = error; }, setOrder(value) { order = { ...order, ...value }; },
        submit: () => node('manualForm').events.submit({ preventDefault() {} }) };
}

test('manual queue-full HTTP rejection keeps request identity, Session and CDK and opens the shared dialog', async () => {
    const f = setup(); f.fail(queueError());
    await f.submit();
    assert.equal(f.node('manualSession').value, '{"accessToken":"keep-session"}');
    assert.equal(f.node('manualCdk').value, 'KEEP-CDK');
    assert.equal(f.node('manualRetryId').value, 'same-request');
    assert.equal(f.node('manualSubmit').disabled, false);
    assert.equal(f.node('paymentQueueDialog').open, true);
    assert.equal(f.node('paymentQueueMessage').textContent, message);
    assert.equal(f.calls.length, 1);
});

test('manual accepted queue blocks repeat preparation and exposes original-order queries until it leaves the queue', async () => {
    const f = setup();
    await f.submit();
    assert.equal(f.node('manualSubmit').disabled, true);
    assert.match(f.node('manualSubmit').textContent, /排队等待/);
    await f.submit();
    assert.equal(f.calls.filter(call => call.body).length, 1);
    assert.ok(f.notices.some(([text]) => text.includes('正在排队')));
    await f.context.loadManualOrders();
    assert.match(f.node('manualOrderRows').innerHTML, /排队等待/);
    assert.match(f.node('manualOrderRows').innerHTML, /data-refresh-manual="same-request"/);
    assert.doesNotMatch(f.node('manualOrderRows').innerHTML, /data-retry-manual/);
    assert.equal(f.node('manualSubmit').disabled, true);
    f.setOrder({ queued: false, state: 'failed', error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600 });
    await f.context.loadManualOrders();
    assert.equal(f.node('manualSubmit').disabled, false);
    assert.equal(f.node('paymentQueueDialog').open, true);
});

test('manual business closure clears stale local queue tracking without showing a queue-full or resume prompt', async () => {
    for (const marker of [{ manual_result: 'failed' }, { business_status: 'closed', business_result: 'success' }]) {
        const f = setup(); await f.submit();
        assert.equal(f.node('manualSubmit').disabled, true);
        f.setOrder({ ...marker, queued: true, state: 'funding_pending', error_code: 'PAYMENT_QUEUE_FULL' });
        await f.context.loadManualOrders();
        assert.equal(f.node('manualSubmit').disabled, false);
        assert.notEqual(f.node('paymentQueueDialog').open, true);
        assert.match(f.node('manualOrderRows').innerHTML, /已关闭/);
        assert.doesNotMatch(f.node('manualOrderRows').innerHTML, /排队等待|data-retry-manual/);
        assert.equal(f.calls.filter(call => call.body).length, 1);
    }
});
