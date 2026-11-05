'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');
const proxyaddr = require('proxy-addr');
const { WebSocket, WebSocketServer } = require('ws');

async function listen(t, handler, websocketOptions) {
    const server = http.createServer(handler), sockets = new Set();
    const wss = websocketOptions ? new WebSocketServer({ server, ...websocketOptions }) : null;
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    t.after(async () => {
        for (const socket of wss?.clients || []) socket.terminate();
        for (const socket of sockets) socket.destroy();
        if (wss) await new Promise(resolve => wss.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { wss, base: `http://127.0.0.1:${server.address().port}` };
}

test('mapped IPv6 trust subnets cannot expand trust to arbitrary IPv4 peers', () => {
    // GHSA-jqcg-44mw-7w3h: cover single and multiple subnet compilation paths.
    const peers = ['198.51.100.17', '::ffff:198.51.100.17', '10.1.2.3', '::ffff:10.1.2.3'];
    for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
        for (const ranges of [[subnet], [subnet, '2001:db8::/32']]) {
            const trust = proxyaddr.compile(ranges);
            for (const peer of peers) assert.equal(trust(peer), false, `${subnet} must not trust ${peer}`);
        }
    }
    for (const ranges of [['10.0.0.0/8'], ['::ffff:10.0.0.0/104'], ['::ffff:10.0.0.0/8', '10.0.0.0/8']]) {
        const trust = proxyaddr.compile(ranges);
        for (const peer of peers) assert.equal(trust(peer), peer.includes('10.1.2.3'));
    }
    const ipv6 = proxyaddr.compile(['2001:db8::/32']);
    assert.equal(ipv6('2001:db8::1'), true);
    assert.equal(ipv6('198.51.100.17'), false);
});

test('Express and WebSocket share proxy trust without accepting forged forwarded addresses', { timeout: 10000 }, async t => {
    const app = express(), forwarded = '198.51.100.17';
    app.get('/identity', (req, res) => res.json({ ip: req.ip, peer: req.socket.remoteAddress }));
    const { base, wss } = await listen(t, app, { maxPayload: 16384 });
    wss.on('connection', (socket, req) => {
        socket.on('error', () => {});
        socket.send(JSON.stringify({ ip: proxyaddr(req, app.get('trust proxy fn')), peer: req.socket.remoteAddress }));
    });
    const identities = async () => {
        const response = await fetch(`${base}/identity`, {
            headers: { 'X-Forwarded-For': forwarded }, signal: AbortSignal.timeout(3000)
        });
        assert.equal(response.status, 200);
        const httpIdentity = await response.json();
        const client = new WebSocket(base.replace('http:', 'ws:'), { headers: { 'X-Forwarded-For': forwarded } });
        const [message] = await once(client, 'message', { signal: AbortSignal.timeout(3000) });
        const socketIdentity = JSON.parse(message.toString());
        const closed = once(client, 'close', { signal: AbortSignal.timeout(3000) });
        client.close();
        await closed;
        assert.equal(socketIdentity.ip, httpIdentity.ip);
        return [httpIdentity, socketIdentity];
    };
    for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
        app.set('trust proxy', [subnet]);
        for (const identity of await identities()) assert.equal(identity.ip, identity.peer);
    }
    app.set('trust proxy', ['::ffff:127.0.0.0/104']);
    for (const identity of await identities()) assert.equal(identity.ip, forwarded);
});

test('real Axios preserves JSON bytes, disables redirects and bounds response bodies', { timeout: 10000 }, async t => {
    let redirectedRequests = 0;
    const { base } = await listen(t, (req, res) => {
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/destination' }); return res.end(); }
        if (req.url === '/destination') { redirectedRequests++; return res.end('redirect followed'); }
        if (req.url === '/large') return res.end('x'.repeat(4096));
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ raw: Buffer.concat(chunks).toString('utf8'), type: req.headers['content-type'] }));
        });
    });
    // Disable environment proxies so this test cannot leave loopback.
    const options = { proxy: false, timeout: 3000, maxRedirects: 0, validateStatus: () => true };
    const raw = JSON.stringify({ message: '\u4f9d\u8d56\u9a8c\u8bc1', amount: 20 });
    const response = await axios.request({ ...options, method: 'POST', url: `${base}/json`, data: raw,
        headers: { 'Content-Type': 'application/json' }, maxBodyLength: 1024, maxContentLength: 1024 });
    assert.equal(response.status, 200);
    assert.equal(response.data.raw, raw);
    assert.equal(response.data.type, 'application/json');
    const redirect = await axios.request({ ...options, url: `${base}/redirect` });
    assert.equal(redirect.status, 302);
    assert.equal(redirectedRequests, 0);
    await assert.rejects(axios.request({ ...options, url: `${base}/large`, maxContentLength: 64 }), error => {
        assert.equal(error.code, 'ERR_BAD_RESPONSE');
        assert.match(error.message, /maxContentLength/);
        return true;
    });
});

test('real WebSocket transport echoes valid messages and rejects oversized payloads', { timeout: 10000 }, async t => {
    const errors = [];
    const { base, wss } = await listen(t, (_req, res) => res.end(), { maxPayload: 32 });
    wss.on('connection', socket => {
        socket.on('error', error => errors.push(error.code));
        socket.on('message', data => socket.send(data));
    });
    const client = new WebSocket(base.replace('http:', 'ws:'));
    await once(client, 'open', { signal: AbortSignal.timeout(3000) });
    const echo = once(client, 'message', { signal: AbortSignal.timeout(3000) });
    client.send('local-message');
    assert.equal((await echo)[0].toString(), 'local-message');
    const closed = once(client, 'close', { signal: AbortSignal.timeout(3000) });
    client.send('x'.repeat(64));
    assert.equal((await closed)[0], 1009);
    assert.deepEqual(errors, ['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']);
});
