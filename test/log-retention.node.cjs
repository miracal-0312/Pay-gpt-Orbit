'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const retention = require('../log-retention');
function directory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-retention-'));
    t.after(() => { assert.ok(path.basename(root).startsWith('orbit-retention-')); fs.rmSync(root, { recursive: true, force: true }); });
    return root;
}
function logger(root) {
    const source = require.resolve('../runtime-log'), module = { exports: {} };
    new Function('require', 'module', '__dirname', 'process', fs.readFileSync(source, 'utf8'))(
        createRequire(source), module, path.dirname(source), { ...process, env: { TASK_LOG_DIR: root } });
    return module.exports;
}
test('retention deletes whole expired days without inspecting records and keeps today plus fourteen days', async t => {
    const root = directory(t), now = Date.parse('2026-11-20T12:00:00+08:00');
    for (const day of ['2026-11-05', '2026-11-06', '2026-11-20']) {
        fs.mkdirSync(path.join(root, day));
        fs.writeFileSync(path.join(root, day, 'task-example.jsonl'), 'not JSON: no record inspection needed');
        fs.writeFileSync(path.join(root, 'runtime-' + day + '.jsonl'), 'not JSON');
    }
    fs.writeFileSync(path.join(root, 'unrelated.jsonl'), 'keep');
    const cleanup = retention(root), pending = cleanup(now);
    assert.equal(cleanup(now), pending); await pending;
    assert.equal(fs.existsSync(path.join(root, '2026-11-05')), false);
    assert.equal(fs.existsSync(path.join(root, 'runtime-2026-11-05.jsonl')), false);
    for (const day of ['2026-11-06', '2026-11-20']) assert.equal(fs.existsSync(path.join(root, day, 'task-example.jsonl')), true);
    assert.equal(fs.readFileSync(path.join(root, 'unrelated.jsonl'), 'utf8'), 'keep');
    assert.equal(retention.logDay(Date.parse('2026-11-19T16:00:00Z')), '2026-11-20');
    assert.equal(retention.oldestDay(now), '2026-11-06');
});
test('legacy task files expire by modification day and unrelated files in old directories are preserved', async t => {
    const root = directory(t), now = Date.now(), old = new Date(now - 16 * retention.DAY_MS);
    const legacy = path.join(root, 'task-old.jsonl'); fs.writeFileSync(legacy, 'old'); fs.utimesSync(legacy, old, old);
    fs.writeFileSync(path.join(root, 'task-new.jsonl'), 'recent');
    fs.mkdirSync(path.join(root, '2020-01-01')); fs.writeFileSync(path.join(root, '2020-01-01', 'keep.txt'), 'keep');
    await retention(root)(now);
    assert.equal(fs.existsSync(legacy), false); assert.equal(fs.existsSync(path.join(root, 'task-new.jsonl')), true);
    assert.equal(fs.existsSync(path.join(root, '2020-01-01', 'keep.txt')), true);
});
test('daily task shards paginate and download together, resetting the cursor after an old day expires', async t => {
    const root = directory(t), logs = logger(root), now = Date.now();
    const yesterday = retention.logDay(now - retention.DAY_MS), today = retention.logDay(now);
    for (const day of [yesterday, today]) fs.mkdirSync(path.join(root, day));
    const rows = count => Array.from({ length: count }, (_, index) => JSON.stringify({ ts: now, text: 'record-' + index }) + '\n').join('');
    fs.writeFileSync(path.join(root, yesterday, 'task-page.jsonl'), rows(201));
    fs.writeFileSync(path.join(root, today, 'task-page.jsonl'), rows(2));
    const first = await logs.readTask('page'), second = await logs.readTask('page', first.next_cursor, first.revision);
    assert.equal(first.entries.length, 200); assert.equal(second.entries.length, 3); assert.equal(second.has_more, false);
    const app = require('express')(); app.get('/download', (req, res) => logs.downloadTask('page', res));
    const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/download');
    assert.equal(response.status, 200); assert.equal((await response.text()).trim().split('\n').length, 203);
    await logs.cleanup(now + 14 * retention.DAY_MS);
    const reset = await logs.readTask('page', second.next_cursor, second.revision);
    assert.equal(reset.reset, true); assert.equal(reset.entries.length, 2);
});

test('cleanup wakes at Beijing midnight rather than hourly or 24 hours after startup', async () => {
    let now = Date.parse('2026-11-02T23:59:50+08:00'), cleared;
    const calls = [], timers = [];
    const stop = retention.scheduleDailyCleanup(async timestamp => { calls.push(timestamp); }, {
        now: () => now,
        setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
        clearTimer(timer) { cleared = timer; }
    });
    await new Promise(setImmediate);
    assert.deepEqual(calls, [now], 'startup catches up once');
    assert.equal(timers.length, 1); assert.equal(timers[0].delay, 10000);
    now += 10000; await timers[0].fn();
    assert.equal(calls.length, 2); assert.equal(retention.logDay(calls[1]), '2026-11-03');
    assert.equal(timers.length, 2); assert.equal(timers[1].delay, retention.DAY_MS);
    stop(); assert.equal(cleared, timers[1]);
});

test('cleanup errors wait until the next midnight and shutdown prevents rescheduling an active cleanup', async () => {
    const errors = [], timers = [];
    const stop = retention.scheduleDailyCleanup(async () => { throw Error('disk busy'); }, {
        now: () => Date.parse('2026-11-02T12:00:00+08:00'), onError: error => errors.push(error.message),
        setTimer(fn, delay) { timers.push({ fn, delay }); return { unref() {} }; }, clearTimer() {}
    });
    await new Promise(setImmediate);
    assert.deepEqual(errors, ['disk busy']); assert.equal(timers[0].delay, 12 * 60 * 60 * 1000); stop();
    let finish, scheduled = false;
    const cancel = retention.scheduleDailyCleanup(() => new Promise(resolve => { finish = resolve; }), {
        setTimer() { scheduled = true; return { unref() {} }; }, clearTimer() {}
    });
    cancel(); finish(); await new Promise(setImmediate); assert.equal(scheduled, false);
});
