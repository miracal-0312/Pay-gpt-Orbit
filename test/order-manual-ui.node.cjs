'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function control(kind = 'task', id = 'job/1', overrides = {}) {
    return { kind, id, revision: 'revision-1', status: 'manual', state: 'support_locked',
        manual_result: null, manual_result_reason: null, manual_result_by: null, manual_result_at: null,
        settlement: { allowed: true, reason: '' }, release: { allowed: true, reason: '', released: false }, actions: [
        { value: 'note', label: '记录处理备注', enabled: true },
        { value: 'pause', label: '暂停自动处理', enabled: true },
        { value: 'success', label: '人工交付完成', enabled: true },
        { value: 'failed', label: '人工确认失败', enabled: true }
    ], history: [], ...overrides };
}

function fixture() {
    const nodes = new Map(), calls = [], notices = [], refreshes = [];
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', checked: false, disabled: false, open: false, events: {},
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

test('lists show a manual result separately from the unresolved original funds and retain the original query', () => {
    const nodes = { tasks: {}, manualOrderRows: {} };
    const status = new Function('escapeHtml', `${source.slice(source.indexOf('function status('), source.indexOf('function renderTasks('))}; return status;`)(escapeHtml);
    const renderTasks = new Function('$', 'escapeHtml', 'status', `${source.slice(source.indexOf('function renderTasks('), source.indexOf('async function loadOverview('))}; return renderTasks;`)(id => nodes[id], escapeHtml, status);
    const renderManualOrders = new Function('$', 'escapeHtml', 'status', `${source.slice(source.indexOf('function renderManualOrders('), source.indexOf('async function loadManualOrders('))}; return renderManualOrders;`)(id => nodes[id], escapeHtml, status);
    for (const [manual_result, label] of [['success', '人工交付完成'], ['failed', '人工确认失败']]) {
        renderTasks([{ jobKey: 'job-1', provider: 'orbitcard', status: 'manual', orbitcard_state: 'funding_pending', manual_result, manual_local_released_at: '2026-11-17' }]);
        renderManualOrders([{ request_id: 'admin-1', client_order_no: 'original-1', state: 'funding_pending', manual_result, manual_local_released_at: '2026-11-17' }]);
        for (const node of Object.values(nodes)) {
            assert.ok(node.innerHTML.includes(`人工结果：${label}</strong></div><div>原平台／资金状态：`));
            assert.match(node.innerHTML, /class="pill funding_pending"/);
            assert.match(node.innerHTML, /本地占用：已释放/);
            assert.doesNotMatch(node.innerHTML, /class="pill success"|失败结案/);
        }
        assert.match(nodes.tasks.innerHTML, /data-refresh-order="job-1"/);
        assert.match(nodes.manualOrderRows.innerHTML, /data-refresh-manual="admin-1">核对原资金/);
        renderManualOrders([{ request_id: 'admin-1', state: 'retry_waiting', manual_result }]);
        assert.doesNotMatch(nodes.manualOrderRows.innerHTML, /data-retry-manual/);
    }
});

test('funding_pending can record external manual delivery without treating it as settled money or platform success', async () => {
    for (const kind of ['task', 'admin']) {
        const f = fixture(), id = `${kind}/pending`;
        let data = control(kind, id, { status: 'manual', state: 'funding_pending', settlement: { allowed: false, reason: '原补款仍需核对；可以先登记人工结果，保留支付卡占用' } });
        data.actions[2].reason = '可登记已用其他卡完成的交付；原资金继续核对';
        f.request(async (url, body) => {
            if (body) data = { ...data, manual_result: body.action, manual_result_reason: body.reason,
                manual_result_by: 'admin@example.test', manual_result_at: '2026-11-17 18:00:00', revision: 'revision-2' };
            return { data, message: '人工交付已记录，原资金继续核对' };
        });
        await f.open(kind, id);
        assert.match(f.node('orderManualSettlement').textContent, /仍需核对.*保留/);
        assert.match(f.node('orderManualAvailability').innerHTML, /可登记已用其他卡完成的交付/);
        assert.doesNotMatch(f.node('orderManualAction').innerHTML, /value="success" disabled/);
        f.node('orderManualAction').value = 'success'; f.node('orderManualReason').value = '已通过另一张卡完成人工交付';
        await f.api.saveOrderManualControl();
        assert.equal(f.calls.filter(call => call.body).length, 1);
        assert.equal(f.calls.find(call => call.body).body.action, 'success');
        assert.equal(f.calls.find(call => call.body).body.release_local_hold, false);
        assert.equal(f.node('orderManualDialog').open, false);
        assert.deepEqual(f.refreshes, [kind]);
        await f.open(kind, id);
        assert.match(f.node('orderManualResult').textContent, /人工交付完成.*admin@example\.test.*另一张卡/);
        assert.match(f.node('orderManualState').textContent, /manual \/ funding_pending/);
        assert.match(f.node('orderManualSettlement').textContent, /仍需核对.*保留/);
    }
});

test('recorded manual metadata and settlement warnings are plain text and reset when loading another order', async () => {
    const f = fixture(), payload = '<img src=x onerror="alert(1)">';
    for (const id of ['orderManualResult', 'orderManualSettlement']) {
        Object.defineProperty(f.node(id), 'innerHTML', { set() { throw Error('manual result details must use textContent'); } });
    }
    f.request(async () => ({ data: control('task', 'job/1', { manual_result: 'failed', manual_result_reason: payload,
        manual_result_by: payload, manual_result_at: payload, settlement: { allowed: false, reason: payload } }) }));
    await f.open();
    assert.match(f.node('orderManualResult').textContent, /人工确认失败/);
    assert.ok(f.node('orderManualResult').textContent.includes(payload));
    assert.ok(f.node('orderManualSettlement').textContent.includes(payload));
    f.request(async () => { throw Error('暂不可用'); });
    await f.open('admin', 'other');
    assert.doesNotMatch(f.node('orderManualResult').textContent, /人工确认失败|<img/);
    assert.equal(f.node('orderManualSettlement').textContent, '');
});

test('local release starts unchecked, is limited to success or failed, and sends an explicit boolean without another confirmation', async () => {
    for (const [kind, action] of [['task', 'success'], ['admin', 'failed']]) {
        const f = fixture();
        f.request(async () => ({ data: control(kind, 'job/1', { state: 'funding_pending', settlement: { allowed: false, reason: '原资金仍待核对' } }) }));
        await f.open(kind);
        assert.equal(f.node('orderManualRelease').checked, false);
        assert.equal(f.node('orderManualRelease').disabled, true);
        f.node('orderManualAction').value = 'success'; f.node('orderManualAction').events.change();
        assert.equal(f.node('orderManualRelease').disabled, false);
        f.node('orderManualRelease').checked = true;
        for (const other of ['note', 'pause']) {
            f.node('orderManualAction').value = other; f.node('orderManualAction').events.change();
            assert.equal(f.node('orderManualRelease').checked, false);
            assert.equal(f.node('orderManualRelease').disabled, true);
        }
        f.node('orderManualAction').value = action; f.node('orderManualAction').events.change();
        assert.equal(f.node('orderManualRelease').checked, false);
        assert.equal(f.node('orderManualRelease').disabled, false);
        f.node('orderManualRelease').checked = true; f.node('orderManualReason').value = '已处理客户交付，同时解除原单本地占用';
        f.request(async () => ({ message: '人工结果和本地释放已记录' }));
        await f.api.saveOrderManualControl();
        assert.equal(f.calls.at(-1).body.action, action);
        assert.equal(f.calls.at(-1).body.release_local_hold, true);
        assert.equal(f.node('orderManualDialog').open, false);
    }
    assert.match(html, /不会退款或撤销卡台请求；原扣款仍可能完成/);
});

test('local release ownership refusals stay visible and cannot be bypassed by toggling the disabled checkbox', async () => {
    const f = fixture();
    f.request(async () => ({ data: control('task', 'job/1', { release: { allowed: false, released: false, reason: '支付卡已属于另一订单' } }) }));
    await f.open();
    assert.match(f.node('orderManualReleaseState').textContent, /另一订单/);
    f.node('orderManualAction').value = 'failed'; f.node('orderManualAction').events.change();
    assert.equal(f.node('orderManualRelease').disabled, true);
    f.node('orderManualRelease').checked = true; f.node('orderManualReason').value = '已核对';
    await f.api.saveOrderManualControl();
    assert.equal(f.calls.filter(call => call.body).length, 0);
    assert.match(f.node('orderManualError').textContent, /不能释放本地占用/);
});

test('already released holds show the operator and audit without adding release as a selectable operation', async () => {
    const f = fixture(), payload = '<img src=x onerror=alert(1)>';
    Object.defineProperty(f.node('orderManualReleaseState'), 'innerHTML', { set() { throw Error('release metadata must use textContent'); } });
    const data = control('task', 'job/1', { state: 'funding_pending', manual_result: 'success',
        settlement: { allowed: false, reason: '原资金结果未知' }, release: { allowed: false, released: true, reason: '' },
        manual_local_released_by: payload, manual_local_released_at: '2026-11-17', manual_local_release_reason: payload,
        history: [{ action: 'release', reason: '原本地占用已解除' }, { action: 'success', release_local_hold: true, reason: '已交付' }] });
    data.actions.push({ value: 'release', enabled: true, label: '解除本地占用' });
    f.request(async () => ({ data })); await f.open();
    assert.match(f.node('orderManualReleaseState').textContent, /本地占用：已释放/);
    assert.ok(f.node('orderManualReleaseState').textContent.includes(payload));
    assert.match(f.node('orderManualSettlement').textContent, /原平台扣款仍可能完成/);
    assert.equal(f.node('orderManualRelease').disabled, true);
    assert.equal(f.node('orderManualRelease').checked, false);
    assert.match(f.node('orderManualHistory').innerHTML, /解除本地占用/);
    assert.match(f.node('orderManualHistory').innerHTML, /同时释放本地占用/);
    assert.doesNotMatch(f.node('orderManualAction').innerHTML, /value="release"/);
    f.node('orderManualAction').value = 'release'; f.node('orderManualReason').value = '篡改操作';
    await f.api.saveOrderManualControl();
    assert.equal(f.calls.filter(call => call.body).length, 0);
});

test('a failed local release save keeps its selection and a conflict requires fresh eligibility', async () => {
    const f = fixture(); await f.open();
    f.node('orderManualAction').value = 'success'; f.node('orderManualAction').events.change();
    f.node('orderManualRelease').checked = true; f.node('orderManualReason').value = '人工交付已完成';
    f.request(async () => { throw Object.assign(Error('二级验证已失效'), { httpStatus: 403 }); });
    await f.api.saveOrderManualControl();
    assert.equal(f.node('orderManualRelease').checked, true);
    assert.equal(f.node('orderManualAction').value, 'success');
    assert.equal(f.node('orderManualReason').value, '人工交付已完成');
    f.request(async () => { throw Object.assign(Error('占用已变化'), { httpStatus: 409 }); });
    await f.api.saveOrderManualControl();
    assert.equal(f.node('orderManualFields').disabled, true);
    const count = f.calls.length; await f.api.saveOrderManualControl(); assert.equal(f.calls.length, count);
    f.request(async () => ({ data: control('task', 'job/1', { release: { allowed: false, released: false, reason: '卡片已由新订单占用' } }) }));
    await f.api.loadOrderManualControl();
    assert.equal(f.node('orderManualRelease').checked, false);
    assert.equal(f.node('orderManualRelease').disabled, true);
    assert.match(f.node('orderManualReleaseState').textContent, /新订单/);
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
    assert.match(html, /人工确认不代表平台付款成功，默认保留未决占用/);
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
    assert.deepEqual(f.calls.at(-1), { url: '/api/admin/orders/job%2F1/manual', body: { action: 'failed', expected_revision: 'revision-1', reason: '核对后人工结案', release_local_hold: false } });
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
