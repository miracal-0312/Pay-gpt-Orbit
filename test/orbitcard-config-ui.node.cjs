'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id), module, module.exports);
    return module.exports;
}

test('UI-saved API Secret is encrypted, reused, and never returned as a browser config field', async () => {
    const previous = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 'fixture-admin-signing-key-with-at-least-32-bytes';
    const rows = new Map();
    const connection = {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async execute(_sql, [key, value]) { rows.set(key, value); return [{}]; }
    };
    const mysql = { createPool: () => ({
        async query() { return [[...rows].map(([config_key, config_value]) => ({ config_key, config_value }))]; },
        async execute(_sql, [key, value]) { rows.set(key, value); return [{}]; },
        async getConnection() { return connection; }
    }) };
    try {
        const core = load('mysql-core.js', { 'mysql2/promise': mysql });
        await core.saveGptApiConfig({ enabled: true, base_url: 'https://orbitcard.test',
            api_key: 'key-one', api_secret: 'private-secret-one' });
        const ciphertext = rows.get('orbitcard_api_secret_ciphertext');
        assert.match(ciphertext, /^v1:/);
        assert.ok(!JSON.stringify([...rows]).includes('private-secret-one'));
        assert.equal((await core.getGptApiConfig()).api_secret, 'private-secret-one');
        assert.equal(Object.hasOwn(await core.getGptApiConfig(), 'orbitcard_card_id'), false);
        await core.saveGptApiConfig({ enabled: true, api_key: '', api_secret: '' });
        assert.equal(rows.get('orbitcard_api_secret_ciphertext'), ciphertext);
        await assert.rejects(core.saveGptApiConfig({ api_key: 'key-two' }), /配对的 API Secret/);
        await core.saveGptApiConfig({ api_key: 'key-two', api_secret: 'private-secret-two' });
        assert.equal((await core.getGptApiConfig()).api_secret, 'private-secret-two');

        const html = fs.readFileSync(path.resolve(__dirname, '../public/admin.html'), 'utf8');
        const adminRoute = fs.readFileSync(path.resolve(__dirname, '../admin-http.js'), 'utf8');
        assert.match(html, /id="apiSecret"/);
        assert.match(html, /id="cardIdPreview"/);
        assert.doesNotMatch(html, /id="orbitcardCardId"|id="transactionCardId" type="number"/);
        assert.doesNotMatch(adminRoute, /orbitcard_card_id: cfg\.orbitcard_card_id/);
    } finally {
        if (previous === undefined) delete process.env.ADMIN_TOKEN_SECRET;
        else process.env.ADMIN_TOKEN_SECRET = previous;
    }
});

test('client signs with the UI-managed Secret when an old environment Secret also exists', async () => {
    const previous = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_SECRET = 'old-environment-secret';
    let outgoing;
    const api = load('orbitcard-client.js', {
        axios: { request: async args => { outgoing = args; return { status: 200,
            data: { code: 0, data: { available_balance: '20.00' } }, headers: {} }; } },
        './runtime-log': { push() {} }
    });
    try {
        assert.equal((await api.request({ api_key: 'key', api_secret: 'ui-secret', base_url: 'https://orbitcard.test' }, 'getAccountBalance')).success, true);
        const bodyHash = crypto.createHash('sha256').update(outgoing.data).digest('hex');
        const h = outgoing.headers;
        const canonical = ['ORBITCARD-HMAC-SHA256-V1', 'key', h['X-Timestamp'], h['X-Nonce'],
            'POST', 'orbitcard.test', '/api/open/v1/getAccountBalance', '', bodyHash, ''].join('\n');
        assert.equal(h['X-Signature'], crypto.createHmac('sha256', 'ui-secret').update(canonical).digest('hex'));
        assert.ok(!JSON.stringify(outgoing).includes('ui-secret'));
        outgoing = null;
        const invalid = await api.request({ api_key: 'key', orbitcard_secret_error: true,
            base_url: 'https://orbitcard.test' }, 'getAccountBalance');
        assert.equal(invalid.success, false);
        assert.equal(outgoing, null);
    } finally {
        if (previous === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = previous;
    }
});

test('encrypted Secret rejects tampering and a changed administrator signing key', () => {
    const previous = process.env.ADMIN_TOKEN_SECRET;
    const secret = load('orbitcard-secret.js');
    try {
        process.env.ADMIN_TOKEN_SECRET = 'first-signing-key-with-at-least-32-bytes';
        const encrypted = secret.seal('fixture-secret');
        assert.equal(secret.open(encrypted), 'fixture-secret');
        assert.throws(() => secret.open(`${encrypted}x`), /无法解密/);
        process.env.ADMIN_TOKEN_SECRET = 'second-signing-key-with-at-least-32-bytes';
        assert.throws(() => secret.open(encrypted), /无法解密/);
    } finally {
        if (previous === undefined) delete process.env.ADMIN_TOKEN_SECRET;
        else process.env.ADMIN_TOKEN_SECRET = previous;
    }
});

test('card ID preview reads platform card list and returns only safe summary fields', async () => {
    const handlers = new Map();
    const app = { get: (route, fn) => handlers.set(route, fn), post: (route, _auth, fn) => handlers.set(route, fn || _auth) };
    const cards = [{ card_id: 42, provider_status: 'ACTIVE', last4: '1234', card_number: '4111111111111234', cvv: '999' },
        { card_id: 43, provider_status: 'FROZEN', last4: '5678' }];
    const register = load('orbitcard-card-http.js', {
        './orbitcard-cards-client': { listCards: async () => cards },
        './orbitcard-client': {},
        './orbitcard-card-policy': { LIMITS: { plus: 4 }, CardPreparationError: class extends Error {} }
    });
    register(app, { store: { getGptApiConfig: async () => ({ api_key: 'fixture' }) },
        cardService: {}, requireSecondaryAuth: (_req, _res, next) => next(), audit() {} });
    let output, cacheHeader;
    await handlers.get('/api/admin/orbitcard/cards/preview')({}, {
        set: (_name, value) => { cacheHeader = value; },
        json: value => { output = value; }
    });
    assert.equal(cacheHeader, 'no-store');
    assert.equal(output.total, 2);
    assert.equal(output.active, 1);
    assert.deepEqual(output.cards[0], { card_id: 42, status: 'ACTIVE', last4: '1234' });
    assert.ok(!JSON.stringify(output).includes('4111111111111234'));
    assert.ok(!JSON.stringify(output).includes('999'));
});
