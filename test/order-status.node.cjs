'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const createService = require('../src/payments/order-status-service');

test('legacy order status API delegates both results to the universal live financial guards', async () => {
    for (const status of ['success', 'failed']) {
        const calls = [];
        const update = createService({
            getOrderManualControl: async input => { calls.push(input); return { status: 'manual', revision: 'server-revision' }; },
            applyOrderManualControl: async input => { calls.push(input); return { status }; }
        });
        assert.deepEqual(await update({ jobKey: 'job-1', status, expectedStatus: 'manual', reason: '人工核对',
            adminEmail: 'admin@example.test' }), { status });
        assert.deepEqual(calls, [{ kind: 'task', id: 'job-1' }, { kind: 'task', id: 'job-1', action: status,
            expectedRevision: 'server-revision', reason: '人工核对', adminEmail: 'admin@example.test' }]);
    }
});

test('legacy API cannot bypass a stale status or a financial ownership conflict', async () => {
    let applied = 0;
    const update = createService({ getOrderManualControl: async () => ({ status: 'running', revision: 'new' }),
        applyOrderManualControl: async () => { applied++; throw Object.assign(new Error('原资金尚未核对'), { status: 409 }); } });
    const input = { jobKey: 'job-1', status: 'success', expectedStatus: 'manual', reason: '已核对' };
    await assert.rejects(update(input), error => error.status === 409 && /状态已变化/.test(error.message));
    assert.equal(applied, 0);
    await assert.rejects(update({ ...input, expectedStatus: 'running' }), error => error.status === 409 && /原资金/.test(error.message));
    assert.equal(applied, 1);
});

test('legacy API rejects missing preconditions and unsupported transitions before reading an order', async () => {
    const update = createService({ getOrderManualControl: async () => { throw Error('must not read'); } });
    for (const input of [{ status: 'running', expectedStatus: 'manual' }, { status: 'success' }, { status: 'failed', expectedStatus: '' }]) {
        await assert.rejects(update(input), error => error.status === 400);
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
