'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    const nodes = new Map(), timers = new Map(), delays = new Map(), calls = [];
    let nextTimer = 0, response = null;
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, style: {}, children: [],
            handlers: {}, attributes: {}, textContent: '', parentElement: { setAttribute() {} },
            setAttribute(key, value) { this.attributes[key] = value; }, focus() {},
            addEventListener(event, handler) { this.handlers[event] = handler; },
            replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
        return nodes.get(id);
    };
    const context = vm.createContext({ URL, Date, AbortController,
        document: { getElementById: node, querySelectorAll: () => [], createElement: () => ({}) },
        setTimeout: (fn, delay) => { timers.set(++nextTimer, fn); delays.set(nextTimer, delay); return nextTimer; },
        clearTimeout: id => { timers.delete(id); delays.delete(id); }, setInterval() {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url === '/api/public/runtime') return { ok: true, json: async () => ({ success: false }) };
            if (typeof response === 'function') return response(url, options);
            if (response instanceof Error) throw response;
            return { ok: true, json: async () => response };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    vm.runInContext("activeCdk = 'CODE-TEST'; activeJob = 'job-1'; activePlanLabel = 'Plus';", context);
    return { node, timers, calls, context, respond(value) { response = value; },
        fireTimeout(delay) {
            const id = [...delays].find(([id, ms]) => ms === delay && timers.has(id))?.[0];
            assert.ok(id, `Expected a ${delay} ms timer`);
            const fn = timers.get(id); timers.delete(id); delays.delete(id); fn();
        },
        refresh: () => vm.runInContext('refresh(false)', context) };
}
const flush = () => new Promise(setImmediate);
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('querying a waiting retry keeps the Session form usable for the same order', async () => {
    const f = setup();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'retry' } });
    await f.refresh();
    assert.equal(f.node('redeemForm').hidden, false);
    f.node('cdkInput').value = 'CODE-TEST';
    f.node('sessionInput').value = '{"accessToken":"test"}';
    f.respond({ success: true, provider: 'orbitcard', jobKey: 'job-1', status: 'running' });
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    assert.equal(f.node('sessionInput').value, '');
    assert.equal(f.node('redeemForm').hidden, true);
});

test('unconfirmed queries and transport errors remove stale captcha links', async () => {
    for (const response of [{ success: false, message: 'unconfirmed' }, new Error('network')]) {
        const f = setup();
        vm.runInContext("challenge({url:'https://example.test/verify',expires_at:new Date(Date.now()+60000).toISOString()})", f.context);
        assert.equal(f.node('captchaBox').children.length, 1);
        f.respond(response); await f.refresh();
        assert.equal(f.node('captchaBox').children.length, 0);
    }
});

test('manual refresh continues automatic polling and terminal results stop it', async () => {
    const f = setup();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'running' } });
    await vm.runInContext('startTracking()', f.context);
    assert.equal(f.timers.size, 1);
    await f.node('refreshBtn').handlers.click();
    assert.equal(f.timers.size, 1, 'manual refresh must retain exactly one polling timer');
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'success' } });
    await f.node('refreshBtn').handlers.click();
    assert.equal(f.timers.size, 0);
});

test('released CDKs require a fresh verification while reserved or unknown failures cannot retry', async () => {
    for (const state of ['available', 'reserved', undefined]) {
        const f = setup();
        f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'failed', cdk_state: state } });
        await f.refresh();
        assert.equal(f.node('retryBtn').hidden, state !== 'available');
        assert.equal(f.node('redeemForm').hidden, true);
        if (state !== 'available') continue;
        f.node('cdkInput').value = 'CODE-TEST';
        f.respond({ success: true, data: { type: '自助', status: 'unused', plan_label: 'Plus' } });
        await f.node('retryBtn').handlers.click({ preventDefault() {} });
        assert.equal(f.node('redeemForm').hidden, false);
        assert.equal(f.node('progressBox').hidden, true);
        assert.equal(f.node('retryBtn').hidden, true);
        assert.equal(f.calls.at(-1).url, '/api/verify-cdk');
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    }
});

test('hanging queries time out, release the button and schedule a bounded retry', async () => {
    const f = setup(); await flush();
    f.respond((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = vm.runInContext('startTracking()', f.context);
    assert.equal(f.node('refreshBtn').disabled, true);
    f.fireTimeout(30000); await pending;
    assert.equal(f.node('refreshBtn').disabled, false);
    assert.match(f.node('statusMessage').textContent, /请求超时/);
    assert.equal(f.timers.size, 1);
});

test('a timed-out submission queries the original CDK without submitting again', async () => {
    const f = setup(); await flush();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = '{"accessToken":"test"}';
    f.respond((url, options) => url === '/api/run-process'
        ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        : reply({ success: true, data: { provider: 'orbitcard', jobKey: 'accepted-job', status: 'running', cdk_state: 'reserved' } }));
    const pending = f.node('redeemForm').handlers.submit({ preventDefault() {} });
    f.fireTimeout(30000); await pending; await flush();
    assert.equal(f.node('startBtn').disabled, false);
    assert.equal(f.node('redeemForm').hidden, true);
    assert.equal(f.node('retryBtn').hidden, true);
    assert.equal(f.node('sessionInput').value, '');
    assert.match(f.node('orderInfo').textContent, /accepted-job/);
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 1);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 1);
});

test('an old submission response cannot erase a new CDK Session', async () => {
    const f = setup(); let resolve;
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = '{"accessToken":"old"}';
    f.respond(() => new Promise(done => { resolve = done; }));
    const pending = f.node('redeemForm').handlers.submit({ preventDefault() {} });
    f.node('cdkInput').value = 'NEW-CODE'; f.node('cdkInput').handlers.input();
    f.node('sessionInput').value = '{"accessToken":"new"}';
    resolve(reply({ success: true, provider: 'orbitcard', jobKey: 'old-job' }));
    await pending;
    assert.equal(f.node('sessionInput').value, '{"accessToken":"new"}');
    assert.equal(f.node('orderInfo').textContent, '');
});

test('malformed server replies are distinct from invalid Session JSON and release controls', async () => {
    const f = setup();
    f.respond(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('HTML response'); } }));
    await f.refresh();
    assert.match(f.node('statusMessage').textContent, /服务端响应格式异常/);
    assert.equal(f.node('refreshBtn').disabled, false);
    assert.equal(f.timers.size, 0);
});

test('an explicitly rejected submission keeps the Session editable without starting a query', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = '{"accessToken":"test"}';
    f.respond(() => ({ ok:false, status:400, json:async () => ({success:false,message:'Session 已过期'}) }));
    await f.node('redeemForm').handlers.submit({preventDefault(){}});
    assert.match(f.node('statusMessage').textContent,/Session 已过期/);
    assert.equal(f.node('redeemForm').hidden,false);
    assert.equal(f.node('startBtn').disabled,false);
    assert.equal(f.node('sessionInput').value,'{"accessToken":"test"}');
    assert.equal(f.calls.filter(call=>call.url==='/api/cdk/orbitcard/status').length,0);
});
