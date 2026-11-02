'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const createService = require('../order-status-service');

function fixture() {
    const task = { job_key: 'job-1', cdk_code: 'CODE-1', orbitcard_client_order_no: 'order-1', status: 'manual', orbitcard_state: 'manual' };
    const code = {}, writes = [], events = [];
    let locked = false;
    const update = createService({
        getTaskStatus: async () => task,
        acquirePaymentLock: async () => locked ? null : ({ assertOwned: async () => {}, release: async () => events.push('released') }),
        withTransaction: async fn => fn({}),
        runQuery: async sql => [sql.includes('cdk_codes') ? code : task],
        runExecute: async (sql, args) => writes.push({ sql, args }),
        settleCardUse: async (...args) => events.push(['card', ...args]),
        enqueueRedemption: async (...args) => events.push(['redemption', ...args])
    });
    return { task, code, writes, events, lock() { locked = true; },
        save: (input = {}) => update({ jobKey: 'job-1', status: 'success', expectedStatus: 'manual', reason: '已核对订阅', adminEmail: 'admin@example.com', ...input }) };
}
test('manual success updates task, reserves CDK, settles card, enqueues redemption and audits', async () => {
    const f = fixture(); await f.save();
    assert.equal(f.writes[0].args[0], 'success');
    assert.equal(f.writes[0].args[3], 'success');
    assert.match(f.writes[1].sql, /COALESCE/);
    assert.equal(f.writes[2].args[0], 'order_status_changed');
    assert.ok(f.events.some(e => e[0] === 'redemption'));
    assert.equal(f.events.at(-1), 'released');
});
test('manual failure stops payment and retains CDK without redemption notification', async () => {
    const f = fixture(); await f.save({ status: 'failed' });
    assert.equal(f.writes[0].args[3], 'support_locked');
    assert.equal(f.events.some(e => e[0] === 'redemption'), false);
});
test('manually redeemed CDK allows original order failure without undoing redemption or resuming payment', async () => {
    const f = fixture();
    Object.assign(f.code, {
        used_at: '2026-11-01', manual_redeemed_at: '2026-11-02',
        manual_redeemed_by: 'admin@example.com', manual_redemption_reason: 'Delivered separately'
    });
    await f.save({ status: 'failed' });
    assert.equal(f.writes[0].args[0], 'failed');
    assert.equal(f.writes[0].args[3], 'support_locked');
    const cdkWrites = f.writes.filter(w => /UPDATE cdk_codes/.test(w.sql));
    assert.equal(cdkWrites.length, 1);
    assert.equal(cdkWrites[0].sql, 'UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?');
    assert.ok(f.events.some(e => e[0] === 'card' && e[1] === 'job-1' && e[2] === 'failed'));
    assert.equal(f.events.some(e => e[0] === 'redemption'), false);
    assert.equal(f.writes[2].args[0], 'order_status_changed');
    const automation = require('../payment-automation')({ runQuery: async sql => [sql.includes('cdk_codes')
        ? { ...f.code, is_active: 1 } : { ...f.task, status: 'failed', orbitcard_state: 'support_locked' }] });
    assert.equal((await automation.paymentOwner('job-1')).allowed, false);
    assert.equal(f.events.at(-1), 'released');
});

test('conflicting, stale and successful orders cannot be changed', async () => {
    for (const scenario of ['lock', 'stale', 'older', 'success', 'redeemed-success', 'reason']) {
        const f = fixture();
        if (scenario === 'lock') f.lock();
        if (scenario === 'stale') f.task.status = 'running';
        if (scenario === 'older') f.task.job_key = 'newer';
        if (scenario === 'redeemed-success') f.code.manual_redeemed_at = '2026-11-02';
        if (scenario.endsWith('success')) f.task.status = 'success';
        await assert.rejects(f.save({ status: 'failed', ...(scenario.endsWith('success') ? { expectedStatus: 'success' } : {}), ...(scenario === 'reason' ? { reason: ' ' } : {}) }), e => [400, 409].includes(e.status));
        assert.equal(f.writes.length, 0);
    }
});
test('notice closes after 5 seconds and replacing or dismissing it cancels its timer', () => {
    const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
    const nodes = { notice: {}, noticeText: {} }, timers = new Map();
    let id = 0;
    const notice = new Function('$', 'setTimeout', 'clearTimeout', `let noticeTimer = null; ${source.slice(source.indexOf('function notice('), source.indexOf("$('closeNotice')"))}; return notice;`)(
        key => nodes[key], (fn, ms) => { assert.equal(ms, 5000); timers.set(++id, fn); return id; }, key => timers.delete(key));
    notice('first'); notice('second');
    assert.equal(timers.size, 1); assert.equal(nodes.noticeText.textContent, 'second');
    [...timers.values()][0](); assert.equal(nodes.notice.hidden, true); assert.equal(timers.size, 0);
    notice('third'); notice(''); assert.equal(timers.size, 0);
});
test('order editor preserves failed edits, prevents duplicate saves and refreshes after success', async () => {
    const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
    const nodes = new Map(), calls = [];
    const $ = key => {
        if (!nodes.has(key)) nodes.set(key, { value: '', open: false, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } });
        return nodes.get(key);
    };
    let fail = true, refreshes = 0, release;
    const request = async (url, body) => {
        calls.push({ url, body });
        if (fail) throw Error('请重新验证二级密码');
        await new Promise(resolve => { release = resolve; });
        return { message: '已保存' };
    };
    const api = new Function('$', 'request', 'notice', 'loadOverview', `${source.slice(source.indexOf('let orderEditing ='), source.indexOf("document.addEventListener('click'"))}; return {editOrderStatus,saveOrderStatus};`)(
        $, request, () => {}, async () => { refreshes++; });
    api.editOrderStatus({ dataset: { editOrder: 'job/1', orderStatus: 'manual' } });
    $('orderEditStatus').value = 'success'; $('orderStatusReason').value = ' 核对完成 ';
    await api.saveOrderStatus();
    assert.equal($('orderStatusDialog').open, true);
    assert.equal($('orderStatusError').textContent, '请重新验证二级密码');
    assert.equal($('orderStatusReason').value, ' 核对完成 ');
    fail = false;
    const pending = api.saveOrderStatus();
    await api.saveOrderStatus(); assert.equal(calls.length, 2);
    assert.equal($('orderStatusFields').disabled, true);
    release(); await pending;
    assert.deepEqual(calls[1], { url: '/api/admin/orders/job%2F1/status', body: { status: 'success', expected_status: 'manual', reason: '核对完成' } });
    assert.equal($('orderStatusDialog').open, false);
    assert.equal($('orderStatusFields').disabled, false);
    assert.equal(refreshes, 1);
});
