'use strict';

// Bounded UI previews are separate from disk audit records retained for 15 days.
const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./log-safety');
const { limit: positiveLimit } = require('./request-guard');
const createRetention = require('./log-retention');
const { logDay, oldestDay, cutoffTime, DAY_MS } = createRetention;
const MAX_ENTRIES = positiveLimit(process.env.LOG_CACHE_ENTRIES, 2000, 15000);
const MAX_CACHE_BYTES = positiveLimit(process.env.LOG_CACHE_BYTES, 4 * 1024 * 1024, 32 * 1024 * 1024);
const defaultDirectory = process.platform === 'win32'
    ? path.join(`${process.env.SystemDrive || 'C:'}\\`, 'ProgramData', 'Pay-gpt-Orbit', 'logs') : '/var/log/pay-gpt-orbit';
const LOG_DIR = path.resolve(process.env.TASK_LOG_DIR || defaultDirectory);
const cleanup = createRetention(LOG_DIR);
let seq = Date.now() * 1000;
// Keep serialized previews, not large object graphs. A ring releases old entries without shifting arrays.
const buffer = new Array(MAX_ENTRIES);
let head = 0, count = 0, cacheBytes = 0;
let initialized = false;

function cacheEntry(entry, line = JSON.stringify(entry)) {
    if (entry.ts < cutoffTime()) return;
    if (line.length * 2 > Math.min(MAX_CACHE_BYTES, 65536)) {
        line = JSON.stringify({ ...entry, text: `${entry.text.slice(0, 4096)}\n[日志预览已缩短，完整内容请下载日志]`,
            data: undefined, cache_truncated: true });
    }
    const bytes = line.length * 2;
    if (bytes > MAX_CACHE_BYTES) return;
    while (count && (count === MAX_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES)) {
        cacheBytes -= buffer[head].bytes;
        buffer[head] = undefined; head = (head + 1) % MAX_ENTRIES; count--;
    }
    buffer[(head + count) % MAX_ENTRIES] = { id: entry.id, ts: entry.ts, line, bytes };
    count++; cacheBytes += bytes;
}

function taskFile(jobKey, day = logDay()) {
    const key = String(jobKey || '');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('无效的任务日志标识');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('无效的日志日期');
    return path.join(LOG_DIR, day, `task-${key}.jsonl`);
}

function initialize() {
    if (initialized) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Restore the latest day's cache. Older history remains in daily/task files.
    const directory = fs.opendirSync(LOG_DIR);
    let latest = '', file;
    try {
        while ((file = directory.readSync())) {
            if (/^runtime-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.name) && file.name > latest) latest = file.name;
        }
    } finally { directory.closeSync(); }
    if (latest) {
        const filename = path.join(LOG_DIR, latest);
        const size = fs.statSync(filename).size;
        const start = Math.max(0, size - Math.min(MAX_CACHE_BYTES, 1024 * 1024));
        const fd = fs.openSync(filename, 'r');
        let content;
        try {
            const tail = Buffer.alloc(size - start);
            fs.readSync(fd, tail, 0, tail.length, start);
            content = tail.toString('utf8');
        } finally { fs.closeSync(fd); }
        if (start > 0) content = content.slice(content.indexOf('\n') + 1);
        let offset = 0, end;
        while ((end = content.indexOf('\n', offset)) !== -1) {
            const line = content.slice(offset, end); offset = end + 1;
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                cacheEntry(entry);
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
    const day = logDay(entry.ts);
    fs.appendFileSync(path.join(LOG_DIR, `runtime-${day}.jsonl`), line, { mode: 0o600 });
    if (entry.jobKey) {
        const filename = taskFile(entry.jobKey, day);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.appendFileSync(filename, line, { mode: 0o600 });
    }
    cacheEntry(entry, line);
    return entry;
}

function tail(limit) {
    initialize();
    expireCache();
    const length = Math.min(count, Math.max(1, Math.floor(Number(limit) || 500)));
    return Array.from({ length }, (_, index) => JSON.parse(buffer[(head + count - length + index) % MAX_ENTRIES].line));
}

function after(afterId, limit) {
    initialize();
    expireCache();
    const entries = [], after = Math.max(0, Number(afterId) || 0);
    const length = Math.min(2000, Math.max(1, Math.floor(Number(limit) || 500)));
    for (let index = 0; index < count && entries.length < length; index++) {
        const entry = buffer[(head + index) % MAX_ENTRIES];
        if (entry.id > after) entries.push(JSON.parse(entry.line));
    }
    return entries;
}

function clear() { initialize(); buffer.fill(undefined); head = count = cacheBytes = 0; }
function expireCache() {
    const cutoff = cutoffTime();
    while (count && buffer[head].ts < cutoff) {
        cacheBytes -= buffer[head].bytes; buffer[head] = undefined;
        head = (head + 1) % MAX_ENTRIES; count--;
    }
}
function stats() { initialize(); expireCache(); return { count, nextSeq: seq + 1, cacheBytes, maxCacheBytes: MAX_CACHE_BYTES, maxEntries: MAX_ENTRIES }; }
async function taskFiles(jobKey, now = Date.now()) {
    const name = path.basename(taskFile(jobKey)), files = [];
    const legacy = path.join(LOG_DIR, name);
    const candidates = [legacy, ...Array.from({ length: 15 }, (_, index) => taskFile(jobKey, logDay(now - (14 - index) * DAY_MS)))];
    for (const filename of candidates) {
        try {
            const info = await fs.promises.lstat(filename);
            if (!info.isFile() || (filename === legacy && logDay(info.mtimeMs) < oldestDay(now))) continue;
            files.push({ filename, info });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return files;
}

async function downloadTask(jobKey, res) {
    const files = await taskFiles(jobKey);
    if (!files.length) return res.status(404).json({ success: false, message: '没有最近 15 天的任务日志' });
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': 'attachment; filename="task-' + jobKey + '.jsonl"' });
    for (const { filename } of files) {
        if (res.destroyed) return;
        const stream = fs.createReadStream(filename);
        const close = () => stream.destroy();
        res.once('close', close);
        try {
            for await (const chunk of stream) {
                if (res.destroyed) return;
                if (!res.write(chunk)) await new Promise(resolve => {
                    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                    res.once('drain', done); res.once('close', done);
                });
            }
        } finally { res.off('close', close); stream.destroy(); }
    }
    res.end();
}

async function readTask(jobKey, cursor = 0, revision = '') {
    let offset = Number(cursor);
    if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的日志位置');
    const files = await taskFiles(jobKey);
    const currentRevision = require('node:crypto').createHash('sha256')
        .update(files.map(({ filename, info }) => filename + ':' + info.ino + ':' + info.birthtimeMs).join('|')).digest('hex').slice(0, 24);
    const reset = Boolean(revision && revision !== currentRevision);
    if (reset) offset = 0;
    const total = files.reduce((sum, file) => sum + file.info.size, 0);
    if (offset > total) throw new Error('日志位置超过文件长度');
    const entries = [];
    let base = 0, remaining = 1024 * 1024, incomplete = false;
    for (const { filename, info } of files) {
        if (offset >= base + info.size) { base += info.size; continue; }
        if (entries.length >= 200 || !remaining) break;
        const handle = await fs.promises.open(filename, 'r');
        try {
            const position = offset - base;
            if (position) {
                const previous = Buffer.alloc(1); await handle.read(previous, 0, 1, position - 1);
                if (previous[0] !== 10) throw new Error('日志位置不是记录边界');
            }
            const chunk = Buffer.alloc(Math.min(remaining, info.size - position));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
            const data = chunk.subarray(0, bytesRead), end = data.lastIndexOf(10);
            remaining -= bytesRead;
            if (end < 0) {
                if (bytesRead === 1024 * 1024) throw new Error('单条日志超过读取上限，请下载日志');
                if (position + bytesRead === info.size && filename !== files.at(-1).filename) {
                    offset = base + info.size; base += info.size; continue;
                }
                incomplete = position + bytesRead === info.size;
                break;
            }
            let consumed = 0;
            while (consumed <= end && entries.length < 200) {
                const boundary = data.indexOf(10, consumed);
                const line = data.toString('utf8', consumed, boundary); consumed = boundary + 1;
                if (!line.trim()) continue;
                try { entries.push(sanitize(JSON.parse(line))); } catch (_) { /* incomplete historical record */ }
            }
            offset += consumed;
            if (offset < base + info.size) break;
        } finally { await handle.close(); }
        base += info.size;
    }
    return { entries, next_cursor: offset, has_more: !incomplete && offset < total,
        exists: files.length > 0, revision: currentRevision, reset };
}
module.exports = { push, tail, after, clear, stats, taskFile, initialize, LOG_DIR, readTask, downloadTask, cleanup };
