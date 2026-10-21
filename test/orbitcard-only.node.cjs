'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const config = require('../orbitcard-config');

function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : id === './runtime-log' ? { push() {} } : realRequire(id), module, module.exports);
    return module.exports;
}

test('third-party client always uses the signed Orbitcard routes, ignoring obsolete provider values', async () => {
    const calls = [];
    const api = load('orbitcard-client.js', { axios: { request: async args => {
        calls.push(args);
        return { status: 200, data: { code: 0, data: args.url.endsWith('getSubscriptionPlans')
            ? { enabled: true, plans: [{ type: 'gpt-plus', name: 'Plus', service_fee: '0.15' }] } : { balance: '10.00' } } };
    } } });
    const client = load('gpt-api-client.js', { './orbitcard-client': api });
    const original = process.env.ORBITCARD_API_SECRET, originalKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'test-secret';
    process.env.ORBITCARD_API_KEY = 'test-key';
    try {
        const result = await client.testConnection({ provider: 'legacy', api_key: 'test-key' });
        assert.equal(result.success, true);
        assert.equal(result.plans[0].type, 'gpt-plus');
        assert.equal(result.plans[0].service_fee, undefined);
        assert.deepEqual(calls.map(c => c.url), [
            'https://orbitcard.cc/api/open/v1/getSubscriptionPlans', 'https://orbitcard.cc/api/open/v1/getAccountBalance'
        ]);
        for (const req of calls) {
            assert.equal(req.method, 'POST');
            assert.match(req.headers['X-Signature'], /^[a-f0-9]{64}$/);
            assert.equal(req.headers.Authorization, undefined);
        }
        for (const name of ['inspectPay','submitPay','queryTask','extractTopupCode','extractStatus']) assert.equal(client[name], undefined);
    } finally {
        if (original === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = original;
        if (originalKey === undefined) delete process.env.ORBITCARD_API_KEY;
        else process.env.ORBITCARD_API_KEY = originalKey;
    }
});

async function migrate(saved) {
    const source = fs.readFileSync(path.resolve(__dirname, '../mysql-core.js'), 'utf8');
    const code = source.slice(source.indexOf('async function ensureGptApiConfigDefaults()'), source.indexOf('async function getGptApiConfig()'));
    const connection = {};
    const keys = ['gpt_api_enabled','gpt_api_base_url','gpt_api_key','gpt_api_protocol_version','orbitcard_card_id','orbitcard_region','orbitcard_max_fee'];
    const fn = new Function('withTransaction','runQuery','runExecute','orbitcardConfig','GPT_API_CONFIG_KEYS', `return (${code});`)(
        callback => callback(connection),
        async (_, __, options) => {
            assert.equal(options.connection, connection);
            return Object.entries(saved).map(([config_key, config_value]) => ({ config_key, config_value }));
        },
        async (sql, args, options) => {
            assert.equal(options.connection, connection);
            if (sql.startsWith('DELETE')) for (const key of args) delete saved[key];
            else if (!sql.startsWith('INSERT IGNORE') || saved[args[0]] == null) saved[args[0]] = args[1];
        }, config, keys
    );
    await fn();
    return saved;
}

test('migration disables the retired service and never uses its stored credential', async () => {
    const values = await migrate({ gpt_api_enabled: '1', gpt_api_key: 'old-test-key',
        gpt_api_base_url: 'https://retired.example.test', gpt_api_plan_key: 'plus', gpt_api_country: 'PH', gpt_api_currency: 'PHP' });
    assert.equal(values.gpt_api_enabled, '0');
    assert.equal(values.gpt_api_key, 'old-test-key');
    assert.equal(values.gpt_api_base_url, 'https://orbitcard.cc');
    assert.equal(values.gpt_api_protocol_version, config.PROTOCOL_VERSION);
    for (const key of config.RETIRED_CONFIG_KEYS) assert.equal(values[key], undefined);
});

test('migration preserves existing Orbitcard configuration and is idempotent after restart', async () => {
    const values = await migrate({ gpt_api_provider: 'orbitcard', gpt_api_enabled: '1', gpt_api_key: 'test-key',
        gpt_api_base_url: 'https://custom.orbitcard.test', orbitcard_card_id: '123' });
    assert.equal(values.gpt_api_key, 'test-key');
    assert.equal(values.gpt_api_enabled, '1');
    assert.equal(values.gpt_api_base_url, 'https://custom.orbitcard.test');
    const expected = { ...values };
    await migrate(values);
    assert.deepEqual(values, expected);
});

test('new installs default to Orbitcard and remain disabled until configured', async () => {
    const values = await migrate({});
    assert.equal(values.gpt_api_enabled, '0');
    assert.equal(values.gpt_api_base_url, config.DEFAULT_BASE_URL);
    assert.equal(values.gpt_api_protocol_version, config.PROTOCOL_VERSION);
});

test('enabling requires environment Key, HTTPS root URL and server Secret; card selection is automatic', () => {
    const previous = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_KEY = 'test-key';
    try {
        const valid = { enabled: true, orbitcard_card_id: '42', base_url: 'https://orbitcard.test/' };
        assert.throws(() => config.prepareConfig(valid, {}, false));
        assert.equal(config.prepareConfig({ ...valid, orbitcard_card_id: '' }, {}, true).enabled, true);
        assert.throws(() => config.prepareConfig({ ...valid, base_url: 'https://orbitcard.test/api/v1' }, {}, true));
        assert.throws(() => config.prepareConfig({ ...valid, base_url: 'http://orbitcard.test' }, {}, true));
        assert.throws(() => config.prepareConfig({ ...valid, provider: 'legacy' }, {}, true));
        assert.equal(config.prepareConfig(valid, {}, true).base_url, 'https://orbitcard.test');
        delete process.env.ORBITCARD_API_KEY;
        assert.throws(() => config.prepareConfig(valid, {}, true), /ORBITCARD_API_KEY/);
    } finally {
        if (previous === undefined) delete process.env.ORBITCARD_API_KEY;
        else process.env.ORBITCARD_API_KEY = previous;
    }
});

test('browser API Key and retired price or region fields are ignored', () => {
    const previous = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_KEY = 'environment-key';
    try {
        const result = config.prepareConfig({ enabled: true, api_key: 'forged-browser-key', orbitcard_region_plus: 'PH',
            orbitcard_price_plus: '1', orbitcard_max_fee: '' },
            { api_key: 'saved-test-key', orbitcard_card_id: '42', orbitcard_region: 'US', orbitcard_max_fee: '0.15' }, true);
        assert.equal(result.api_key, 'environment-key');
        assert.equal(Object.hasOwn(result, 'orbitcard_region_plus'), false);
        assert.equal(Object.hasOwn(result, 'orbitcard_price_plus'), false);
        assert.equal(result.orbitcard_max_fee, '');
        assert.equal(result.base_url, config.DEFAULT_BASE_URL);
    } finally {
        if (previous === undefined) delete process.env.ORBITCARD_API_KEY;
        else process.env.ORBITCARD_API_KEY = previous;
    }
});

test('enabling third-party mode dispatches Orbitcard for a CDK without any provider selector', async () => {
    const session = { accessToken: 'synthetic-token', user: { email: 'target@example.test' }, account: {} };
    let claims = 0, submissions = 0;
    const deps = {
        ensureStoreReady: async () => {}, activeJobs: new Set(), log() {},
        runWorker: async input => { submissions++; assert.equal(input.task.orbitcardClientOrderNo, 'cdk-current-attempt'); },
        store: {
            getMaintenanceModeState: async () => ({}), getMaxConcurrentActivations: async () => 5,
            verifyCdkDetails: async () => ({ type: '自助', plan_type: 'plus' }), getRunningTaskByCdk: async () => null,
            getGptApiConfig: async () => ({ enabled: true, api_key: 'test-key', base_url: 'https://orbitcard.test', orbitcard_card_id: '42' }),
            createOrbitcardTask: async input => { claims++; assert.equal(input.cdk, 'CDK-TEST'); return { jobKey: 'job1', orbitcardClientOrderNo: 'cdk-current-attempt' }; }
        }
    };
    const handler = require('../activation-service')(deps);
    let payload;
    const res = { status() { return this; }, json(data) { payload = data; return data; } };
    const old = process.env.ORBITCARD_API_SECRET, oldKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'test-secret';
    process.env.ORBITCARD_API_KEY = 'test-key';
    try { await handler({ body: { cdk: 'CDK-TEST', session: JSON.stringify(session) } }, res); }
    finally {
        if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old;
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY = oldKey;
    }
    assert.equal(payload.success, true);
    assert.equal(payload.provider, 'orbitcard');
    assert.equal(claims, 1);
    assert.equal(submissions, 1);
});
