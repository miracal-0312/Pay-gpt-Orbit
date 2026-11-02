'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function load(name, { mocks = {}, env = {}, clock = Date } = {}) {
    const filename = path.resolve(__dirname, '..', name), realRequire = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', 'process', 'Date', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id), module, module.exports, { env }, clock);
    return module.exports;
}

test('database query pool cannot have an unlimited queue through invalid configuration', () => {
    for (const env of [{}, { DB_POOL_LIMIT: '-1', DB_QUEUE_LIMIT: '0' }, { DB_POOL_LIMIT: 'Infinity', DB_QUEUE_LIMIT: 'bad' }, { DB_POOL_LIMIT: '8', DB_QUEUE_LIMIT: '24' }]) {
        let config;
        const core = load('mysql-core.js', { env, mocks: { 'mysql2/promise': { createPool: value => { config = value; return {}; } } } });
        core.getPool(); core.getPool();
        assert.equal(config.connectionLimit, env.DB_POOL_LIMIT === '8' ? 8 : 20);
        assert.equal(config.queueLimit, env.DB_QUEUE_LIMIT === '24' ? 24 : 100);
        assert.equal(config.maxIdle, Math.min(5, config.connectionLimit));
        assert.equal(config.idleTimeout, 60000);
        assert.equal(config.maxPreparedStatements, 256);
    }
});

test('dedicated lock connection limit includes handshakes, frees failed slots and never evicts owners', async () => {
    const pending = [], connections = [];
    const core = load('mysql-core.js', { env: { DB_LOCK_LIMIT: '2' }, mocks: { 'mysql2/promise': {
        createConnection: () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
    } } });
    function connect(index) {
        const c = new EventEmitter(); c.destroyed = 0; c.destroy = () => { c.destroyed++; };
        connections.push(c); pending[index].resolve(c); return c;
    }
    const first = core.openLockConnection(), second = core.openLockConnection();
    await assert.rejects(core.openLockConnection(), error => error.status === 503 && error.code === 'DB_LOCK_BUSY');
    const a = connect(0); await first;
    pending[1].reject(new Error('handshake failed')); await assert.rejects(second, /handshake failed/);
    const third = core.openLockConnection(), b = connect(2); await third;
    assert.equal(a.destroyed, 0); assert.equal(b.destroyed, 0);
    await assert.rejects(core.openLockConnection(), /已满/);
    a.destroy(); a.destroy(); a.emit('end');
    const fourth = core.openLockConnection(); connect(3); await fourth;
    await assert.rejects(core.openLockConnection(), /已满/, 'double release cannot create capacity');
    b.emit('error', new Error('transport lost'));
    assert.equal(b.destroyed, 1);
    const fifth = core.openLockConnection(); connect(4); await fifth;
    await assert.rejects(core.openLockConnection(), /已满/);
});

test('authentication caches expire inactive entries and reject overflow without deleting live lockouts', () => {
    let now = 1000000;
    class Clock extends Date { static now() { return now; } }
    const auth = load('admin-auth.js', { clock: Clock });
    const locked = auth.checkLoginRateLimit('locked');
    for (let i = 0; i < 5; i++) auth.recordLoginFailure(locked.key, locked.entry);
    for (let i = 0; i < 9999; i++) assert.equal(auth.checkLoginRateLimit(`ip-${i}`).allowed, true);
    assert.equal(auth.checkLoginRateLimit('overflow').reason, 'busy');
    now += 16 * 60 * 1000;
    assert.equal(auth.checkLoginRateLimit('overflow').allowed, true);
    assert.equal(auth.checkLoginRateLimit('locked').allowed, false);
    for (let i = 0; i < 10000; i++) auth.storeTelegramLoginCode(`challenge-${i}`, '123456');
    assert.throws(() => auth.storeTelegramLoginCode('overflow', '123456'), /请求过多/);
    now += 6 * 60 * 1000;
    auth.storeTelegramLoginCode('overflow', '123456');
    assert.equal(auth.verifyTelegramLoginCode('challenge-1', '123456').reason, 'expired');
    assert.equal(auth.verifyTelegramLoginCode('overflow', '123456').ok, true);
});

test('concurrent login checks share the failure counter and forwarded headers cannot spoof client identity', () => {
    const auth = load('admin-auth.js');
    const attempts = Array.from({ length: 5 }, () => auth.checkLoginRateLimit('shared'));
    for (const rate of attempts) auth.recordLoginFailure(rate.key, rate.entry);
    assert.equal(auth.checkLoginRateLimit('shared').allowed, false);
    assert.equal(auth.getClientMeta({ headers: { 'x-forwarded-for': 'untrusted', 'x-real-ip': 'untrusted' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }).ip, '127.0.0.1');
    assert.equal(auth.getClientMeta({ ip: 'trusted-client', headers: {}, socket: { remoteAddress: 'proxy' } }).ip, 'trusted-client');
});
