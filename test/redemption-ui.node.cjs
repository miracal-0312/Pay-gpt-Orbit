'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    const nodes = new Map(), timers = new Map(), delays = new Map(), calls = [];
    let nextTimer = 0, response = null, runtimeResponse = { success: false };
    let now = Date.now();
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, open: false, style: {}, children: [],
            handlers: {}, attributes: {}, textContent: '', parentElement: { setAttribute() {} },
            setAttribute(key, value) { this.attributes[key] = value; }, focus() { context.document.activeElement = this; },
            showModal() { this.open = true; }, close() { this.open = false; },
            addEventListener(event, handler) { this.handlers[event] = handler; },
            replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
        return nodes.get(id);
    };
    const context = vm.createContext({ URL, Date: ClockDate, AbortController,
        document: { getElementById: node, querySelectorAll: () => [], createElement: () => ({}) },
        setTimeout: (fn, delay) => { timers.set(++nextTimer, fn); delays.set(nextTimer, delay); return nextTimer; },
        clearTimeout: id => { timers.delete(id); delays.delete(id); }, setInterval() {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url === '/api/public/runtime') return { ok: true, json: async () => runtimeResponse };
            if (typeof response === 'function') return response(url, options);
            if (response instanceof Error) throw response;
            return { ok: true, json: async () => response };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    vm.runInContext("activeCdk = 'CODE-TEST'; activeJob = 'job-1'; activePlanLabel = 'Plus';", context);
    return { node, timers, calls, context, respond(value) { response = value; }, runtime(value) { runtimeResponse = value; return context.runtime(); }, advance(ms) { now += ms; },
        fireTimeout(delay) {
            const id = [...delays].find(([id, ms]) => ms === delay && timers.has(id))?.[0];
            assert.ok(id, `Expected a ${delay} ms timer`);
            const fn = timers.get(id); timers.delete(id); delays.delete(id); return fn();
        },
        refresh: () => vm.runInContext('refresh(false)', context) };
}
const session = (accessToken = 'test', email = 'target@example.test') => JSON.stringify({ user: { email }, account: { id: 'account-test' }, accessToken });
function submitConfirmed(f) {
    f.node('redeemForm').handlers.submit({ preventDefault() {} });
    assert.equal(f.node('accountConfirmModal').open, true, 'submission must ask for the target account');
    return f.node('accountConfirmAccept').handlers.click();
}
const flush = () => new Promise(setImmediate);
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('pasting a complete Session asks for the account without submitting a payment', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-TEST';
    f.node('sessionInput').value = session();
    f.node('sessionInput').handlers.input({});
    assert.equal(f.node('accountConfirmModal').open, true);
    assert.equal(f.node('accountConfirmEmail').textContent, 'target@example.test');
    assert.equal(f.node('accountConfirmPlan').textContent, 'Plus');
    assert.equal(f.context.document.activeElement, f.node('accountConfirmCancel'));
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    await f.node('accountConfirmAccept').handlers.click();
    assert.equal(f.node('accountConfirmModal').open, false);
    assert.equal(f.node('accountConfirmEmail').textContent, '');
    assert.match(f.node('accountConfirmationState').textContent, /target@example.test/);
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    f.respond({ success: true, jobKey: 'accepted' });
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    const payments = f.calls.filter(call => call.url === '/api/run-process');
    assert.equal(payments.length, 1);
    assert.deepEqual(JSON.parse(payments[0].options.body), { cdk: 'CODE-TEST', session: session() });
    assert.equal(f.node('sessionInput').value, '');
    assert.equal(f.node('accountConfirmationState').textContent, '');
});

test('cancel and Escape never submit, and an unconfirmed submit must ask again', async () => {
    for (const action of ['button', 'escape']) {
        const f = setup();
        f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
        await f.node('redeemForm').handlers.submit({ preventDefault() {} });
        assert.equal(f.node('accountConfirmModal').open, true);
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
        if (action === 'button') f.node('accountConfirmCancel').handlers.click();
        else {
            let prevented = false;
            f.node('accountConfirmModal').handlers.cancel({ preventDefault() { prevented = true; } });
            assert.equal(prevented, true);
        }
        await f.node('accountConfirmAccept').handlers.click();
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
        assert.equal(f.node('sessionInput').value, session());
        assert.equal(f.context.document.activeElement, f.node('sessionInput'));
        await f.node('redeemForm').handlers.submit({ preventDefault() {} });
        assert.equal(f.node('accountConfirmModal').open, true);
    }
});

test('editing Session requires fresh confirmation even when the email stays the same', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.node('sessionInput').handlers.input({});
    await f.node('accountConfirmAccept').handlers.click();
    f.node('sessionInput').value = session('new'); f.node('sessionInput').handlers.input({});
    assert.equal(f.node('accountConfirmationState').textContent, '');
    assert.equal(f.node('accountConfirmModal').open, true);
    f.node('accountConfirmCancel').handlers.click();
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    f.respond({ success: true, jobKey: 'accepted' });
    await f.node('accountConfirmAccept').handlers.click();
    assert.equal(JSON.parse(f.calls.find(call => call.url === '/api/run-process').options.body).session, session('new'));
});

test('a stale modal cannot authorize changed Session, CDK, generation or a stopped form', async () => {
    for (const change of ['session', 'cdk', 'generation', 'stopped']) {
        const f = setup();
        f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
        await f.node('redeemForm').handlers.submit({ preventDefault() {} });
        if (change === 'session') f.node('sessionInput').value = session('new', 'other@example.test');
        if (change === 'cdk') f.node('cdkInput').value = 'NEW-CODE';
        if (change === 'generation') vm.runInContext('generation++', f.context);
        if (change === 'stopped') f.node('redeemForm').hidden = true;
        await f.node('accountConfirmAccept').handlers.click();
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
        assert.equal(f.node('accountConfirmationState').textContent, '');
    }
});

test('changing or re-verifying the CDK clears the confirmed account', async () => {
    for (const action of ['input', 'verify']) {
        const f = setup();
        f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
        f.node('sessionInput').handlers.input({});
        await f.node('accountConfirmAccept').handlers.click();
        if (action === 'input') f.node('cdkInput').handlers.input();
        else {
            f.respond({ success: true, data: { type: '自助', status: 'unused', plan_label: 'Plus' } });
            await f.node('verifyForm').handlers.submit({ preventDefault() {} });
        }
        assert.equal(f.node('accountConfirmModal').open, false);
        assert.equal(f.node('accountConfirmationState').textContent, '');
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    }
});

test('invalid, incomplete, expired or unidentified Sessions cannot be confirmed or submitted', async () => {
    const invalid = ['{', 'null', '[]', '{}', '{"accessToken":"test"}', session(''), session('test', 'invalid'),
        JSON.stringify({ ...JSON.parse(session()), expires: '2000-01-01T00:00:00Z' })];
    for (const raw of invalid) {
        const f = setup();
        f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = raw;
        f.node('sessionInput').handlers.input({});
        assert.equal(f.node('accountConfirmModal').open, false);
        await f.node('redeemForm').handlers.submit({ preventDefault() {} });
        assert.equal(f.node('accountConfirmModal').open, false);
        assert.match(f.node('statusMessage').textContent, /Session/);
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    }
});

test('Session expiration is rechecked after the user leaves the confirmation open', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-TEST';
    f.node('sessionInput').value = JSON.stringify({ ...JSON.parse(session()), expires: new Date(Date.now() + 60000).toISOString() });
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    f.advance(120000);
    await f.node('accountConfirmAccept').handlers.click();
    assert.match(f.node('statusMessage').textContent, /已过期/);
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
});

test('double confirmation and repeated submits send only one request while it is in flight', async () => {
    const f = setup(); let resolve;
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.respond(() => new Promise(done => { resolve = done; }));
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    const pending = f.node('accountConfirmAccept').handlers.click();
    await f.node('accountConfirmAccept').handlers.click();
    await f.node('redeemForm').handlers.submit({ preventDefault() {} });
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 1);
    resolve(reply({ success: true, jobKey: 'accepted' }));
    await pending;
});

test('account labels render as text and confirmation never displays access credentials', () => {
    const f = setup();
    const email = '<img/src=x>@example.test';
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session('sensitive-token', email);
    f.node('sessionInput').handlers.input({});
    assert.equal(f.node('accountConfirmEmail').textContent, email);
    assert.equal(f.node('accountConfirmEmail').innerHTML, undefined);
    for (const id of ['accountConfirmEmail', 'accountConfirmPlan', 'accountConfirmHint']) assert.doesNotMatch(f.node(id).textContent, /sensitive-token/);
});

test('terminal result shows a success notice only once across repeated polling', async () => {
    const f = setup();
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'success', target_email: 'paid@example.test', plan_label: 'ChatGPT Pro 100' } });
    await f.refresh();
    assert.equal(f.node('resultModal').hidden, false);
    assert.match(f.node('resultDescription').textContent, /订阅成功.*刷新账户状态/);
    assert.equal(f.node('resultSupport').textContent, '');
    assert.equal(f.node('resultAccountInfo').hidden, false);
    assert.equal(f.node('resultEmail').textContent, 'paid@example.test');
    assert.equal(f.node('resultPlan').textContent, 'ChatGPT Pro 100');
    assert.equal(f.node('planInfo').textContent, 'ChatGPT Pro 100 · 订阅成功');
    f.node('resultClose').handlers.click();
    assert.equal(f.node('resultEmail').textContent, '');
    await f.refresh();
    assert.equal(f.node('resultModal').hidden, true);
});

test('successful payment displays the original account and plan after Session has been cleared', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.respond(url => url === '/api/run-process'
        ? reply({ success: true, provider: 'orbitcard', jobKey: 'paid-job' })
        : reply({ success: true, data: { provider: 'orbitcard', jobKey: 'paid-job', status: 'success',
            target_email: 'target@example.test', plan_label: 'ChatGPT Plus' } }));
    await submitConfirmed(f); await flush();
    assert.equal(f.node('sessionInput').value, '');
    assert.equal(f.node('resultModal').hidden, false);
    assert.equal(f.node('resultEmail').textContent, 'target@example.test');
    assert.equal(f.node('resultPlan').textContent, 'ChatGPT Plus');
});

test('reopening a successful order needs only the CDK to show its recorded account and plan', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-REOPEN';
    f.respond(url => url === '/api/verify-cdk'
        ? reply({ success: true, data: { type: '自助', status: 'success', provider: 'orbitcard', jobKey: 'original-job', plan_label: 'ChatGPT Pro 200' } })
        : reply({ success: true, data: { provider: 'orbitcard', jobKey: 'original-job', status: 'success',
            target_email: 'original@example.test', plan_label: 'ChatGPT Pro 200' } }));
    await f.node('verifyForm').handlers.submit({ preventDefault() {} }); await flush();
    assert.equal(f.node('sessionInput').value, '');
    assert.equal(f.node('resultModal').hidden, false);
    assert.equal(f.node('resultEmail').textContent, 'original@example.test');
    assert.equal(f.node('resultPlan').textContent, 'ChatGPT Pro 200');
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
});

test('success uses the recorded account rather than another Session currently in the input', async () => {
    const f = setup();
    f.node('sessionInput').value = session('other-token', 'other@example.test');
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'success', target_email: 'paid@example.test', plan_label: 'ChatGPT Pro 500' } });
    await f.refresh();
    assert.equal(f.node('resultEmail').textContent, 'paid@example.test');
    assert.equal(f.node('resultPlan').textContent, 'ChatGPT Pro 500');
});

test('switching CDKs clears success details and missing history never reuses the previous account', async () => {
    const f = setup();
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'success', target_email: 'paid@example.test', plan_label: 'ChatGPT Pro 100' } });
    await f.refresh();
    f.node('cdkInput').value = 'NEW-CODE'; f.node('cdkInput').handlers.input();
    assert.equal(f.node('resultModal').hidden, true);
    assert.equal(f.node('resultAccountInfo').hidden, true);
    assert.equal(f.node('resultEmail').textContent, '');
    assert.equal(f.node('resultPlan').textContent, '');
    vm.runInContext("activeCdk='NEW-CODE';", f.context);
    f.node('sessionInput').value = session();
    f.respond({ success: true, data: { jobKey: 'new-job', status: 'success', target_email: null, plan_label: null } });
    await f.refresh();
    assert.equal(f.node('resultEmail').textContent, '原订单未记录账号');
    assert.equal(f.node('resultPlan').textContent, '原订单未记录套餐');
});

test('failed and uncertain results hide and clear the previous successful account summary', async () => {
    for (const status of ['failed', 'manual', 'retry']) {
        const f = setup();
        f.respond({ success: true, data: { jobKey: 'job-1', status: 'success', target_email: 'paid@example.test', plan_label: 'ChatGPT Plus' } });
        await f.refresh();
        f.respond({ success: true, data: { jobKey: 'job-1', status, target_email: 'unpaid@example.test', plan_label: 'ChatGPT Plus' } });
        await f.refresh();
        assert.equal(f.node('resultAccountInfo').hidden, true);
        assert.equal(f.node('resultEmail').textContent, '');
        assert.equal(f.node('resultPlan').textContent, '');
    }
});

test('successful account and plan details render as text without interpreting markup', async () => {
    const f = setup();
    const email = '<img/src=x>@example.test', plan = '<script>alert(1)</script>';
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'success', target_email: email, plan_label: plan } });
    await f.refresh();
    assert.equal(f.node('resultEmail').textContent, email);
    assert.equal(f.node('resultPlan').textContent, plan);
    assert.equal(f.node('resultEmail').innerHTML, undefined);
    assert.equal(f.node('resultPlan').innerHTML, undefined);
});

test('failed result displays provider reason as text and includes support contact', async () => {
    const f = setup();
    const reason = '该账号已有订阅 <script>alert(1)</script>';
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'failed',
        message: '充值失败', order: { failureMessage: reason } } });
    await f.refresh();
    assert.equal(f.node('resultDescription').textContent, reason);
    assert.match(f.node('resultSupport').textContent, /2244527967/);
});

test('manual result remains uncertain and a later success gets a new notice', async () => {
    const f = setup();
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'manual' } });
    await f.refresh();
    assert.equal(f.node('resultTitle').textContent, '充值结果待确认');
    assert.match(f.node('resultDescription').textContent, /请勿重复充值/);
    f.node('resultClose').handlers.click();
    f.respond({ success: true, data: { jobKey: 'job-1', status: 'success' } });
    await f.refresh();
    assert.equal(f.node('resultModal').hidden, false);
    assert.equal(f.node('resultTitle').textContent, '订阅成功');
});

test('querying a waiting retry keeps the Session form usable for the same order', async () => {
    const f = setup();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'retry' } });
    await f.refresh();
    assert.equal(f.node('redeemForm').hidden, false);
    f.node('cdkInput').value = 'CODE-TEST';
    f.node('sessionInput').value = session();
    f.respond({ success: true, provider: 'orbitcard', jobKey: 'job-1', status: 'running' });
    await submitConfirmed(f);
    assert.equal(f.node('sessionInput').value, '');
    assert.equal(f.node('redeemForm').hidden, true);
});

test('unconfirmed queries and transport errors remove stale captcha links', async () => {
    for (const response of [{ success: false, message: 'unconfirmed' }, new Error('network')]) {
        const f = setup();
        vm.runInContext("challenge({url:'https://example.test/verify',expires_at:new Date(Date.now()+60000).toISOString()})", f.context);
        assert.equal(f.node('captchaBox').children.length, 1);
        f.respond(response); await f.refresh();
        assert.equal(f.node('captchaBox').children.length, 0);
    }
});

test('manual refresh continues automatic polling and terminal results stop it', async () => {
    const f = setup();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'running' } });
    await vm.runInContext('startTracking()', f.context);
    assert.equal(f.timers.size, 1);
    await f.node('refreshBtn').handlers.click();
    assert.equal(f.timers.size, 1, 'manual refresh must retain exactly one polling timer');
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'success' } });
    await f.node('refreshBtn').handlers.click();
    assert.equal(f.timers.size, 0);
});

test('released CDKs require a fresh verification while reserved or unknown failures cannot retry', async () => {
    for (const state of ['available', 'reserved', undefined]) {
        const f = setup();
        f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'failed', cdk_state: state } });
        await f.refresh();
        assert.equal(f.node('retryBtn').hidden, state !== 'available');
        assert.equal(f.node('redeemForm').hidden, true);
        if (state !== 'available') continue;
        f.node('cdkInput').value = 'CODE-TEST';
        f.respond({ success: true, data: { type: '自助', status: 'unused', plan_label: 'Plus' } });
        await f.node('retryBtn').handlers.click({ preventDefault() {} });
        assert.equal(f.node('redeemForm').hidden, false);
        assert.equal(f.node('progressBox').hidden, true);
        assert.equal(f.node('retryBtn').hidden, true);
        assert.equal(f.calls.at(-1).url, '/api/verify-cdk');
        assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
    }
});

test('hanging queries time out, release the button and schedule a bounded retry', async () => {
    const f = setup(); await flush();
    f.respond((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = vm.runInContext('startTracking()', f.context);
    assert.equal(f.node('refreshBtn').disabled, true);
    f.fireTimeout(30000); await pending;
    assert.equal(f.node('refreshBtn').disabled, false);
    assert.match(f.node('statusMessage').textContent, /请求超时/);
    assert.equal(f.timers.size, 1);
});

test('a timed-out submission queries the original CDK without submitting again', async () => {
    const f = setup(); await flush();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.respond((url, options) => url === '/api/run-process'
        ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        : reply({ success: true, data: { provider: 'orbitcard', jobKey: 'accepted-job', status: 'running', cdk_state: 'reserved' } }));
    const pending = submitConfirmed(f);
    f.fireTimeout(30000); await pending; await flush();
    assert.equal(f.node('startBtn').disabled, false);
    assert.equal(f.node('redeemForm').hidden, true);
    assert.equal(f.node('retryBtn').hidden, true);
    assert.equal(f.node('sessionInput').value, '');
    assert.match(f.node('orderInfo').textContent, /accepted-job/);
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 1);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 1);
});

test('an old submission response cannot erase a new CDK Session', async () => {
    const f = setup(); let resolve;
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session('old');
    f.respond(() => new Promise(done => { resolve = done; }));
    const pending = submitConfirmed(f);
    f.node('cdkInput').value = 'NEW-CODE'; f.node('cdkInput').handlers.input();
    f.node('sessionInput').value = session('new');
    resolve(reply({ success: true, provider: 'orbitcard', jobKey: 'old-job' }));
    await pending;
    assert.equal(f.node('sessionInput').value, session('new'));
    assert.equal(f.node('orderInfo').textContent, '');
});

test('malformed server replies are distinct from invalid Session JSON and release controls', async () => {
    const f = setup();
    f.respond(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('HTML response'); } }));
    await f.refresh();
    assert.match(f.node('statusMessage').textContent, /服务端响应格式异常/);
    assert.equal(f.node('refreshBtn').disabled, false);
    assert.equal(f.timers.size, 0);
});

test('an explicitly rejected submission keeps the Session editable without starting a query', async () => {
    const f = setup();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.respond(() => ({ ok:false, status:400, json:async () => ({success:false,message:'Session 已过期'}) }));
    await submitConfirmed(f);
    assert.match(f.node('statusMessage').textContent,/Session 已过期/);
    assert.equal(f.node('redeemForm').hidden,false);
    assert.equal(f.node('startBtn').disabled,false);
    assert.equal(f.node('sessionInput').value,session());
    assert.equal(f.calls.filter(call=>call.url==='/api/cdk/orbitcard/status').length,0);
});

test('queue-full rejection preserves Session and shows a dismissible wait notice without support instructions', async () => {
    const f = setup(); await flush();
    const message = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.respond(() => ({ ok: false, status: 429, json: async () => ({ success: false, error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600, message }) }));
    await submitConfirmed(f);
    assert.equal(f.node('resultTitle').textContent, '请稍后下单');
    assert.equal(f.node('resultDescription').textContent, message);
    assert.equal(f.node('resultSupport').textContent, '');
    assert.equal(f.node('sessionInput').value, session());
    assert.equal(f.node('redeemForm').hidden, false);
    assert.equal(f.node('startBtn').disabled, false);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 0);
    f.node('resultClose').handlers.click();
    assert.equal(f.node('resultModal').hidden, true);
    await submitConfirmed(f);
    assert.equal(f.node('resultModal').hidden, false, 'an explicit repeated rejected submission still explains why it was rejected');
});

test('an accepted queued task stays in progress and keeps polling without another submission', async () => {
    const f = setup(); await flush();
    f.node('resultModal').hidden = true;
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'running', queued: true, message: '正在等待支付卡' } });
    await vm.runInContext('startTracking()', f.context);
    assert.equal(f.node('progressText').textContent, '排队等待');
    assert.match(f.node('planInfo').textContent, /排队等待/);
    assert.match(f.node('trackingHint').textContent, /系统会自动继续.*请勿重复提交/);
    assert.equal(f.node('redeemForm').hidden, true);
    assert.equal(f.node('resultModal').hidden, true);
    assert.equal(f.timers.size, 1);
    assert.equal(f.calls.filter(call => call.url === '/api/run-process').length, 0);
});

test('queue-full discovered after acceptance shows the wait notice once and stops tracking', async () => {
    const f = setup(); await flush();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'failed', cdk_state: 'available', error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600 } });
    await vm.runInContext('startTracking()', f.context);
    assert.equal(f.node('resultTitle').textContent, '请稍后下单');
    assert.equal(f.node('resultSupport').textContent, '');
    assert.match(f.node('trackingHint').textContent, /10 分钟后再下单/);
    assert.equal(f.node('retryBtn').hidden, false);
    assert.equal(f.timers.size, 0);
    f.node('resultClose').handlers.click();
    await f.refresh();
    assert.equal(f.node('resultModal').hidden, true);
});

test('runtime displays running and waiting capacity separately', async () => {
    const f = setup(); await flush();
    await f.runtime({ success: true, runtime: { active_foreground_jobs: 2, max_foreground_jobs: 3, waiting_jobs: 1, max_waiting_jobs: 1 } });
    assert.equal(f.node('runtimeInfo').textContent, '当前处理任务 2 / 3 · 排队等待 1 / 1');
});

test('an order that entered the queue keeps a fixed 45-minute tracking window after leaving the queue', async () => {
    const f = setup(); await flush();
    const data = { provider: 'orbitcard', jobKey: 'job-1', status: 'running', queued: true };
    f.respond({ success: true, data });
    await vm.runInContext('startTracking()', f.context);
    f.advance(16 * 60 * 1000);
    f.respond({ success: true, data: { ...data, queued: false } });
    await f.fireTimeout(5000);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 2);
    f.advance(28 * 60 * 1000);
    await f.fireTimeout(5000);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 3);
    f.advance(60 * 1000);
    await f.fireTimeout(5000);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 3);
    assert.equal(f.timers.size, 0);
    assert.match(f.node('trackingHint').textContent, /自动查询已暂停/);
});

test('nonqueued orders retain a 15-minute budget and a new CDK clears the prior queue extension', async () => {
    const f = setup(); await flush();
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'running', queued: true } });
    await vm.runInContext('startTracking()', f.context);
    f.node('cdkInput').value = 'NEW-CODE'; f.node('cdkInput').handlers.input();
    vm.runInContext("activeCdk='NEW-CODE'; activeJob='new-job';", f.context);
    f.respond({ success: true, data: { provider: 'orbitcard', jobKey: 'new-job', status: 'running' } });
    await vm.runInContext('startTracking()', f.context);
    const queries = f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length;
    f.advance(15 * 60 * 1000);
    await f.fireTimeout(5000);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, queries);
    assert.equal(f.timers.size, 0);
});

test('queue admission in the submission response extends tracking even if the first status response has already left the queue', async () => {
    const f = setup(); await flush();
    f.node('cdkInput').value = 'CODE-TEST'; f.node('sessionInput').value = session();
    f.respond(url => url === '/api/run-process'
        ? reply({ success: true, provider: 'orbitcard', jobKey: 'job-1', queued: true })
        : reply({ success: true, data: { provider: 'orbitcard', jobKey: 'job-1', status: 'running', queued: false } }));
    await submitConfirmed(f); await flush();
    f.advance(16 * 60 * 1000);
    await f.fireTimeout(5000);
    assert.equal(f.calls.filter(call => call.url === '/api/cdk/orbitcard/status').length, 2);
    assert.equal(f.timers.size, 1);
});
