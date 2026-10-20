'use strict';

// The bounded UI cache is separate from the append-only on-disk audit files.
const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./log-safety');
const MAX_ENTRIES = 15000;
const LOG_DIR = path.resolve(process.env.TASK_LOG_DIR || path.join(__dirname, 'data', 'logs'));
let seq = Date.now() * 1000;
const buffer = [];
let initialized = false;

function taskFile(jobKey) {
    const key = String(jobKey || '');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('无效的任务日志标识');
    return path.join(LOG_DIR, `task-${key}.jsonl`);
}

function initialize() {
    if (initialized) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Restore the latest day's cache. Older history remains in daily/task files.
    const files = fs.readdirSync(LOG_DIR).filter(name => /^runtime-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    const latest = files.at(-1);
    if (latest) {
        const filename = path.join(LOG_DIR, latest);
        const size = fs.statSync(filename).size;
        const start = Math.max(0, size - 8 * 1024 * 1024);
        const fd = fs.openSync(filename, 'r');
        let content;
        try {
            const tail = Buffer.alloc(size - start);
            fs.readSync(fd, tail, 0, tail.length, start);
            content = tail.toString('utf8');
        } finally { fs.closeSync(fd); }
        if (start > 0) content = content.slice(content.indexOf('\n') + 1);
        const records = content.split('\n').slice(-MAX_ENTRIES - 1);
        for (const line of records) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                buffer.push(entry);
                seq = Math.max(seq, Number(entry.id) + 1 || 0);
            } catch (_) { /* a crash may leave an incomplete final line */ }
        }
    }
    initialized = true;
}

function push(input) {
    initialize();
    const entry = {
        id: seq = Math.max(seq + 1, Date.now() * 1000),
        ts: Date.now(), pid: process.pid,
        jobKey: String(input.jobKey || '').slice(0, 80),
        level: String(input.level || 'log').slice(0, 24),
        source: String(input.source || '').slice(0, 64),
        event: String(input.event || 'log'),
        text: sanitize(String(input.text || '').replace(/\r/g, '')),
        ...(input.data ? { data: sanitize(input.data) } : {})
    };
    if (!entry.text.trim() && !entry.data) return;
    const line = `${JSON.stringify(entry)}\n`;
    // A logging failure is surfaced instead of silently discarding payment evidence.
    fs.appendFileSync(path.join(LOG_DIR, `runtime-${new Date(entry.ts).toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 });
    if (entry.jobKey) fs.appendFileSync(taskFile(entry.jobKey), line, { mode: 0o600 });
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
    return entry;
}

function tail(limit) {
    initialize();
    return buffer.slice(-Math.min(MAX_ENTRIES, Math.max(1, Number(limit) || 500)));
}

function after(afterId, limit) {
    initialize();
    return buffer.filter(entry => entry.id > Math.max(0, Number(afterId) || 0))
        .slice(0, Math.min(2000, Math.max(1, Number(limit) || 500)));
}

function clear() { initialize(); buffer.length = 0; }
function stats() { initialize(); return { count: buffer.length, nextSeq: seq + 1 }; }
module.exports = { push, tail, after, clear, stats, taskFile, initialize, LOG_DIR };
