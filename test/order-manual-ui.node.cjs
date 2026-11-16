'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function control(kind = 'task', id = 'job/1', overrides = {}) {
    return { kind, id, revision: 'revision-1', status: 'manual', state: 'support_locked', actions: [
        { value: 'note', label: '记录处理备注', enabled: true },
        { value: 'pause', label: '暂停自动处理', enabled: true },
        { value: 'success', label: '人工确认成功', enabled: true },
        { value: 'failed', label: '人工确认失败', enabled: true }
    ], history: [], ...overrides };
}

function fixture() {
    const nodes = new Map(), calls = [], notices = [], refreshes = [];
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, open: false, events: {},
            addEventListener(name, fn) { this.events[name] = fn; },
            showModal() { this.open = true; }, close() { this.open = false; } });
        return nodes.get(id);
    };
    let requestImpl = async () => ({ success: true, data: control() });
    let refreshImpl = async () => {};
    const start = source.indexOf('let orderManualEditing =');
    const block = source.slice(start, source.indexOf("document.addEventListener('click'", start));
    const api = new Function('$', 'request', 'notice', 'loadOverview', 'loadManualOrders', 'escapeHtml', `${block}
        return { openOrderManualControl, loadOrderManualControl, saveOrderManualControl, closeOrderManualControl };`)(
        node, async (url, body) => { calls.push({ url, body }); return requestImpl(url, body); },
        (message, type) => notices.push({ message, type }),
        async () => { refreshes.push('task'); await refreshImpl(); },
        async () => { refreshes.push('admin'); await refreshImpl(); }, escapeHtml);
    return { node, api, calls, notices, refreshes,
        request(fn) { requestImpl = fn; }, refresh(fn) { refreshImpl = fn; },
        open(kind = 'task', id = 'job/1') { return api.openOrderManualControl({ dataset: { orderKind: kind, orderManual: id } }); } };
}

test('every customer and administrator order has an escaped manual entry regardless of state, queue or legacy provider', () => {
    const nodes = { tasks: {}, manualOrderRows: {} };
    const renderTasks = new Function('$', 'escapeHtml', 'status', `${source.slice(source.indexOf('function renderTasks('), source.indexOf('async function loadOverview('))}; return renderTasks;`)(
        id => nodes[id], escapeHtml, escapeHtml);
    const renderManualOrders = new Function('$', 'escapeHtml', 'status', `${source.slice(source.indexOf('function renderManualOrders('), source.indexOf('async function loadManualOrders('))}; return renderManualOrders;`)(
        id => nodes[id], escapeHtml, escapeHtml);
    const states = ['preparing', 'prepared', 'funding_waiting', 'funding_review', 'funding_pending', 'balance_blocked', 'card_pending', 'submitting', 'pending', 'running', 'paused', 'closed', 'failed', 'success', 'manual', 'support_locked', 'retry_waiting', 'unknown'];
    const id = 'order/"<unsafe>';
    for (const state of states) for (const queued of [false, true]) {
        for (const provider of ['orbitcard', 'legacy', undefined]) {
            renderTasks([{ jobKey: id, provider, status: state, orbitcard_state: state, queued }]);
            assert.equal((nodes.tasks.innerHTML.match(/data-order-manual=/g) || []).length, 1);
            assert.ok(nodes.tasks.innerHTML.includes(`data-order-manual="${escapeHtml(id)}" data-order-kind="task"`));
            assert.doesNotMatch(nodes.tasks.innerHTML, /<unsafe>/);
        }
        for (const mode of ['test', 'fulfillment']) {
            renderManualOrders([{ request_id: id, client_order_no: 'original', created_at: '2026-11-17', mode, state, queued }]);
            assert.equal((nodes.manualOrderRows.innerHTML.match(/data-order-manual=/g) || []).length, 1);
            assert.ok(nodes.manualOrderRows.innerHTML.includes(`data-order-manual="${escapeHtml(id)}" data-order-kind="admin"`));
        }
    }
    assert.match(source, /event\.target\.closest\('\[data-order-manual\]'\)/);
    assert.doesNotMatch(source + html, /orderStatusDialog|data-edit-order|function editOrderStatus/);
});

test('failed reads retain a retryable dialog and never enable a stale mutation', async () => {
    const f = fixture();
    f.request(async () => { throw Error('读取失败'); });
    await f.open();
    assert.equal(f.node('orderManualDialog').open, true);
    assert.equal(f.node('orderManualFields').disabled, true);
    assert.equal(f.node('orderManualReload').disabled, false);
    assert.equal(f.node('orderManualError').textContent, '读取失败');
    await f.api.saveOrderManualControl();
    assert.equal(f.calls.length, 1);
    f.request(async () => ({ data: control() }));
    await f.node('orderManualReload').onclick();
    assert.equal(f.node('orderManualFields').disabled, false);
    assert.equal(f.node('orderManualAction').value, 'note');
    assert.equal(f.calls.at(-1).url, '/api/admin/orders/job%2F1/manual');
});

test('disabled action reasons and history are visible, escaped and exclude raw payment payloads', async () => {
    const f = fixture(), payload = '<img src=x onerror="alert(1)">';
    const data = control();
    data.actions[2] = { value: 'success', enabled: false, label: payload, reason: `资金未决 ${payload}` };
    data.actions.push({ value: 'unrecognized', enabled: true, label: 'hidden unsafe operation' }, null);
    data.history = [{ action: 'note', reason: payload, admin_email: payload, created_at: payload,
        previous_status: payload, next_status: payload, raw_response: 'SECRET-CARD-DATA' }, null];
    f.request(async () => ({ data }));
    await f.open();
    assert.match(f.node('orderManualAction').innerHTML, /value="success" disabled/);
    assert.match(f.node('orderManualAvailability').innerHTML, /资金未决/);
    assert.ok(f.node('orderManualHistory').innerHTML.includes(escapeHtml(payload)));
    assert.ok(f.node('orderManualAvailability').innerHTML.includes(escapeHtml(payload)));
    assert.doesNotMatch(f.node('orderManualHistory').innerHTML, /<img|SECRET-CARD-DATA/);
    assert.doesNotMatch(f.node('orderManualAction').innerHTML, /unrecognized/);
    assert.match(html, /人工确认不代表平台付款成功；未决资金保留占用/);
});

test('failed saves preserve selected action and reason; simultaneous saves send only one mutation with the server revision', async () => {
    const f = fixture();
    await f.open();
    f.node('orderManualAction').value = 'failed';
    f.node('orderManualReason').value = ' 核对后人工结案 ';
    f.request(async () => { throw Error('请先验证二级密码'); });
    await f.api.saveOrderManualControl();
    assert.equal(f.node('orderManualDialog').open, true);
    assert.equal(f.node('orderManualReason').value, ' 核对后人工结案 ');
    assert.equal(f.node('orderManualAction').value, 'failed');
    assert.equal(f.node('orderManualError').textContent, '请先验证二级密码');
    assert.equal(f.node('orderManualFields').disabled, false);
    let release;
    f.request(() => new Promise(resolve => { release = resolve; }));
    const saving = f.api.saveOrderManualControl();
    await f.api.saveOrderManualControl();
    f.api.closeOrderManualControl();
    assert.equal(f.node('orderManualDialog').open, true);
    assert.equal(f.node('cancelOrderManual').disabled, true);
    assert.equal(f.calls.filter(call => call.body).length, 2);
    assert.deepEqual(f.calls.at(-1), { url: '/api/admin/orders/job%2F1/manual', body: { action: 'failed', expected_revision: 'revision-1', reason: '核对后人工结案' } });
    release({ message: '处理完成' }); await saving;
    assert.equal(f.node('orderManualDialog').open, false);
    assert.deepEqual(f.refreshes, ['task']);
    assert.deepEqual(f.notices, [{ message: '处理完成', type: 'success' }]);
});

test('revision conflicts require a fresh read while retaining the operator selection and reason', async () => {
    const f = fixture(); await f.open();
    f.node('orderManualAction').value = 'pause'; f.node('orderManualReason').value = '等待核对原付款';
    f.request(async () => { throw Object.assign(Error('订单已变化'), { httpStatus: 409 }); });
    await f.api.saveOrderManualControl();
    assert.match(f.node('orderManualError').textContent, /重新读取/);
    assert.equal(f.node('orderManualFields').disabled, true);
    const count = f.calls.length; await f.api.saveOrderManualControl(); assert.equal(f.calls.length, count);
    f.request(async () => ({ data: control('task', 'job/1', { revision: 'revision-2' }) }));
    await f.api.loadOrderManualControl();
    assert.equal(f.node('orderManualAction').value, 'pause');
    assert.equal(f.node('orderManualReason').value, '等待核对原付款');
    f.request(async () => ({ message: '已暂停' }));
    await f.api.saveOrderManualControl();
    assert.equal(f.calls.at(-1).body.expected_revision, 'revision-2');
});

test('administrator save refreshes its own list and reports refresh failure separately from a completed mutation', async () => {
    const f = fixture(); f.request(async () => ({ data: control('admin', 'admin/1') }));
    await f.open('admin', 'admin/1');
    f.node('orderManualReason').value = '已人工核对';
    f.request(async () => ({ message: '已记录备注' }));
    f.refresh(async () => { throw Error('读取超时'); });
    await f.api.saveOrderManualControl();
    assert.equal(f.calls.at(-1).url, '/api/admin/manual/orders/admin%2F1/manual');
    assert.equal(f.node('orderManualDialog').open, false);
    assert.deepEqual(f.refreshes, ['admin']);
    assert.deepEqual(f.notices, [{ message: '已记录备注', type: 'success' }, { message: '处理已保存，但列表刷新失败：读取超时', type: 'error' }]);
    assert.equal(f.node('orderManualError').textContent, '');
});

test('late reads from another order or a dismissed dialog never replace the active order', async () => {
    const f = fixture(); let release;
    f.request(() => new Promise(resolve => { release = resolve; }));
    const previous = f.open('task', 'first');
    f.request(async () => ({ data: control('admin', 'second', { state: 'closed' }) }));
    await f.open('admin', 'second');
    release({ data: control('task', 'first', { state: 'pending' }) }); await previous;
    assert.equal(f.node('orderManualCode').textContent, '管理员订单：second');
    assert.match(f.node('orderManualState').textContent, /closed/);
    f.request(() => new Promise(resolve => { release = resolve; }));
    const pending = f.api.loadOrderManualControl();
    f.api.closeOrderManualControl(); release({ data: control('admin', 'second') }); await pending;
    assert.equal(f.node('orderManualDialog').open, false);
    await f.api.saveOrderManualControl(); assert.equal(f.calls.filter(call => call.body).length, 0);
});

test('missing revisions, mismatched identities and disabled actions cannot submit mutations', async () => {
    for (const overrides of [{ revision: '' }, { id: 'someone-else' }, { kind: 'admin' }, { actions: null }]) {
        const f = fixture(); f.request(async () => ({ data: control('task', 'job/1', overrides) }));
        await f.open(); assert.equal(f.node('orderManualFields').disabled, true);
        assert.match(f.node('orderManualError').textContent, /信息不完整/);
    }
    const f = fixture(), data = control();
    data.actions[2].enabled = false;
    f.request(async () => ({ data })); await f.open();
    f.node('orderManualReason').value = '已核对'; f.node('orderManualAction').value = 'success';
    await f.api.saveOrderManualControl();
    assert.match(f.node('orderManualError').textContent, /当前可执行/);
    assert.equal(f.calls.filter(call => call.body).length, 0);
});
