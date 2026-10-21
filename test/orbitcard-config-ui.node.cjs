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

test('Orbitcard credentials come only from environment, never admin input or old database rows', async () => {
    const oldKey = process.env.ORBITCARD_API_KEY, oldSecret = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_KEY = 'environment-key';
    process.env.ORBITCARD_API_SECRET = 'environment-secret';
    const rows = new Map([['gpt_api_enabled', '1'], ['gpt_api_key', 'obsolete-database-key'],
        ['orbitcard_api_secret_ciphertext', 'obsolete-ciphertext']]);
    const connection = {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query() { return [[...rows].map(([config_key, config_value]) => ({ config_key, config_value }))]; },
        async execute(sql, params) {
            if (sql.startsWith('DELETE')) params.forEach(key => rows.delete(key));
            else rows.set(params[0], params[1]);
            return [{}];
        }
    };
    const mysql = { createPool: () => ({
        async query() { return [[...rows].map(([config_key, config_value]) => ({ config_key, config_value }))]; },
        async execute(sql, params) { return connection.execute(sql, params); },
        async getConnection() { return connection; }
    }) };
    try {
        const core = load('mysql-core.js', { 'mysql2/promise': mysql });
        const config = await core.getGptApiConfig();
        assert.equal(config.api_key, 'environment-key');
        assert.equal(Object.hasOwn(config, 'api_secret'), false);
        assert.equal(Object.hasOwn(config, 'orbitcard_card_id'), false);
        await assert.rejects(core.saveGptApiConfig({ api_key: 'browser-key' }), /环境变量/);
        await assert.rejects(core.saveGptApiConfig({ api_secret: 'browser-secret' }), /环境变量/);
        await assert.rejects(core.saveGptApiConfig({ orbitcard_price_plus: '1' }), /平台推荐价/);
        await assert.rejects(core.saveGptApiConfig({ orbitcard_region_plus: 'US' }), /地区/);
        await core.saveGptApiConfig({ enabled: true, base_url: 'https://orbitcard.test' });
        assert.equal(rows.get('gpt_api_base_url'), 'https://orbitcard.test');
        await core.ensureGptApiConfigDefaults();
        assert.equal(rows.has('gpt_api_key'), false);
        assert.equal(rows.has('orbitcard_api_secret_ciphertext'), false);

        assert.deepEqual((await core.getGptApiConfig()).orbitcard_payment_regions, { plus: '', pro100: '', pro200: '', pro500: '' });
        await core.saveGptApiConfig({ orbitcard_payment_regions: { plus: ' ph ', pro100: 'US', pro200: 'JP', pro500: 'CL' } });
        assert.deepEqual((await core.getGptApiConfig()).orbitcard_payment_regions, { plus: 'PH', pro100: 'US', pro200: 'JP', pro500: 'CL' });
        await core.saveGptApiConfig({ orbitcard_max_fee: '2' });
        assert.equal((await core.getGptApiConfig()).orbitcard_payment_regions.plus, 'PH');
        await core.saveGptApiConfig({ orbitcard_payment_regions: { plus: '' } });
        assert.deepEqual((await core.getGptApiConfig()).orbitcard_payment_regions, { plus: '', pro100: 'US', pro200: 'JP', pro500: 'CL' });
        await core.ensureGptApiConfigDefaults();
        assert.equal((await core.getGptApiConfig()).orbitcard_payment_regions.pro500, 'CL');
        for (const bad of [null, [], 'US', { go: 'US' }, { plus: 'USA' }, { plus: 1 }, { plus: {} }]) {
            await assert.rejects(core.saveGptApiConfig({ orbitcard_payment_regions: bad }), /地区/);
            assert.equal((await core.getGptApiConfig()).orbitcard_payment_regions.pro100, 'US');
        }

        delete process.env.ORBITCARD_API_KEY;
        await assert.rejects(core.saveGptApiConfig({ enabled: true }), /ORBITCARD_API_KEY/);
        const html = fs.readFileSync(path.resolve(__dirname, '../public/admin.html'), 'utf8');
        const script = fs.readFileSync(path.resolve(__dirname, '../public/admin.js'), 'utf8');
        assert.match(html, /ORBITCARD_API_KEY/);
        assert.match(html, /ORBITCARD_API_SECRET/);
        assert.doesNotMatch(html, /id="apiKey"|id="apiSecret"/);
        assert.doesNotMatch(html, /id="price_plus"|id="region_plus"/);
        assert.match(html, /id="testResult"/);
        assert.match(html, /id="regionResult"/);
        for (const plan of ['plus', 'pro100', 'pro200', 'pro500']) assert.match(html, new RegExp(`id="paymentRegion_${plan}"`));
        assert.doesNotMatch(script, /api_key:\s*\$|api_secret:\s*\$/);
    } finally {
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY;
        else process.env.ORBITCARD_API_KEY = oldKey;
        if (oldSecret === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = oldSecret;
    }
});

test('client signs with environment Secret even if config contains an obsolete Secret', async () => {
    const previous = process.env.ORBITCARD_API_SECRET, previousKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'environment-secret';
    process.env.ORBITCARD_API_KEY = 'environment-key';
    let outgoing;
    const api = load('orbitcard-client.js', {
        axios: { request: async args => { outgoing = args; return { status: 200,
            data: { code: 0, data: { available_balance: '20.00' } }, headers: {} }; } },
        './runtime-log': { push() {} }
    });
    try {
        assert.equal((await api.request({ api_key: 'forged-config-key', api_secret: 'obsolete-secret',
            base_url: 'https://orbitcard.test' }, 'getAccountBalance')).success, true);
        const h = outgoing.headers;
        const canonical = ['ORBITCARD-HMAC-SHA256-V1', 'environment-key', h['X-Timestamp'], h['X-Nonce'],
            'POST', 'orbitcard.test', '/api/open/v1/getAccountBalance', '',
            crypto.createHash('sha256').update(outgoing.data).digest('hex'), ''].join('\n');
        assert.equal(h['X-Signature'], crypto.createHmac('sha256', 'environment-secret').update(canonical).digest('hex'));
        assert.equal(h['X-API-Key'], 'environment-key');
        assert.ok(!JSON.stringify(outgoing).includes('environment-secret'));
    } finally {
        if (previous === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = previous;
        if (previousKey === undefined) delete process.env.ORBITCARD_API_KEY;
        else process.env.ORBITCARD_API_KEY = previousKey;
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

test('connection diagnostics report both upstream calls without exposing credentials', async () => {
    const previousKey = process.env.ORBITCARD_API_KEY;
    const previousSecret = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_KEY = 'diagnostic-key';
    process.env.ORBITCARD_API_SECRET = 'diagnostic-secret';
    const calls = [];
    const api = load('orbitcard-client.js', {
        axios: { request: async args => {
            calls.push(new URL(args.url).pathname);
            const data = args.url.endsWith('/getSubscriptionPlans')
                ? { enabled: true, plans: [{ type: 'gpt-plus', name: 'Plus' }] }
                : { available_balance: '25.00' };
            return { status: 200, data: { code: 0, data }, headers: {} };
        } },
        './runtime-log': { push() {} }
    });
    try {
        const result = await api.testConnection({ base_url: 'https://orbitcard.test' });
        assert.equal(result.success, true);
        assert.equal(result.balance.available_balance, '25.00');
        assert.deepEqual(calls.sort(), ['/api/open/v1/getAccountBalance', '/api/open/v1/getSubscriptionPlans']);
        assert.deepEqual(result.checks.map(check => check.path).sort(), calls.sort());
        assert.ok(result.checks.every(check => check.success && check.http_status === 200
            && check.platform_code === 0 && Number.isFinite(check.elapsed_ms)));
        assert.ok(!JSON.stringify(result.checks).includes('diagnostic-key'));
        assert.ok(!JSON.stringify(result.checks).includes('diagnostic-secret'));
    } finally {
        if (previousKey === undefined) delete process.env.ORBITCARD_API_KEY;
        else process.env.ORBITCARD_API_KEY = previousKey;
        if (previousSecret === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = previousSecret;
    }
});
