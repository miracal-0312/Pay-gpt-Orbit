'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachTaskSockets, send } = require('../task-sockets');
class Socket extends EventEmitter {
    readyState = 1; bufferedAmount = 0; sent = [];
    send(value) { this.sent.push(JSON.parse(value)); }
    ping() {}
    terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
    close(code) { this.closeCode = code; this.terminate(); }
}
function fixture(env = {}, getTaskStatus = async () => ({ cdk_code: 'CDK-TEST' })) {
    const wss = new EventEmitter(), clients = new Map(), sockets = [];
    attachTaskSockets(wss, { env, clients, store: { getTaskStatus }, verifyAdminToken: () => null, publicOrder: () => ({ status: 'pending' }) });
    return { clients, connect(ip = 'one') { const ws = new Socket(); sockets.push(ws); wss.emit('connection', ws, { socket: { remoteAddress: ip } }); return ws; }, close() { for (const ws of sockets) ws.terminate(); } };
}
const subscribe = JSON.stringify({ type: 'subscribe', jobKey: 'job-1', cdk: 'CDK-TEST' });
test('WebSocket connections have per-IP and global limits and release capacity on close', t => {
    const f = fixture({ WS_MAX_CONNECTIONS: '2', WS_MAX_CONNECTIONS_PER_IP: '1' }); t.after(f.close);
    const first = f.connect(); assert.equal(first.terminated, undefined);
    assert.equal(f.connect().terminated, true);
    assert.equal(f.connect('two').terminated, undefined);
    assert.equal(f.connect('three').terminated, true);
    first.terminate(); assert.equal(f.connect().terminated, undefined);
});
test('subscription messages cannot launch parallel database queries and late results do not leak subscriptions', async t => {
    let calls = 0, release;
    const f = fixture({}, async () => { calls++; await new Promise(resolve => { release = resolve; }); return { cdk_code: 'CDK-TEST' }; }); t.after(f.close);
    const ws = f.connect();
    ws.emit('message', subscribe); for (let i = 0; i < 10; i++) ws.emit('message', subscribe);
    assert.equal(calls, 1);
    ws.terminate(); release(); await new Promise(setImmediate);
    assert.equal(calls, 1); assert.equal(f.clients.size, 0);
});
test('subscription and message floods close the socket and slow consumers are disconnected', async t => {
    let calls = 0;
    const f = fixture({}, async () => { calls++; return { cdk_code: 'CDK-TEST' }; }); t.after(f.close);
    const ws = f.connect();
    for (let i = 0; i < 7; i++) { ws.emit('message', subscribe); await new Promise(setImmediate); }
    assert.equal(ws.closeCode, 1008); assert.equal(calls, 12); assert.equal(f.clients.size, 0);
    const ping = f.connect(); for (let i = 0; i < 31; i++) ping.emit('message', '{"type":"ping"}');
    assert.equal(ping.closeCode, 1008);
    const slow = f.connect(); slow.bufferedAmount = 65537; send(slow, { message: 'update' });
    assert.equal(slow.terminated, true); assert.equal(slow.sent.length, 0);
});
