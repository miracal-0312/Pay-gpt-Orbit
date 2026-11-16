'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const register = require('../src/http/order-manual-control-http');

async function fixture(t, overrides = {}) {
    const calls = [], app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (req.headers.authorization !== 'Bearer administrator') return res.status(401).json({ success: false });
        req.admin = { email: 'operator@example.test' }; next();
    });
    register(app, { store: {
        getOrderManualControl: async input => { calls.push(['get', input]); return { ...input, revision: 'live-revision', actions: [] }; },
        applyOrderManualControl: async input => { calls.push(['apply', input]); return { kind: input.kind, id: input.id, revision: 'next-revision' }; },
        ...overrides
    }, requireSecondaryAuth(req, res, next) {
        if (req.headers['x-admin-secondary-token'] !== 'verified') return res.status(403).json({ success: false, secondaryRequired: true });
        next();
    } });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const request = async (path, body, headers = { Authorization: 'Bearer administrator', 'x-admin-secondary-token': 'verified' }) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { status: response.status, headers: response.headers, body: await response.json() };
    };
    return { request, calls };
}
const routes = [
    ['task', '/api/admin/orders/job%2F1/manual', 'job/1'],
    ['admin', '/api/admin/manual/orders/admin%2F1/manual', 'admin/1']
];

test('all manual reads and mutations require administrator login and secondary authentication', async t => {
    const f = await fixture(t);
    for (const [, path] of routes) for (const body of [undefined, { action: 'note' }]) {
        assert.equal((await f.request(path, body, {})).status, 401);
        const denied = await f.request(path, body, { Authorization: 'Bearer administrator' });
        assert.equal(denied.status, 403); assert.equal(denied.body.secondaryRequired, true);
    }
    assert.deepEqual(f.calls, []);
});

test('manual order reads retain the route identity and prohibit caching', async t => {
    const f = await fixture(t);
    for (const [kind, path, id] of routes) {
        const response = await f.request(path);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.body.data.revision, 'live-revision');
        assert.deepEqual(f.calls.at(-1), ['get', { kind, id }]);
    }
});

test('mutations forward explicit preconditions and derive actor and order identity from authenticated context', async t => {
    const f = await fixture(t);
    for (const [kind, path, id] of routes) for (const action of ['note', 'pause', 'success', 'failed']) {
        const response = await f.request(path, { action, expected_revision: 'reviewed-revision', reason: '核对原单后处理',
            adminEmail: 'forged@example.test', admin_email: 'forged@example.test', kind: 'forged', id: 'another-order',
            snapshot: { status: 'success' }, cdk: 'forged-cdk', release_funds: true });
        assert.equal(response.status, 200); assert.equal(response.body.success, true);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(f.calls.at(-1), ['apply', { kind, id, action, expectedRevision: 'reviewed-revision',
            releaseLocalHold: undefined, reason: '核对原单后处理', adminEmail: 'operator@example.test' }]);
    }
});

test('local release forwards only the explicit option and cannot forge its actor or timestamps', async t => {
    const f = await fixture(t);
    for (const [kind, path, id] of routes) for (const releaseLocalHold of [false, true]) {
        const response = await f.request(path, { action: 'success', expected_revision: 'reviewed-revision',
            reason: '其他卡已完成人工交付', release_local_hold: releaseLocalHold,
            manual_local_released_by: 'forged@example.test', manual_local_released_at: 'forged' });
        assert.equal(response.status, 200);
        assert.deepEqual(f.calls.at(-1), ['apply', { kind, id, action: 'success', expectedRevision: 'reviewed-revision',
            releaseLocalHold, reason: '其他卡已完成人工交付', adminEmail: 'operator@example.test' }]);
    }
});

test('invalid request containers are rejected without modifying an order', async t => {
    const f = await fixture(t);
    for (const [, path] of routes) assert.equal((await f.request(path, [])).status, 400);
    assert.deepEqual(f.calls, []);
});

test('financial and revision conflicts remain actionable and unexpected exceptions stay private', async t => {
    for (const status of [400, 404, 409]) {
        const error = Object.assign(new Error('原资金尚未核对，请刷新订单'), { status });
        const f = await fixture(t, { getOrderManualControl: async () => { throw error; }, applyOrderManualControl: async () => { throw error; } });
        for (const [, path] of routes) for (const body of [undefined, { action: 'success' }]) {
            const result = await f.request(path, body);
            assert.equal(result.status, status); assert.equal(result.body.message, error.message);
            assert.equal(result.headers.get('cache-control'), 'no-store');
        }
    }
    const f = await fixture(t, { getOrderManualControl: async () => { throw Error('SQL_PASSWORD=private'); },
        applyOrderManualControl: async () => { throw Error('private upstream credentials'); } });
    for (const [, path] of routes) for (const body of [undefined, { action: 'failed' }]) {
        const result = await f.request(path, body);
        assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /private|credentials|SQL_PASSWORD/);
    }
});
