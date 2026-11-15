'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
const manifestPath = '/api/admin/orbitcard/diagnostics/interfaces';
const testPath = '/api/admin/orbitcard/diagnostics/interface-test';
const operations = ['getAccountBalance', 'getProductCode', 'getSubscriptionPlans', 'getSubscriptionPaymentRegions',
    'getCardList', 'cardDetail', 'cardTransaction', 'getCardFlow', 'getSubscriptionList', 'getSubscription',
    'createCard', 'rechargeCard', 'deleteCard', 'createSubscription'].map((operation, index) => ({
        operation, path: `/api/open/v1/${operation}`, label: operation, mode: index < 10 ? 'live_read' : 'local_simulation'
    }));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => JSON.parse(JSON.stringify(value));

function success(url, body) {
    if (url === manifestPath) return { success: true, target: 'https://saved.test', operations: clone(operations) };
    assert.equal(url, testPath);
    const spec = operations.find(item => item.operation === body.operation);
    return { success: true, result: { ...spec, status: 'passed', message: spec.mode === 'live_read' ? '查询通过' : '本地模拟通过',
        elapsed_ms: 12, ...(spec.mode === 'live_read' ? { http_status: 200 } : {}),
        summary: spec.operation === 'getCardList' ? { selected_card_id: 42 } : { sent_to_platform: spec.mode === 'live_read' },
        checks: spec.operation === 'getSubscriptionPaymentRegions'
            ? ['gpt-plus', 'gpt-pro-100', 'gpt-pro-200', 'gpt-pro-500'].map(plan_type => ({ plan_type, status: 'passed', http_status: 200, elapsed_ms: 3 }))
            : spec.mode === 'local_simulation' ? [{ name: '参数规则', status: 'passed' }] : [] } };
}

function setup(responder = success) {
    const nodes = new Map(), calls = [], writes = [];
    let active = 0, maxActive = 0;
    const node = id => {
        if (!nodes.has(id)) {
            const item = { value: '', className: '', disabled: false, content: '' };
            for (const key of ['textContent', 'innerHTML']) Object.defineProperty(item, key, {
                get() { return this.content; },
                set(value) { this.content = value; writes.push({ id, key, value }); }
            });
            nodes.set(id, item);
        }
        return nodes.get(id);
    };
    node('baseUrl').value = 'https://unsaved-input.test';
    const context = vm.createContext({ $: node, Date, performance, escapeHtml,
        async request(url, body) {
            calls.push({ url, body: body === undefined ? undefined : clone(body), disabled: node('testAllApi').disabled,
                progress: node('apiTestSummary').textContent });
            maxActive = Math.max(maxActive, ++active);
            try { return await responder(url, body, calls.length); } finally { active--; }
        }
    });
    vm.runInContext(source.slice(source.indexOf('const diagnosticLines'), source.indexOf("$('clearDiagnosticLog').onclick")), context);
    return { node, calls, writes, context, run: () => context.runAllApiDiagnostics(), get maxActive() { return maxActive; } };
}

test('one API test entry presents the full interface table and distinguishes live reads from local writes', () => {
    const panel = html.slice(html.indexOf('<div id="diagnostic-api"'), html.indexOf('<div id="diagnostic-payment"'));
    assert.match(panel, /id="testAllApi"[^>]*>一键全部测试<\/button>/);
    assert.doesNotMatch(panel, /id="(?:testApi|loadCatalog|loadRegions|testResult|catalog|regionResult)"/);
    for (const id of ['apiTestSummary', 'apiInterfaceTarget', 'apiInterfaceRows']) assert.match(panel, new RegExp(`id="${id}"`));
    assert.match(panel, /10 个查询接口使用已保存配置/);
    assert.match(panel, /4 个写接口仅在本地模拟/);
    assert.match(panel, /模拟通过不代表真实可支付/);
    assert.match(panel, /id="testTelegram"/);
});

test('one click tests each manifest operation once in order and only carries the selected card to dependent reads', async () => {
    const f = setup();
    await f.node('testAllApi').onclick();
    assert.equal(f.calls.length, operations.length + 1);
    assert.equal(f.calls[0].url, manifestPath);
    assert.equal(f.calls[0].body, undefined);
    assert.ok(f.calls.slice(1).every(call => call.url === testPath));
    assert.deepEqual(f.calls.slice(1).map(call => call.body.operation), operations.map(item => item.operation));
    for (const call of f.calls.slice(1)) assert.deepEqual(call.body, ['cardDetail', 'cardTransaction', 'getCardFlow'].includes(call.body.operation)
        ? { operation: call.body.operation, card_id: 42 } : { operation: call.body.operation });
    assert.equal(f.maxActive, 1);
    assert.ok(f.calls.every(call => call.disabled));
    assert.match(f.calls[1].progress, /正在测试 1\/14/);
    assert.match(f.calls.at(-1).progress, /正在测试 14\/14/);
    assert.match(f.node('apiInterfaceTarget').textContent, /https:\/\/saved\.test/);
    assert.doesNotMatch(JSON.stringify(f.calls), /unsaved-input/);
    assert.match(f.node('apiTestSummary').textContent, /真实查询通过 10 项，本地模拟通过 4 项，失败 0 项，跳过 0 项/);
    assert.equal(f.node('apiTestSummary').className, 'diagnostic-output success');
    assert.equal((f.node('apiInterfaceRows').innerHTML.match(/<tr>/g) || []).length, operations.length);
    assert.equal((f.node('apiInterfaceRows').innerHTML.match(/未向平台发送/g) || []).length, 4);
    assert.equal((f.node('apiInterfaceRows').innerHTML.match(/<span class="pill success">模拟通过/g) || []).length, 4);
    assert.equal(f.node('testAllApi').disabled, false);
    assert.equal(f.node('testAllApi').textContent, '一键全部测试');
    assert.match(f.node('diagnosticLog').textContent, /本地模拟（未发送）/);
    assert.doesNotMatch(f.node('diagnosticLog').textContent, /平台失败.*unknown/);
});

test('overlapping direct invocations cannot start another run and rerunning removes stale rows and card selection', async () => {
    let release, round = 0;
    const f = setup(async (url, body) => {
        if (url === manifestPath) { round++; await new Promise(resolve => { release = resolve; }); }
        const data = success(url, body);
        if (round > 1 && body?.operation === 'getCardList') data.result.summary.selected_card_id = null;
        return data;
    });
    f.node('apiInterfaceRows').innerHTML = 'stale result';
    f.node('apiTestSummary').className = 'diagnostic-output error';
    const pending = f.run();
    await f.run(); await f.node('testAllApi').onclick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.node('testAllApi').disabled, true);
    assert.doesNotMatch(f.node('apiInterfaceRows').innerHTML, /stale result/);
    assert.equal(f.node('apiTestSummary').className, 'diagnostic-output');
    release(); await pending;
    const next = f.run();
    assert.match(f.node('apiInterfaceRows').innerHTML, /正在读取本轮接口清单/);
    release(); await next;
    assert.equal(f.calls.length, 2 * (operations.length + 1));
    assert.ok(f.calls.slice(operations.length + 2).every(call => call.body.card_id === undefined));
});

test('HTTP failures, reported failures and nested failed checks count accurately while later operations continue', async () => {
    const f = setup((url, body) => {
        if (body?.operation === 'getAccountBalance') throw Object.assign(Error('unavailable'), { httpStatus: 503 });
        const data = success(url, body);
        if (body?.operation === 'getProductCode') Object.assign(data.result, { status: 'failed', message: 'products failed' });
        if (body?.operation === 'getSubscriptionPaymentRegions') data.result.checks[1].status = 'failed';
        if (body?.operation === 'getSubscription') Object.assign(data.result, { status: 'skipped', message: 'no original order' });
        return data;
    });
    await f.run();
    assert.equal(f.calls.length, operations.length + 1);
    assert.match(f.node('apiTestSummary').textContent, /真实查询通过 6 项，本地模拟通过 4 项，失败 3 项，跳过 1 项/);
    assert.equal(f.node('apiTestSummary').className, 'diagnostic-output error');
    assert.match(f.node('apiInterfaceRows').innerHTML, /unavailable/);
    assert.match(f.node('apiInterfaceRows').innerHTML, /products failed/);
    assert.match(f.node('apiInterfaceRows').innerHTML, /部分接口检查失败/);
    assert.match(f.node('apiInterfaceRows').innerHTML, /no original order/);
    assert.equal(f.node('testAllApi').disabled, false);
});

test('unavailable card and order context appears as skipped rather than passed and sends no invented identifier', async () => {
    const f = setup((url, body) => {
        const data = success(url, body);
        if (body?.operation === 'getCardList') data.result.summary.selected_card_id = null;
        if (['cardDetail', 'cardTransaction', 'getCardFlow', 'getSubscription'].includes(body?.operation)) {
            Object.assign(data.result, { status: 'skipped', message: '没有可查询记录' });
        }
        return data;
    });
    await f.run();
    assert.equal(f.calls.length, operations.length + 1);
    assert.ok(f.calls.slice(1).every(call => call.body.card_id === undefined));
    assert.match(f.node('apiTestSummary').textContent, /真实查询通过 6 项，本地模拟通过 4 项，失败 0 项，跳过 4 项/);
    assert.equal(f.node('apiTestSummary').className, 'diagnostic-output warning');
});

test('malformed manifests fail before posting and invalid result identities fail only their own row', async () => {
    for (const manifest of [{}, { operations: [] }, { operations: [operations[0], operations[0]] },
        { operations: [{ ...operations[0], mode: 'live_write' }] }]) {
        const f = setup(() => manifest);
        await f.run();
        assert.equal(f.calls.length, 1);
        assert.match(f.node('apiTestSummary').textContent, /接口清单无效/);
        assert.equal(f.node('testAllApi').disabled, false);
    }
    const f = setup((url, body) => {
        const data = success(url, body);
        if (body?.operation === 'createCard') data.result.mode = 'live_read';
        return data;
    });
    await f.run();
    assert.equal(f.calls.length, operations.length + 1);
    assert.match(f.node('apiTestSummary').textContent, /真实查询通过 10 项，本地模拟通过 3 项，失败 1 项/);
    assert.match(f.node('apiInterfaceRows').innerHTML, /接口测试结果与请求不匹配/);
});

test('manifest request failures release controls and all response labels, messages and summaries are rendered safely', async () => {
    const failed = setup(() => { throw Error('login expired'); });
    await failed.run();
    assert.equal(failed.calls.length, 1);
    assert.match(failed.node('apiTestSummary').textContent, /login expired/);
    assert.equal(failed.node('testAllApi').disabled, false);
    const unsafe = '<img src=x onerror=alert(1)>';
    const f = setup((url, body) => {
        const data = success(url, body);
        if (url === manifestPath) { data.target = unsafe; data.operations[0].label = unsafe; }
        else if (body.operation === 'getAccountBalance') Object.assign(data.result, { message: unsafe, summary: { value: unsafe } });
        return data;
    });
    await f.run();
    assert.match(f.node('apiInterfaceTarget').textContent, /<img/);
    assert.doesNotMatch(f.node('apiInterfaceRows').innerHTML, /<img/);
    assert.match(f.node('apiInterfaceRows').innerHTML, /&lt;img/);
});

test('the separate diagnostic runner remains usable for Telegram without joining the interface manifest', async () => {
    const f = setup();
    await f.context.runDiagnostic('testTelegram', 'telegramTestResult', async () => 'message sent');
    assert.equal(f.node('telegramTestResult').textContent, 'message sent');
    assert.equal(f.node('testTelegram').disabled, false);
    assert.equal(f.calls.length, 0);
});
