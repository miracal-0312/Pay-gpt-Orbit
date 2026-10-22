'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-api-audit-'));
process.env.TASK_LOG_DIR = dir;
after(() => { assert.ok(path.basename(dir).startsWith('orbit-api-audit-')); fs.rmSync(dir, { recursive: true, force: true }); });
function load(name, mocks = {}) {
    const filename = path.resolve(__dirname, '..', name), module = { exports: {} }, real = createRequire(filename);
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : real(id), module, module.exports, path.dirname(filename));
    return module.exports;
}
const safety = require('../log-safety');
test('audit files survive reload and cache clearing, preserve long lines and redact credentials', () => {
    const logs = load('runtime-log.js');
    logs.push({ jobKey: 'audit-test', text: 'x'.repeat(12000) });
    logs.push({ jobKey: 'audit-test', text: 'access_token=secret-token\nBearer opaque-token\n4111 1111 1111 1111', data: { session_json: 'private' } });
    assert.equal(logs.tail(2)[0].text.length, 12000);
    logs.clear(); assert.equal(logs.stats().count, 0);
    const restored = load('runtime-log.js'); assert.equal(restored.stats().count, 2);
    const raw = fs.readFileSync(restored.taskFile('audit-test'), 'utf8');
    for (const secret of ['secret-token','opaque-token','4111 1111','private']) assert.ok(!raw.includes(secret));
    assert.throws(() => restored.taskFile('../escape'));
    assert.equal(safety.sanitize({ nested: { accessToken: 'private' } }).nested.accessToken, '[REDACTED]');
});
test('HMAC signs the exact request bytes, host, path and stable idempotency identity', async () => {
    const old = process.env.ORBITCARD_API_SECRET, oldKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'signature-test-secret';
    process.env.ORBITCARD_API_KEY = 'test-key';
    const calls = [], events = [];
    try {
        const api = load('orbitcard-client.js', { './runtime-log': { push: event => events.push(event) }, axios: { request: async request => {
            calls.push(request); return { status: 200, data: { code: 0, data: { task_no: 'SUB-1' } } };
        } } });
        await api.request({ api_key: 'test-key', base_url: 'https://orbitcard.test:8443', auditJobKey: 'job' }, 'createSubscription', { session_json: { accessToken: 'private' }, text: '中文' }, 'stable-id');
        const request = calls[0], h = request.headers;
        const canonical = ['ORBITCARD-HMAC-SHA256-V1','test-key',h['X-Timestamp'],h['X-Nonce'],'POST','orbitcard.test:8443','/api/open/v1/createSubscription','',crypto.createHash('sha256').update(request.data).digest('hex'),'stable-id'].join('\n');
        assert.equal(h['X-Signature'], crypto.createHmac('sha256', 'signature-test-secret').update(canonical).digest('hex'));
        assert.equal(h['Idempotency-Key'], 'stable-id'); assert.equal(request.maxRedirects, 0);
        assert.equal(JSON.parse(request.data).text, '中文'); assert.ok(!JSON.stringify(events).includes('private'));
    } finally {
        if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old;
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY = oldKey;
    }
});
test('HTTP and network errors generate safe history; nested fields cannot smuggle credentials', async () => {
    const old = process.env.ORBITCARD_API_SECRET, oldKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'test-secret';
    process.env.ORBITCARD_API_KEY = 'test-key';
    const events = []; let throws = false;
    try {
        const api = load('orbitcard-client.js', { './runtime-log': { push: event => events.push(event) }, axios: { request: async () => {
            if (throws) throw new Error('full request Session: private');
            return { status: 502, headers: { 'retry-after': '12' }, data: { code: 59018, request_error: { code: 'relay_timeout', submission_outcome: 'unknown' }, data: { error_code: { accessToken: 'private' } } } };
        } } });
        const cfg = { api_key: 'test-key', auditJobKey: 'job' };
        const result = await api.request(cfg, 'createSubscription'); assert.equal(result.retryAfterMs, 12000);
        assert.equal(events[1].data.http_status, 502); assert.equal(events[1].data.request_error.submission_outcome, 'unknown');
        assert.equal(api.summary({ error_code: { accessToken: 'private' } }).error_code, undefined);
        assert.deepEqual(api.summary({ payment: { amount: 20, currency: 'USD', card_number: 'private' } }).payment, { amount: 20, currency: 'USD' });
        throws = true; await api.request(cfg, 'getSubscription'); assert.equal(events.at(-1).event, 'request_failed');
        assert.ok(!JSON.stringify(events).includes('private'));
    } finally {
        if (old === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = old;
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY = oldKey;
    }
});
test('sequential original-order requests honor cooldown and Retry-After', async () => {
    let calls = 0;
    const query = load('orbitcard-query.js', { './orbitcard-client': { request: async () => { calls++; return { success: false, status: 429, retryAfterMs: 20000 }; } }, './orbitcard-cdk': {} });
    const input = { cfg: { base_url: 'https://orbitcard.test' }, task: { job_key: 'cooldown', orbitcard_base_url: 'https://orbitcard.test', orbitcard_client_order_no: 'original' } };
    await Promise.all([query.refresh(input), query.refresh(input)]);
    const result = await query.refresh(input); assert.equal(calls, 1); assert.ok(result.retryAfterMs > 15000);
});

test('malformed retry hints cannot discard a valid Retry-After header or nested hint', async t => {
    const oldSecret = process.env.ORBITCARD_API_SECRET, oldKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'test-secret'; process.env.ORBITCARD_API_KEY = 'test-retry-key';
    t.after(() => {
        if (oldSecret === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = oldSecret;
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY = oldKey;
    });
    for (const headers of [{ 'retry-after': '120' }, {}]) {
        let calls = 0;
        const api = load('orbitcard-client.js', { './runtime-log': { push() {} }, axios: { request: async () => {
            calls++;
            return { status: 429, headers, data: { code: 59018,
                request_error: { retry_after_seconds: 'invalid' },
                data: { retry_after_seconds: 'invalid', request_error: { retry_after_seconds: 90 } } } };
        } } });
        const result = await api.request({ base_url: 'https://orbitcard.test' }, 'getSubscription');
        const delay = headers['retry-after'] ? 120000 : 90000;
        assert.equal(result.retryAfterMs, delay);
        const deferred = await api.request({ base_url: 'https://orbitcard.test' }, 'getAccountBalance');
        assert.equal(calls, 1);
        assert.ok(deferred.retryAfterMs > delay - 5000);
    }
});
test('task subscriptions require a matching CDK or a current administrator token', async () => {
    const deps = { store: { getTaskStatus: async () => ({ cdk_code: 'CDK-SECRET' }), getAdminAuthConfig: async () => ({ passwordVersion: 2 }) }, verifyAdminToken: token => token === 'valid' ? { pv: 2 } : token === 'old' ? { pv: 1 } : null };
    const { authorize } = require('../task-subscription');
    assert.equal(await authorize({ jobKey: 'job' }, deps), false);
    assert.equal(await authorize({ jobKey: 'job', cdk: 'wrong' }, deps), false);
    assert.equal(await authorize({ jobKey: 'job', cdk: 'CDK-SECRET' }, deps), true);
    assert.equal(await authorize({ jobKey: 'job', adminToken: 'old' }, deps), false);
    assert.equal(await authorize({ jobKey: 'job', adminToken: 'valid' }, deps), true);
});
