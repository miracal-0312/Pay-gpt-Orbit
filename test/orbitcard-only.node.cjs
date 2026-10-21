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
    const original = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_SECRET = 'test-secret';
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

test('migration disables the retired service and clears its credential before adopting Orbitcard', async () => {
    const values = await migrate({ gpt_api_enabled: '1', gpt_api_key: 'old-test-key',
        gpt_api_base_url: 'https://retired.example.test', gpt_api_plan_key: 'plus', gpt_api_country: 'PH', gpt_api_currency: 'PHP' });
    assert.equal(values.gpt_api_enabled, '0');
    assert.equal(values.gpt_api_key, '');
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

test('enabling requires Key, HTTPS root URL and server secret; card selection is automatic', () => {
    const valid = { enabled: true, api_key: 'test-key', orbitcard_card_id: '42', base_url: 'https://orbitcard.test/' };
    assert.throws(() => config.prepareConfig(valid, {}, false));
    assert.throws(() => config.prepareConfig({ ...valid, api_key: '' }, {}, true));
    assert.equal(config.prepareConfig({ ...valid, orbitcard_card_id: '' }, {}, true).enabled, true);
    assert.throws(() => config.prepareConfig({ ...valid, base_url: 'https://orbitcard.test/api/v1' }, {}, true));
    assert.throws(() => config.prepareConfig({ ...valid, base_url: 'http://orbitcard.test' }, {}, true));
    assert.throws(() => config.prepareConfig({ ...valid, provider: 'legacy' }, {}, true));
    assert.equal(config.prepareConfig(valid, {}, true).base_url, 'https://orbitcard.test');
});

test('saving an unchanged key and clearing optional fields works without protocol selection', () => {
    const result = config.prepareConfig({ enabled: true, api_key: '', orbitcard_region: '', orbitcard_max_fee: '' },
        { api_key: 'saved-test-key', orbitcard_card_id: '42', orbitcard_region: 'US', orbitcard_max_fee: '0.15' }, true);
    assert.equal(result.api_key, 'saved-test-key');
    assert.equal(result.orbitcard_region, '');
    assert.equal(result.orbitcard_max_fee, '');
    assert.equal(result.base_url, config.DEFAULT_BASE_URL);
});

test('per-plan default regions are normalized and validated independently', () => {
    const saved={api_key:'saved-test-key',orbitcard_region_plus:'US',orbitcard_region_pro200:'JP'};
    const result=config.prepareConfig({orbitcard_region_plus:'ph',orbitcard_region_pro100:'',orbitcard_region_pro500:'cl'},saved,true);
    assert.equal(result.orbitcard_region_plus,'PH');
    assert.equal(result.orbitcard_region_pro100,'');
    assert.equal(result.orbitcard_region_pro200,'JP');
    assert.equal(result.orbitcard_region_pro500,'CL');
    assert.throws(()=>config.prepareConfig({orbitcard_region_pro100:'USA'},saved,true),/默认支付地区/);
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
    const old = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_SECRET = 'test-secret';
    try { await handler({ body: { cdk: 'CDK-TEST', session: JSON.stringify(session) } }, res); }
    finally { if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old; }
    assert.equal(payload.success, true);
    assert.equal(payload.provider, 'orbitcard');
    assert.equal(claims, 1);
    assert.equal(submissions, 1);
});
