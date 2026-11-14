'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const admin = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');

function requests() {
    const calls = [], timers = new Map();
    let nextTimer = 0;
    const context = vm.createContext({ AbortController,
        localStorage: { getItem: () => 'token' }, TOKEN_KEY: 'token', SECONDARY_KEY: 'secondary',
        logout() {}, $: () => ({}),
        setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            return new Promise((resolve, reject) => {
                calls.push({ url, options, resolve });
                options.signal.addEventListener('abort', () => reject(Error('aborted')));
            });
        }
    });
    vm.runInContext(admin.slice(admin.indexOf('const pendingRequests ='), admin.indexOf('async function perform(')), context);
    return { calls, timers, request: path => context.request(path),
        finish() { for (const call of calls) call.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }); } };
}
test('admin identical in-flight requests share one fetch and all requests have a concurrency limit', async () => {
    const f = requests(), first = f.request('/one');
    assert.equal(f.request('/one'), first);
    const pending = [first];
    for (let i = 1; i < 8; i++) pending.push(f.request(`/request-${i}`));
    await assert.rejects(f.request('/ninth'), /当前请求较多/);
    assert.equal(f.calls.length, 8);
    f.finish(); await Promise.all(pending);
    assert.equal(f.timers.size, 0);
    const retry = f.request('/one'); assert.equal(f.calls.length, 9); f.finish(); await retry;
});
test('admin timeout aborts pending fetch, removes dedup entry and allows an explicit retry', async () => {
    const f = requests(), pending = f.request('/hung');
    [...f.timers.values()][0]();
    await assert.rejects(pending, /请求超时.*查询原结果/);
    assert.equal(f.timers.size, 0);
    const retry = f.request('/hung'); assert.equal(f.calls.length, 2); f.finish(); await retry;
});
test('admin polling is serial and stops after its time budget or repeated failures', async () => {
    let now = 1000, tick, release, loads = 0;
    const context = vm.createContext({ Date: { now: () => now }, document: { hidden: false },
        selected: 'overview', autoRefreshStarted: now, autoRefreshBusy: false, autoRefreshFailures: 0,
        notice() {}, setInterval(fn) { tick = fn; },
        loadSelected: async () => { loads++; await new Promise(resolve => { release = resolve; }); }
    });
    vm.runInContext(admin.slice(admin.lastIndexOf('setInterval(async')), context);
    const pending = tick(); await tick(); assert.equal(loads, 1); release(); await pending;
    now += 15 * 60 * 1000; await tick(); assert.equal(loads, 1);
    assert.equal(context.autoRefreshStarted, 0);
    context.autoRefreshStarted = now; context.autoRefreshFailures = 5;
    await tick(); assert.equal(loads, 1); assert.equal(context.autoRefreshStarted, 0);
});
test('diagnostic polling backs off after errors and pauses after five failures', async () => {
    const source = fs.readFileSync(require.resolve('../public/diagnostics.js'), 'utf8');
    let now = 1000, tick, loads = 0;
    const nodes = { diagAutoLogs: { checked: true, addEventListener() {} }, diagTraceId: { value: 'job-1' }, diagRequestId: { value: '' }, diagLogState: {} };
    const context = vm.createContext({ Date: { now: () => now }, document: { hidden: false }, selected: 'diagnostics', selectedDiagnostic: 'trace',
        $: id => nodes[id], localStorage: { getItem: () => 'verified' }, SECONDARY_KEY: 'secondary',
        diagTrackingStarted: now, diagPollFailures: 0, diagNextPollAt: 0, diagPolling: false,
        diagPayBusy: false, diagOrder: null, setInterval(fn) { tick = fn; },
        diagReadLogs: async () => { loads++; throw Error('offline'); }
    });
    vm.runInContext(source.slice(source.lastIndexOf("$('diagAutoLogs').addEventListener")), context);
    await tick(); await tick(); assert.equal(loads, 1);
    assert.equal(context.diagNextPollAt, now + 20000);
    for (let i = 1; i < 5; i++) { now += 60000; await tick(); }
    await tick(); assert.equal(loads, 5); assert.equal(nodes.diagAutoLogs.checked, false);
    assert.match(nodes.diagLogState.textContent, /已暂停/);
});
