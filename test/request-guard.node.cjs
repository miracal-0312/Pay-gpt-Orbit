'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestGuard } = require('../request-guard');
function response() {
    const res = new EventEmitter();
    Object.assign(res, { headers: {}, set(key, value) { this.headers[key] = value; return this; },
        status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });
    return res;
}
test('HTTP admission limits per IP and global rates, refills gradually, and keeps static files accessible', () => {
    let now = 0;
    const guard = createRequestGuard({ now: () => now, env: { API_REQUESTS_PER_MINUTE: '2', API_TOTAL_REQUESTS_PER_MINUTE: '3' } });
    const call = (ip, path = '/api/health') => {
        const res = response(); guard({ ip, path, method: 'GET' }, res, () => { res.accepted = true; res.emit('finish'); }); return res;
    };
    assert.ok(call('one').accepted); assert.ok(call('one').accepted);
    const denied = call('one'); assert.equal(denied.code, 429); assert.equal(denied.headers['Retry-After'], '30');
    assert.ok(call('two').accepted); assert.equal(call('three').code, 429);
    assert.ok(call('one', '/style.css').accepted);
    now = 30000; assert.ok(call('one').accepted);
});
test('HTTP concurrency is bounded and finish/close only release a slot once', () => {
    const guard = createRequestGuard({ env: { API_MAX_CONCURRENT: '2', API_MAX_CONCURRENT_PER_IP: '1' } });
    const call = ip => { const res = response(); guard({ ip, path: '/api/cdk/status', method: 'POST' }, res, () => { res.accepted = true; }); return res; };
    const first = call('one'); assert.ok(first.accepted); assert.equal(call('one').code, 503);
    const second = call('two'); assert.ok(second.accepted); assert.equal(call('three').code, 503);
    first.emit('finish'); first.emit('close');
    assert.ok(call('one').accepted); assert.equal(call('three').code, 503);
    second.emit('close'); assert.ok(call('three').accepted);
});
test('write budget is separate from status polling; tracked clients expire and have a hard cap', () => {
    let now = 0;
    const guard = createRequestGuard({ now: () => now, env: { API_WRITES_PER_MINUTE: '1', API_MAX_TRACKED_IPS: '1' } });
    const call = (ip, path) => { const res = response(); guard({ ip, path, method: 'POST' }, res, () => { res.accepted = true; res.emit('finish'); }); return res; };
    assert.ok(call('one', '/api/run-process').accepted);
    assert.equal(call('one', '/api/run-process').code, 429);
    assert.ok(call('one', '/API/CDK/STATUS/').accepted);
    assert.equal(call('two', '/api/cdk/status').code, 503);
    now = 60001; assert.ok(call('two', '/api/cdk/status').accepted);
});
test('case-insensitive Express API routes cannot bypass admission limits', () => {
    const guard = createRequestGuard({ env: { API_REQUESTS_PER_MINUTE: '1' } });
    const req = { ip: 'one', path: '/API/health/', method: 'GET' };
    const first = response(); guard(req, first, () => first.emit('finish'));
    const second = response(); guard(req, second, () => assert.fail('rate limit bypassed'));
    assert.equal(second.code, 429);
});
test('concurrent HTTP flood is rejected before business work and forged proxy headers cannot bypass the IP budget', async t => {
    const app = require('express')();
    app.use(createRequestGuard({ env: { API_MAX_CONCURRENT: '3', API_MAX_CONCURRENT_PER_IP: '3', API_REQUESTS_PER_MINUTE: '10' } }));
    let active = 0, peak = 0, calls = 0;
    app.get('/api/work', async (req, res) => {
        active++; calls++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 100)); active--;
        res.json({ success: true });
    });
    const server = app.listen(0, '127.0.0.1');
    await require('node:events').once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}/API/work`;
    const replies = await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(url, { headers: { 'X-Forwarded-For': `10.0.0.${i}` } })));
    assert.ok(peak <= 3); assert.ok(calls <= 10);
    assert.ok(replies.some(reply => reply.status === 200));
    assert.ok(replies.some(reply => reply.status === 503));
    assert.ok(replies.some(reply => reply.status === 429));
    await Promise.all(replies.map(reply => reply.arrayBuffer()));
});
