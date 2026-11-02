'use strict';

function limit(value, fallback, max = 100000) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

// Reject overload before parsing bodies, authenticating or opening database connections.
// Buckets have a bounded cardinality and refill gradually, avoiding a minute-boundary burst.
function createRequestGuard({ env = process.env, now = Date.now } = {}) {
    const perIp = limit(env.API_REQUESTS_PER_MINUTE, 180);
    const writesPerIp = limit(env.API_WRITES_PER_MINUTE, 30);
    const total = limit(env.API_TOTAL_REQUESTS_PER_MINUTE, 1200);
    const concurrent = limit(env.API_MAX_CONCURRENT, 64, 1000);
    const concurrentPerIp = limit(env.API_MAX_CONCURRENT_PER_IP, 12, 1000);
    const maxClients = limit(env.API_MAX_TRACKED_IPS, 10000);
    const clients = new Map();
    let globalTokens = total, globalAt = now(), active = 0, cleanupAt = globalAt;
    function reject(res, status, message, seconds) {
        res.set('Retry-After', String(seconds));
        return res.status(status).json({ success: false, message, retry_after_ms: seconds * 1000 });
    }
    return function requestGuard(req, res, next) {
        const path = req.path.toLowerCase().replace(/\/+$/, '');
        if (path !== '/api' && !path.startsWith('/api/')) return next();
        res.set('Cache-Control', 'no-store');
        const time = now();
        if (time >= cleanupAt) {
            for (const [key, entry] of clients) if (!entry.active && time - entry.at >= 60000) clients.delete(key);
            cleanupAt = time + 60000;
        }
        const key = req.ip || req.socket?.remoteAddress || 'unknown';
        let entry = clients.get(key);
        if (!entry) {
            if (clients.size >= maxClients) return reject(res, 503, '服务繁忙，请稍后再试', 5);
            entry = { tokens: perIp, writes: writesPerIp, at: time, active: 0 };
            clients.set(key, entry);
        }
        const elapsed = Math.max(0, time - entry.at) / 60000;
        entry.tokens = Math.min(perIp, entry.tokens + elapsed * perIp);
        entry.writes = Math.min(writesPerIp, entry.writes + elapsed * writesPerIp);
        entry.at = time;
        globalTokens = Math.min(total, globalTokens + Math.max(0, time - globalAt) / 60000 * total);
        globalAt = time;
        const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
            && !['/api/cdk/status', '/api/cdk/orbitcard/status', '/api/verify-cdk'].includes(path);
        const wait = Math.max((1 - entry.tokens) / perIp, (1 - globalTokens) / total,
            write ? (1 - entry.writes) / writesPerIp : 0);
        if (wait > 0) return reject(res, 429, '请求过于频繁，请稍后再试', Math.max(1, Math.ceil(wait * 60)));
        // Charge admission attempts even when concurrency is saturated.
        entry.tokens--; globalTokens--; if (write) entry.writes--;
        if (active >= concurrent || entry.active >= concurrentPerIp) return reject(res, 503, '请求处理中，请稍后再试', 2);
        active++; entry.active++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true; active--; entry.active--;
            res.removeListener('finish', release); res.removeListener('close', release);
        };
        res.once('finish', release); res.once('close', release);
        next();
    };
}

module.exports = { createRequestGuard, limit };
