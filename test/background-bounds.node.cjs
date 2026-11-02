'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name), module = { exports: {} }, real = createRequire(filename);
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports);
    return module.exports;
}
function credentials(t) {
    const saved = [process.env.ORBITCARD_API_KEY, process.env.ORBITCARD_API_SECRET];
    process.env.ORBITCARD_API_KEY = 'bounds-test-key'; process.env.ORBITCARD_API_SECRET = 'bounds-test-secret';
    t.after(() => ['ORBITCARD_API_KEY', 'ORBITCARD_API_SECRET'].forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }));
}
test('slow Orbitcard requests have bounded concurrency and response size, and failures release slots', async t => {
    credentials(t);
    const pending = [], calls = [];
    const api = load('orbitcard-client.js', { './runtime-log': { push() {} }, axios: { request: options => {
        calls.push(options); return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } } });
    const requests = Array.from({ length: 32 }, () => api.request({}, 'getAccountBalance'));
    const busy = await api.request({}, 'getAccountBalance');
    assert.equal(busy.status, 503); assert.equal(calls.length, 32);
    for (const options of calls) {
        assert.equal(options.maxContentLength, 2 * 1024 * 1024);
        assert.ok(options.signal instanceof AbortSignal);
        assert.ok(options.timeout <= 45000);
    }
    pending.forEach(item => item.reject(Error('upstream down')));
    await Promise.all(requests);
    const next = api.request({}, 'getAccountBalance');
    assert.equal(calls.length, 33);
    pending.at(-1).resolve({ status: 200, data: { code: 0, data: {} } });
    assert.equal((await next).success, true);
});
test('untrusted Retry-After values cannot create infinite cooldowns', async t => {
    credentials(t);
    let calls = 0;
    const api = load('orbitcard-client.js', { './runtime-log': { push() {} }, axios: { request: async () => {
        calls++; return { status: 429, headers: { 'retry-after': '1e300' }, data: {} };
    } } });
    const first = await api.request({}, 'getAccountBalance');
    assert.equal(first.retryAfterMs, 86400000);
    const second = await api.request({}, 'getAccountBalance');
    assert.equal(calls, 1); assert.ok(second.retryAfterMs > 86000000 && second.retryAfterMs <= 86400000);
});
test('query cache stays bounded and retains recent order cooldowns', async () => {
    let calls = 0;
    const query = load('orbitcard-query.js', {
        './orbitcard-client': { request: async () => { calls++; return { success: false, retryAfterMs: Infinity }; } },
        './orbitcard-cdk': {}
    });
    const input = key => ({ cfg: { base_url: 'https://orbitcard.test' }, task: {
        job_key: key, orbitcard_client_order_no: key, orbitcard_base_url: 'https://orbitcard.test'
    } });
    for (let index = 0; index <= 1000; index++) await query.refresh(input(`order-${index}`));
    const recent = await query.refresh(input('order-1000'));
    assert.equal(calls, 1001); assert.ok(Number.isFinite(recent.retryAfterMs));
    assert.ok(recent.retryAfterMs <= 86400000);
    await query.refresh(input('order-0')); assert.equal(calls, 1002);
});
test('background failures back off progressively and successful queries reset the delay', async () => {
    let clock = 100000, calls = 0, success = false;
    const task = { job_key: 'job', cdk_code: 'code', orbitcard_state: 'pending' };
    const recovery = require('../order-recovery')({ now: () => clock, activeJobs: new Set(), audit() {},
        store: {
            acquirePaymentLock: async () => ({ assertOwned: async () => {}, release: async () => {} }),
            getTaskStatus: async () => task, listRecoverableOrbitcardTasks: async () => [task],
            getGptApiConfig: async () => ({}), noteQueryAttempt: async () => {}
        }, query: { refresh: async () => { calls++; return { success }; } }
    });
    await recovery.recover(); assert.equal(calls, 1);
    clock += 30000; await recovery.recover(); assert.equal(calls, 2);
    clock += 30000; await recovery.recover(); assert.equal(calls, 2);
    clock += 30000; await recovery.recover(); assert.equal(calls, 3);
    clock += 119999; await recovery.recover(); assert.equal(calls, 3);
    clock++; success = true; await recovery.recover(); assert.equal(calls, 4);
    clock += 10000; await recovery.recover(); assert.equal(calls, 5);
});
test('Telegram uses bounded concurrency and deduplicates shared notification destinations', async () => {
    const pending = [], calls = [];
    const telegram = load('telegram-notify.js', { axios: { post: async (...args) => {
        calls.push(args); await new Promise(resolve => pending.push(resolve)); return { data: { ok: true } };
    } } });
    const requests = Array.from({ length: 8 }, () => telegram.sendTelegramMessage('bot', 'chat', 'test'));
    assert.equal((await telegram.sendTelegramMessage('bot', 'chat', 'overflow')).ok, false);
    assert.equal(calls.length, 8);
    assert.equal(calls[0][2].maxContentLength, 16384);
    pending.forEach(resolve => resolve()); await Promise.all(requests);
    const notification = telegram.dispatchTelegramNotification({ bot_token: 'bot', on_success: true,
        notify_admin: true, admin_chat_id: 'chat', notify_group: true, group_chat_id: 'chat' }, 'success');
    assert.equal(calls.length, 9);
    pending.at(-1)(); assert.equal((await notification).sent, 1);
});
