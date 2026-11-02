'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function logsFixture(t, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-memory-'));
    t.after(() => { assert.ok(path.basename(dir).startsWith('orbit-memory-')); fs.rmSync(dir, { recursive: true, force: true }); });
    const filename = require.resolve('../runtime-log'), real = createRequire(filename);
    const load = () => {
        const module = { exports: {} };
        new Function('require', 'module', '__dirname', 'process', fs.readFileSync(filename, 'utf8'))(
            real, module, path.dirname(filename), { env: { TASK_LOG_DIR: dir, ...env } });
        return module.exports;
    };
    return { logs: load(), load };
}

test('log ring enforces count and character-byte budgets and preserves ordered pagination', t => {
    const { logs } = logsFixture(t, { LOG_CACHE_ENTRIES: '3', LOG_CACHE_BYTES: '1200' });
    let last;
    for (let i = 0; i < 20; i++) last = logs.push({ text: `entry-${i}` });
    assert.equal(logs.stats().count, 3);
    assert.ok(logs.stats().cacheBytes <= 1200);
    assert.deepEqual(logs.tail(2).map(row => row.text), ['entry-18', 'entry-19']);
    assert.deepEqual(logs.after(logs.tail(3)[0].id, 1).map(row => row.text), ['entry-18']);
    last.text = 'mutated outside cache';
    assert.equal(logs.tail(1)[0].text, 'entry-19');
    logs.clear(); assert.equal(logs.stats().count, 0); assert.equal(logs.stats().cacheBytes, 0);
});

test('oversized cache previews retain the complete disk audit and restore within limits', async t => {
    const { logs, load } = logsFixture(t, { LOG_CACHE_BYTES: '32768' });
    const text = '说明'.repeat(20000);
    logs.push({ jobKey: 'large-log', text, data: { detail: 'x'.repeat(80000) } });
    const preview = logs.tail(1)[0];
    assert.equal(preview.cache_truncated, true); assert.equal(preview.data, undefined);
    assert.ok(logs.stats().cacheBytes <= 32768);
    const disk = JSON.parse(fs.readFileSync(logs.taskFile('large-log'), 'utf8'));
    assert.equal(disk.text, text); assert.equal(disk.data.detail.length, 80000);
    for (let i = 0; i < 220; i++) logs.push({ jobKey: 'pagination', text: `中文-${i}` });
    const first = await logs.readTask('pagination'), second = await logs.readTask('pagination', first.next_cursor);
    assert.equal(first.entries.length, 200); assert.equal(second.entries.length, 20);
    assert.equal(second.entries[0].text, '中文-200');
    const restored = load(); assert.ok(restored.stats().cacheBytes <= 32768);
    assert.equal(restored.tail(1)[0].text, '中文-219');
});

test('log byte budget evicts data before the entry count limit', t => {
    const { logs } = logsFixture(t, { LOG_CACHE_ENTRIES: '1000', LOG_CACHE_BYTES: '8192' });
    for (let i = 0; i < 50; i++) logs.push({ text: `${i}:${'x'.repeat(1000)}` });
    assert.ok(logs.stats().count < 5); assert.ok(logs.stats().cacheBytes <= 8192);
    assert.ok(logs.tail(1)[0].text.startsWith('49:'));
});

test('idle query cache expiration frees results without a subsequent request', async () => {
    let now = 10000, cleanup, unref = false;
    const filename = require.resolve('../orbitcard-query'), real = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'Date', 'setInterval', fs.readFileSync(filename, 'utf8') + '\nmodule.exports.cacheSize = () => recent.size;')(
        id => id === './orbitcard-subscription-service' ? () => ({ query: async () => ({ success: false, retryAfterMs: 5000 }) }) : real(id),
        module, { now: () => now }, (fn, ms) => { assert.equal(ms, 30000); cleanup = fn; return { unref() { unref = true; } }; });
    await module.exports.refresh({ cfg: {}, task: { job_key: 'idle', orbitcard_client_order_no: 'order' } });
    assert.equal(module.exports.cacheSize(), 1); assert.equal(unref, true);
    now += 5001; cleanup(); assert.equal(module.exports.cacheSize(), 0);
});

test('browser diagnostic history limits both individual previews and total retained text', async () => {
    const source = fs.readFileSync(require.resolve('../public/diagnostics.js'), 'utf8');
    const nodes = { diagTraceId: { value: 'job' }, diagTraceLog: {}, diagLogState: {} };
    const context = vm.createContext({ Date, $: id => nodes[id], diagLogKey: 'job', diagLogSequence: 1,
        diagReading: false, diagLogCursor: 0, diagLogRevision: '', diagLogLines: [], diagLogChars: 0, DIAG_LOG_CHAR_LIMIT: 1024 * 1024,
        request: async () => ({ entries: Array.from({ length: 200 }, () => ({ text: 'x'.repeat(60000), ts: 1 })), next_cursor: 1, exists: true }) });
    vm.runInContext(source.slice(source.indexOf('async function diagReadLogs'), source.indexOf('function diagPlanRequired')), context);
    await context.diagReadLogs(); await context.diagReadLogs();
    assert.ok(context.diagLogChars <= 1024 * 1024);
    assert.ok(context.diagLogLines.every(line => line.length < 33000));
    assert.match(nodes.diagTraceLog.textContent, /预览已缩短/);
});
