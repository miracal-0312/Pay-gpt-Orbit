'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DAY_MS = 86400000;
const TASK_NAME = /^task-[a-zA-Z0-9_-]{1,80}\.jsonl$/;
const logDay = (now = Date.now()) => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const oldestDay = (now = Date.now()) => logDay(now - 14 * DAY_MS);
const cutoffTime = (now = Date.now()) => Date.parse(oldestDay(now) + 'T00:00:00+08:00');
function validDay(day) {
    const time = Date.parse(day + 'T00:00:00Z');
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}

module.exports = function createRetention(directory) {
    const root = path.resolve(directory);
    let running;
    return function cleanup(now = Date.now()) {
        if (running) return running;
        running = (async () => {
            const cutoff = oldestDay(now), files = await fs.promises.opendir(root);
            for await (const file of files) {
                const target = path.resolve(root, file.name);
                if (path.dirname(target) !== root) continue;
                if (file.isDirectory() && validDay(file.name) && file.name < cutoff) {
                    const contents = await fs.promises.opendir(target);
                    for await (const entry of contents) {
                        if (entry.isFile() && TASK_NAME.test(entry.name)) await fs.promises.unlink(path.join(target, entry.name));
                    }
                    await fs.promises.rmdir(target).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
                } else if (file.isFile()) {
                    const runtime = file.name.match(/^runtime-(\d{4}-\d{2}-\d{2})\.jsonl$/);
                    const day = runtime && validDay(runtime[1]) ? runtime[1]
                        : TASK_NAME.test(file.name) ? logDay((await fs.promises.stat(target)).mtimeMs) : null;
                    if (day && day < cutoff) await fs.promises.unlink(target);
                }
            }
        })().finally(() => { running = null; });
        return running;
    };
};
function scheduleDailyCleanup(cleanup, { now = Date.now, onError = console.error,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer = null, stopped = false;
    async function run() {
        try { await cleanup(now()); }
        catch (error) { onError(error); }
        finally {
            if (!stopped) {
                const time = now();
                const nextMidnight = Date.parse(logDay(time) + 'T00:00:00+08:00') + DAY_MS;
                timer = setTimer(run, nextMidnight - time);
                timer.unref?.();
            }
        }
    }
    run(); // Catch up once after downtime, then wake only at the next calendar-day boundary.
    return () => { stopped = true; clearTimer(timer); };
}
Object.assign(module.exports, { logDay, oldestDay, cutoffTime, DAY_MS, scheduleDailyCleanup });
