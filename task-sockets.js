'use strict';
const { authorize } = require('./task-subscription');
const { limit } = require('./request-guard');

const MAX_BUFFER = 64 * 1024;
function send(ws, data) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFER) { ws.terminate(); return; }
    ws.send(JSON.stringify(data));
}

function attachTaskSockets(wss, { store, verifyAdminToken, publicOrder, clients, env = process.env,
    getClientIp = req => req.socket?.remoteAddress || 'unknown' }) {
    const maxConnections = limit(env.WS_MAX_CONNECTIONS, 200, 10000);
    const maxPerIp = limit(env.WS_MAX_CONNECTIONS_PER_IP, 5, 1000);
    const ips = new Map();
    let total = 0;
    wss.on('connection', (ws, req) => {
        const ip = getClientIp(req);
        if (total >= maxConnections || (ips.get(ip) || 0) >= maxPerIp) { ws.terminate(); return; }
        ips.set(ip, (ips.get(ip) || 0) + 1); total++;
        let jobKey = null, busy = false, closed = false, alive = true;
        let tokens = 30, last = Date.now(), subscriptions = 6, lastSubscribe = last;
        const unsubscribe = () => {
            if (jobKey) { clients.get(jobKey)?.delete(ws); if (!clients.get(jobKey)?.size) clients.delete(jobKey); }
            jobKey = null;
        };
        const subscriptionDeadline = setTimeout(() => { if (!jobKey) ws.terminate(); }, 30000);
        subscriptionDeadline.unref();
        const heartbeat = setInterval(() => {
            if (!alive || ws.bufferedAmount > MAX_BUFFER) return ws.terminate();
            alive = false; ws.ping();
        }, 30000);
        heartbeat.unref();
        ws.on('pong', () => { alive = true; });
        const cleanup = () => {
            if (closed) return;
            closed = true; unsubscribe();
            clearTimeout(subscriptionDeadline); clearInterval(heartbeat);
            total--;
            const count = (ips.get(ip) || 1) - 1;
            if (count) ips.set(ip, count); else ips.delete(ip);
        };
        ws.on('close', cleanup);
        ws.on('error', () => { cleanup(); ws.terminate(); });
        ws.on('message', async raw => {
            if (closed) return;
            const time = Date.now();
            tokens = Math.min(30, tokens + Math.max(0, time - last) / 2000); last = time;
            if (tokens < 1) { ws.close(1008, 'Too many messages'); return; }
            tokens--;
            let ownsBusy = false;
            try {
                const data = JSON.parse(raw);
                if (!data || typeof data !== 'object') return ws.close(1008, 'Invalid message');
                if (data.type === 'ping') return send(ws, { type: 'pong', ts: data.ts });
                if (data.type !== 'subscribe' || busy) return;
                subscriptions = Math.min(6, subscriptions + Math.max(0, time - lastSubscribe) / 10000); lastSubscribe = time;
                if (subscriptions < 1) return ws.close(1008, 'Too many subscriptions');
                subscriptions--;
                busy = true; ownsBusy = true;
                if (!await authorize(data, { store, verifyAdminToken })) return ws.close(1008, 'Unauthorized');
                if (closed || ws.readyState !== 1) return;
                unsubscribe(); jobKey = data.jobKey;
                clearTimeout(subscriptionDeadline);
                if (!clients.has(jobKey)) clients.set(jobKey, new Set());
                clients.get(jobKey).add(ws);
                const task = await store.getTaskStatus(jobKey);
                if (task) send(ws, { type: 'snapshot', ...publicOrder(task) });
            } catch (_) { ws.close(1008, 'Invalid message'); }
            finally { if (ownsBusy) busy = false; }
        });
    });
}

module.exports = { attachTaskSockets, send };
