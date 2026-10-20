'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-audit-test-'));
const oldLogDir = process.env.TASK_LOG_DIR;
process.env.TASK_LOG_DIR = temp;
after(() => {
    if (oldLogDir === undefined) delete process.env.TASK_LOG_DIR;
    else process.env.TASK_LOG_DIR = oldLogDir;
    assert.ok(path.basename(temp).startsWith('recharge-audit-test-'));
    fs.rmSync(temp, { recursive: true, force: true });
});
const quiet = { log() {}, error() {}, warn() {} };
function load(name, mocks = {}, extra = {}) {
    const filename = path.resolve(__dirname, '..', name);
    const module = { exports: {} };
    const nativeRequire = createRequire(filename);
    new Function('require', 'module', 'exports', '__dirname', ...Object.keys(extra), fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
        module, module.exports, path.dirname(filename), ...Object.values(extra));
    return module.exports;
}
function extract(file, start, end, deps = {}) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return new Function(...Object.keys(deps), `return (${source.slice(from, to).trim()});`)(...Object.values(deps));
}
const state = require('../local-payment-state');
const safety = require('../log-safety');

test('only a standalone final marker confirms success; submission timeout remains manual', () => {
    assert.equal(state.hasConfirmedSuccess('未检测到支付成功\n支付结果等待超时'), false);
    assert.equal(state.hasConfirmedSuccess('PAYMENT_SUCCESS\npost-processing failed'), true);
    assert.equal(state.classifyResult({ status: 'failed', shouldRetry: true }, 'PAYMENT_SUBMITTING\ntimeout').status, 'manual');
    assert.equal(state.classifyResult({ status: 'manual' }, 'PAYMENT_SUBMITTING\nPAYMENT_CONFIRMED_FAILED').status, 'failed');
    const analyze = extract('server.js', 'function analyzeProcessOutput(', '\nfunction getCheckoutProgress(', {
        extractRuntimeErrorMessage: () => ''
    });
    assert.notEqual(analyze('未检测到支付成功\n支付结果等待超时', true).status, 'success');
});

test('leaving checkout for login is never interpreted as payment success', async () => {
    let clock = 0;
    const postSubmit = extract('stripe-payment.js', 'async function handlePostSubmitPhase(', '\nasync function finalizeCheckoutPayment(', {
        process: { env: { CAPTCHA_OVERLAY_WAIT_MS: '10' } }, Date: { now: () => ++clock },
        console: quiet, detectPaymentDeclineOnPage: async () => null,
        hasAnyCheckoutCaptchaSignal: async () => false
    });
    const result = await postSubmit({ url: () => 'https://chatgpt.com/auth/login', waitForTimeout: async () => {} });
    assert.equal(result.action, 'continue');
});

test('ordinary logs redact credentials/PAN without dropping payment markers on nearby lines', () => {
    const output = safety.redactText('access_token=private-value\n{"accessToken":"secret"}\nPAYMENT_SUCCESS\n4111 1111 1111 1111\nBearer opaque-value');
    assert.ok(!output.includes('private-value'));
    assert.ok(!output.includes('"secret"'));
    assert.ok(!output.includes('opaque-value'));
    assert.ok(!output.includes('4111 1111'));
    assert.ok(state.hasConfirmedSuccess(output));
    assert.equal(safety.sanitize({ nested: { session_json: 'private' } }).nested.session_json, '[REDACTED]');
});

test('full audit lines survive reload and clearing the bounded UI cache', () => {
    const logs = load('runtime-log.js');
    const text = 'x'.repeat(12000);
    logs.push({ jobKey: 'test-durable', text });
    assert.equal(logs.tail(1)[0].text.length, 12000);
    logs.clear();
    assert.equal(logs.stats().count, 0);
    assert.equal(load('runtime-log.js').tail(1)[0].text, text);
    const history = fs.readFileSync(logs.taskFile('test-durable'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(history[0].text, text);
    assert.throws(() => logs.taskFile('../escape'));
});

test('late progress is awaited before completion; split UTF-8 and secrets are handled as lines', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let release, finished = false;
    const gate = new Promise(resolve => { release = resolve; });
    const writes = [];
    const run = extract('server.js', 'function runCheckoutScript(', '\napp.get(', {
        require, spawn: () => child, activeProcesses: new Set(), PROCESS_IDLE_TIMEOUT_MS: 1000,
        setTimeout: () => 1, clearTimeout() {}, console: quiet,
        logTask() {}, logTaskChunk() {}, getCheckoutProgress: () => 90,
        analyzeProcessOutput: () => ({ status: 'success' }), localPayment: state, redactText: safety.redactText
    });
    const pending = run('fixture-job', 'index.js', {}, 1, async (_, output) => {
        await gate; writes.push(output);
    }).then(result => { finished = true; return result; });
    const bytes = Buffer.from('中文\naccess_token=very-secret\nPAYMENT_SUCCESS\n');
    child.stdout.emit('data', bytes.subarray(0, 2));
    child.stdout.emit('data', bytes.subarray(2, 21));
    child.stdout.emit('data', bytes.subarray(21));
    child.emit('close', 0, null);
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    const result = await pending;
    assert.equal(result.analysis.status, 'success');
    assert.match(result.output, /中文/);
    assert.ok(!result.output.includes('very-secret'));
    assert.equal(writes.at(-1), result.output);
});

function localDatabase() {
    const db = { cdk: { cdk_code: 'TEST', is_active: 1, type: '自助', plan_type: 'plus', used_at: null }, tasks: [], failInsert: false };
    const connection = {};
    let tail = Promise.resolve(), seq = 0;
    const store = require('../local-task-store')({
        withTransaction(fn) {
            const work = tail.then(async () => {
                const backup = structuredClone(db);
                try { return await fn(connection); } catch (error) { Object.assign(db, backup); throw error; }
            });
            tail = work.catch(() => {});
            return work;
        },
        async createTaskLog(input, options) {
            assert.equal(options.connection, connection);
            if (db.failInsert) throw new Error('insert failed');
            const task = { id: ++seq, job_key: `local-${seq}`, cdk_code: input.cdkCode, status: input.status };
            db.tasks.push(task);
            return { jobKey: task.job_key };
        },
        async runQuery(sql, args = []) {
            const q = sql.replace(/\s+/g, ' ');
            if (q.includes('FROM cdk_codes')) return [{ ...db.cdk }];
            if (q.includes('orbitcard_state IN')) return db.tasks.filter(t => ['running', 'manual'].includes(t.status));
            if (q.includes('ORDER BY id DESC')) return db.tasks.slice(-1);
            if (q.includes('WHERE job_key = ?')) return db.tasks.filter(t => t.job_key === args[0]).map(t => ({ ...t }));
            if (q.includes("WHERE status = 'running'")) return db.tasks.filter(t => t.status === 'running').map(t => ({ ...t }));
            throw new Error(q);
        },
        async runExecute(sql, args) {
            const q = sql.replace(/\s+/g, ' ');
            if (q.includes("SET local_payment_state = 'prepared'")) db.tasks.find(t => t.job_key === args[0]).local_payment_state = 'prepared';
            else if (q.startsWith('UPDATE task_logs SET status')) Object.assign(db.tasks.find(t => t.job_key === args[7]),
                { status: args[0], local_payment_state: args[1], message: args[2], raw_output: args[4] });
            else if (q.includes('SET used_at = NULL')) db.cdk.used_at = null;
            else if (q.includes('SET used_at')) db.cdk.used_at ||= 'locked';
            else throw new Error(q);
            return { affectedRows: 1 };
        }
    });
    store.updateTaskLog = async (key, update) => Object.assign(db.tasks.find(t => t.job_key === key), update);
    const claim = () => store.createLocalTask({ cdk: 'TEST', planType: 'plus' });
    const settle = (task, status) => store.settleLocalTask(task.jobKey, { status, localState: status });
    return { db, store, claim, settle };
}

test('local reservation and task insert are atomic for concurrent requests and insertion failure', async () => {
    const f = localDatabase();
    const results = await Promise.all([f.claim(), f.claim()]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.db.tasks.length, 1);
    const broken = localDatabase();
    broken.db.failInsert = true;
    await assert.rejects(broken.claim(), /insert failed/);
    assert.equal(broken.db.cdk.used_at, null);
    assert.equal(broken.db.tasks.length, 0);
});

test('local manual keeps CDK; stale tasks cannot release a newer reservation; success cannot regress', async () => {
    const f = localDatabase();
    const first = await f.claim();
    await f.settle(first, 'manual');
    assert.equal(await f.claim(), null);
    await f.settle(first, 'failed');
    const second = await f.claim();
    assert.equal((await f.settle(first, 'failed')).applied, false);
    assert.ok(f.db.cdk.used_at);
    await f.settle(second, 'success');
    assert.equal((await f.settle(second, 'failed')).applied, false);
    assert.equal(f.db.tasks.at(-1).status, 'success');
});

test('restart releases never-started local tasks but retains interrupted workers for reconciliation', async () => {
    for (const started of [false, true]) {
        const f = localDatabase();
        const task = await f.claim();
        if (started) await f.settle(task, 'running');
        await f.store.recoverLocalTasks();
        assert.equal(f.db.tasks[0].status, started ? 'manual' : 'failed');
        assert.equal(Boolean(f.db.cdk.used_at), started);
    }
});

test('worker preserves unknown and confirmed success despite later errors; definite failure releases CDK', async () => {
    for (const [output, expected, throws] of [
        ['PAYMENT_SUBMITTING\ntimeout', 'manual', false],
        ['PAYMENT_SUBMITTING\nPAYMENT_CONFIRMED_FAILED', 'failed', false],
        ['PAYMENT_SUBMITTING\nPAYMENT_SUCCESS', 'success', true]
    ]) {
        const f = localDatabase();
        const task = await f.claim();
        await require('../local-worker').run({
            task, cdk: 'TEST', store: f.store, log() {}, broadcast() {}, notify: async () => { throw new Error('notification failed'); },
            runAttempt: async (_, progress, launch) => {
                launch();
                await progress(95, output);
                if (throws) throw new Error('accounting failure');
                return { output, analysis: { status: 'failed' } };
            }
        });
        assert.equal(f.db.tasks[0].status, expected);
        assert.equal(Boolean(f.db.cdk.used_at), expected !== 'failed');
        assert.match(f.db.tasks[0].raw_output, /PAYMENT_SUBMITTING/);
    }
});

test('deletion refuses all recharge records and pending tasks', async () => {
    for (const task of [{ cdk_code: 'TEST', status: 'success' }, { orbitcard_client_order_no: 'original', status: 'failed' }, { status: 'running' }]) {
        let deleted = false;
        const remove = extract('mysql-store.js', 'async function deleteTaskLogByJobKey(', '\nasync function updateTaskLog(', {
            runQuery: async () => [task], runExecute: async () => { deleted = true; },
            deleteTaskMediaFiles() { throw new Error('must not delete media'); }
        });
        await assert.rejects(remove('job'), error => error.statusCode === 409);
        assert.equal(deleted, false);
    }
});

test('Orbitcard audit records HTTP/network failures without leaking request bodies or nested credentials', async () => {
    const events = [], old = process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_SECRET = 'secret-fixture';
    try {
        let networkFailure = false;
        const api = load('orbitcard-client.js', {
            './runtime-log': { push: entry => events.push(entry) },
            axios: { request: async () => {
                if (networkFailure) throw new Error('request body accessToken=private');
                return { status: 502, headers: { 'retry-after': '12' }, data: { code: 59018,
                    request_error: { code: 'relay_timeout', submission_outcome: 'unknown' },
                    data: { error_code: { accessToken: 'private' }, service_fee: '0.15' } } };
            } }
        });
        const cfg = { api_key: 'key-fixture', auditJobKey: 'audit-job' };
        const result = await api.request(cfg, 'createSubscription', { session_json: { accessToken: 'private' }, client_order_no: 'original' }, 'idem');
        assert.equal(result.retryAfterMs, 12000);
        assert.equal(events[1].data.http_status, 502);
        assert.equal(events[1].data.request_error.submission_outcome, 'unknown');
        assert.equal(api.summary({ error_code: { accessToken: 'private' } }).error_code, undefined);
        networkFailure = true;
        await api.request(cfg, 'getSubscription', { client_order_no: 'original' });
        assert.equal(events.at(-1).event, 'request_failed');
        assert.ok(!JSON.stringify(events).includes('private'));
        assert.ok(!JSON.stringify(events).includes('secret-fixture'));
    } finally {
        if (old === undefined) delete process.env.ORBITCARD_API_SECRET;
        else process.env.ORBITCARD_API_SECRET = old;
    }
});

test('sequential Orbitcard queries honor server cooldown and Retry-After', async () => {
    let calls = 0;
    const query = load('orbitcard-query.js', {
        './orbitcard-client': { request: async () => { calls++; return { success: false, status: 429, retryAfterMs: 20000 }; } },
        './orbitcard-cdk': {}, './runtime-log': { push() {} }
    });
    const args = { cfg: { base_url: 'https://orbitcard.test' },
        task: { job_key: 'cooldown', orbitcard_base_url: 'https://orbitcard.test', orbitcard_client_order_no: 'original' } };
    await Promise.all([query.refresh(args), query.refresh(args)]);
    const cached = await query.refresh(args);
    assert.equal(calls, 1);
    assert.ok(cached.retryAfterMs > 15000);
});

function paymentFixture(result, failAccounting = false) {
    const events = [], bills = [];
    const store = {
        getPaymentRegion: async () => 'US', getAppConfigValue: async () => null,
        reserveCard: async () => ({ id: 1, card_number: '4111111111111111' }), releaseCard: async () => {},
        createBillingRecord: async data => { events.push('bill-created'); bills.push({ ...data }); return bills.length; },
        updateBillingRecord: async (id, data) => {
            events.push('bill-update');
            if (failAccounting) throw new Error('database unavailable');
            Object.assign(bills[id - 1], data);
        },
        bindCardPaymentProfile: async () => {}, recordCardUsage: async () => ({}),
        recordCardDecline: async () => ({})
    };
    const payment = load('payment-retry.js', {
        './mysql-store': store,
        './stripe-payment': { completeStripeCardPayment: async () => { events.push('submit'); return { ...result }; },
            readCheckoutDueAmount: async () => ({ amount: 20, currency: 'USD' }) },
        './tax-free-address': { pickBillingAddressForCheckout: async () => ({ line1: 'test', city: 'test', state: 'test' }), markAddressBound: async () => {} },
        './region-config': { getRegionConfig: () => ({ currency: 'USD' }) }
    }, { console: { ...quiet, log: text => events.push(text) } });
    return { payment, bills, events };
}

test('unverified browser success remains a pending bill and cannot emit final success', async () => {
    const f = paymentFixture({ success: true, submitted: true });
    const result = await f.payment.executePaymentWithRetry({}, { verifySubscription: async () => false });
    assert.equal(result.success, false);
    assert.equal(f.bills[0].status, 'pending');
    assert.ok(f.events.indexOf('bill-created') < f.events.indexOf('submit'));
    assert.ok(!f.events.includes('PAYMENT_SUCCESS'));
});

test('verified success is emitted before accounting failure and leaves a pending bill for reconciliation', async () => {
    const f = paymentFixture({ success: true, submitted: true }, true);
    let checks = 0;
    await assert.rejects(f.payment.executePaymentWithRetry({}, { verifySubscription: async () => ++checks > 1 }), /database unavailable/);
    assert.ok(f.events.indexOf('PAYMENT_SUCCESS') < f.events.indexOf('bill-update'));
    assert.equal(f.bills[0].status, 'pending');
});

test('already active target plan stops before creating or submitting a payment', async () => {
    const f = paymentFixture({ success: true });
    const result = await f.payment.executePaymentWithRetry({}, { verifySubscription: async () => true });
    assert.equal(result.success, false);
    assert.equal(f.bills.length, 0);
    assert.ok(!f.events.includes('submit'));
});

test('WebSocket task access requires the matching CDK or a current admin token', async () => {
    const deps = {
        store: { getTaskStatus: async () => ({ cdk_code: 'CDK-SECRET' }), getAdminAuthConfig: async () => ({ passwordVersion: 2 }) },
        verifyAdminToken: token => token === 'valid' ? { pv: 2 } : token === 'old' ? { pv: 1 } : null
    };
    const { authorize } = require('../task-subscription');
    assert.equal(await authorize({ jobKey: 'job' }, deps), false);
    assert.equal(await authorize({ jobKey: 'job', cdk: 'wrong' }, deps), false);
    assert.equal(await authorize({ jobKey: 'job', cdk: 'CDK-SECRET' }, deps), true);
    assert.equal(await authorize({ jobKey: 'job', adminToken: 'old' }, deps), false);
    assert.equal(await authorize({ jobKey: 'job', adminToken: 'valid' }, deps), true);
});
