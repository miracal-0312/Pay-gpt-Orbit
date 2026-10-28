'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const factory = require('../cdk-redemption-webhook');

function fixture() {
    const env = { CDK_REDEMPTION_WEBHOOK_URL: 'https://shop.example/api/v1/card-secrets/redemption-callback',
        CDK_REDEMPTION_SOURCE: 'pay-gpt-orbit', CDK_REDEMPTION_WEBHOOK_SECRET: 's'.repeat(32) };
    const events = new Map(), requests = [];
    let clock = Date.parse('2026-10-24T01:00:00Z'), mode = 'success', failAck = false, beforeClaim = null;
    const runQuery = async (sql, p, options) => {
        if (sql.includes('FROM cdk_codes')) {
            assert.ok(options.connection);
            return p[0].toLowerCase() === 'code-test' ? [{ cdk_code: 'CODE-TEST' }] : [];
        }
        assert.match(sql, /attempts < \?/);
        assert.equal(p[4], 3);
        return [...events.values()].filter(e => !e.delivered && e.source === p[0]
            && e.url === p[1] && e.next <= p[2] && e.lease <= p[3] && e.attempts < p[4]).map(e => ({ ...e }));
    };
    const runExecute = async (sql, p, options) => {
        if (sql.startsWith('INSERT')) {
            assert.ok(options.connection);
            if (!events.has(p[0])) events.set(p[0], { event_id: p[0], source: p[1], url: p[2], payload: p[3], attempts: 0, lease: 0, next: 0 });
            return { affectedRows: 1 };
        }
        if (sql.includes('attempts = attempts + 1')) {
            const e = events.get(p[2]);
            if (beforeClaim) { beforeClaim(e); beforeClaim = null; }
            assert.match(sql, /attempts < \?/);
            assert.equal(p[5], 3);
            if (e.delivered || e.next > p[3] || e.lease > p[4] || e.attempts >= p[5]) return { affectedRows: 0 };
            Object.assign(e, { token: p[0], lease: p[1], attempts: e.attempts + 1 });
        } else if (sql.includes('delivered_at = CURRENT_TIMESTAMP')) {
            if (failAck) { failAck = false; throw Error('connection lost after receiver acknowledgement'); }
            const e = events.get(p[0]);
            if (e.token === p[1]) Object.assign(e, { delivered: true, lease: 0 });
        } else {
            const e = events.get(p[2]);
            if (e.token === p[3]) Object.assign(e, { next: p[0], error: p[1], lease: 0 });
        }
        return { affectedRows: 1 };
    };
    const request = async options => {
        requests.push(options);
        const body = JSON.parse(options.data), timestamp = options.headers['X-Redemption-Timestamp'];
        const expected = crypto.createHmac('sha256', env.CDK_REDEMPTION_WEBHOOK_SECRET).update(timestamp + '.').update(options.data).digest('hex');
        assert.equal(options.headers['X-Redemption-Signature'], expected);
        assert.equal(options.maxRedirects, 0);
        if (mode === 'offline') throw Error('private network details');
        if (mode === 'bad-ack') return { status: 200, data: { status_code: 0, data: { event_id: 'wrong', received: true } } };
        if (mode === 'redirect') return { status: 302 };
        if (mode === 'missing') return { status: 404 };
        return { status: 200, data: { status_code: 0, data: { event_id: body.event_id, received: true } } };
    };
    const create = () => factory({ env, runQuery, runExecute, now: () => clock, request });
    return { env, events, requests, create, advance(ms) { clock += ms; }, mode(value) { mode = value; }, failAck() { failAck = true; },
        beforeClaim(fn) { beforeClaim = fn; } };
}

test('redemption notifications validate configuration and stay disabled without a target', async () => {
    assert.equal(factory.readConfig({}), null);
    for (const url of ['http://shop.example', 'https://user:pass@shop.example', 'https://shop.example/#ticket', 'https://shop.example/?key=secret']) {
        assert.throws(() => factory.readConfig({ CDK_REDEMPTION_WEBHOOK_URL: url }));
    }
    const f = fixture(); f.env.CDK_REDEMPTION_WEBHOOK_SECRET = 'short';
    assert.throws(() => factory.readConfig(f.env));
    f.env.CDK_REDEMPTION_WEBHOOK_URL = '';
    await f.create().enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
    await f.create().deliverPending();
    assert.equal(f.events.size, 0); assert.equal(f.requests.length, 0);
});

test('a receipt is durable, minimal and idempotent, and concurrent dispatchers only claim it once', async () => {
    const f = fixture(), sender = f.create();
    await assert.rejects(sender.enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }));
    const input = { cdk: 'CODE-TEST', orderId: 'job-1', session: 'must-not-leak', email: 'private' };
    await sender.enqueue(input, { connection: {} });
    f.advance(1000);
    await sender.enqueue(input, { connection: {} });
    assert.equal(f.events.size, 1);
    await Promise.all([sender.deliverPending(), f.create().deliverPending()]);
    assert.equal(f.requests.length, 1);
    const body = JSON.parse(f.requests[0].data);
    assert.deepEqual(Object.keys(body).sort(), ['version', 'event_id', 'event_type', 'source', 'cdk', 'order_id', 'redeemed_at'].sort());
    assert.equal(body.redeemed_at, '2026-10-24T01:00:00.000Z');
    assert.equal([...f.events.values()][0].delivered, true);
    await sender.deliverPending(); assert.equal(f.requests.length, 1);
});

test('offline, redirected and invalid acknowledgements retry after restart using the same receipt and a fresh signature', async () => {
    for (const mode of ['offline', 'redirect', 'bad-ack']) {
        const f = fixture(), sender = f.create(); f.mode(mode);
        await sender.enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
        await sender.deliverPending();
        const event = [...f.events.values()][0];
        assert.equal(event.delivered, undefined); assert.ok(event.next > 0);
        assert.ok(!event.error.includes('private'));
        await f.create().deliverPending(); assert.equal(f.requests.length, 1);
        f.advance(5000); f.mode('success'); await f.create().deliverPending();
        assert.equal(f.requests.length, 2); assert.equal(event.delivered, true);
        assert.equal(f.requests[0].data, f.requests[1].data);
        assert.notEqual(f.requests[0].headers['X-Redemption-Signature'], f.requests[1].headers['X-Redemption-Signature']);
    }
});

test('receipt identity uses the stored CDK spelling even when customers type a different case', async () => {
    const f = fixture(), sender = f.create();
    await sender.enqueue({ cdk: 'code-test', orderId: 'job-1' }, { connection: {} });
    await sender.enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
    assert.equal(f.events.size, 1);
    assert.equal(JSON.parse([...f.events.values()][0].payload).cdk, 'CODE-TEST');
    await assert.rejects(sender.enqueue({ cdk: 'missing-code', orderId: 'job-2' }, { connection: {} }));
    assert.equal(f.events.size, 1);
});

test('failed deliveries stop after three total attempts, retaining errors across restarts and duplicate enqueue', async () => {
    for (const mode of ['offline', 'missing', 'redirect', 'bad-ack']) {
        const f = fixture(); f.mode(mode);
        const input = { cdk: 'CODE-TEST', orderId: 'job-1' };
        await f.create().enqueue(input, { connection: {} });
        for (let attempt = 1; attempt <= 3; attempt++) {
            await f.create().deliverPending();
            assert.equal(f.requests.length, attempt);
            f.advance(60001);
        }
        const event = [...f.events.values()][0];
        assert.equal(event.attempts, 3);
        assert.equal(event.delivered, undefined);
        assert.ok(event.error);
        const snapshot = structuredClone(event);
        f.advance(86400000); f.mode('success');
        await f.create().enqueue(input, { connection: {} });
        await Promise.all([f.create().deliverPending(), f.create().deliverPending()]);
        assert.equal(f.requests.length, 3);
        assert.deepEqual(event, snapshot);
    }
});

test('a third delivery can succeed and old exhausted records are skipped after upgrade', async () => {
    const f = fixture();
    await f.create().enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
    const event = [...f.events.values()][0];
    event.attempts = 2;
    await Promise.all([f.create().deliverPending(), f.create().deliverPending()]);
    assert.equal(f.requests.length, 1);
    assert.equal(event.attempts, 3);
    assert.equal(event.delivered, true);
    event.delivered = false; event.attempts = 10; event.lease = 0;
    await f.create().deliverPending();
    assert.equal(f.requests.length, 1);
    assert.equal(event.attempts, 10);
});

test('a stale queue read cannot claim an event whose delivery budget was consumed elsewhere', async () => {
    const f = fixture();
    await f.create().enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
    f.beforeClaim(event => { event.attempts = 3; });
    await f.create().deliverPending();
    assert.equal(f.requests.length, 0);
    assert.equal([...f.events.values()][0].attempts, 3);
});

test('lost acknowledgement on the final attempt cannot trigger a fourth send after lease expiry', async () => {
    const f = fixture();
    await f.create().enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
    const event = [...f.events.values()][0]; event.attempts = 2;
    f.failAck(); await assert.rejects(f.create().deliverPending());
    f.advance(60001);
    await f.create().deliverPending();
    assert.equal(event.attempts, 3);
    assert.equal(f.requests.length, 1);
});

test('lost acknowledgements recover after the lease expires; changing the destination cannot leak queued receipts', async () => {
    const f = fixture(), sender = f.create();
    await sender.enqueue({ cdk: 'CODE-TEST', orderId: 'job-1' }, { connection: {} });
    f.failAck(); await assert.rejects(sender.deliverPending());
    await f.create().deliverPending(); assert.equal(f.requests.length, 1);
    f.advance(60001);
    const original = f.env.CDK_REDEMPTION_WEBHOOK_URL;
    f.env.CDK_REDEMPTION_WEBHOOK_URL = 'https://other.example/callback';
    await f.create().deliverPending(); assert.equal(f.requests.length, 1);
    f.env.CDK_REDEMPTION_WEBHOOK_URL = original;
    await f.create().deliverPending(); assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].data, f.requests[1].data);
});

test('self-service settlement records exactly one receipt in its transaction and rolls back if enqueue fails', async () => {
    const receipts = []; let fail = true;
    const f = require('./helpers/card-db.cjs')({ enqueueRedemption: async (receipt, options) => {
        assert.equal(options.connection.fixtureTransaction, true);
        if (fail) throw Error('outbox unavailable');
        receipts.push(receipt);
    } });
    await f.addCard(); const task = await f.claim();
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    await f.settle(task, 'pending'); assert.equal(receipts.length, 0);
    await assert.rejects(f.settle(task, 'success'), /outbox/);
    assert.equal(f.db.tasks[0].orbitcard_state, 'pending');
    assert.equal(f.db.cards[0].successful_plus, 0);
    fail = false;
    await f.settle(task, 'success'); await f.settle(task, 'success'); await f.settle(task, 'failed');
    assert.deepEqual(receipts, [{ cdk: f.db.cdks[0].cdk_code, orderId: task.jobKey }]);
    assert.equal(f.db.tasks[0].orbitcard_state, 'success');
});
