'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function setup(fetchResult) {
    const source = fs.readFileSync(require.resolve('../public/diagnostics.js'), 'utf8');
    const block = source.slice(source.indexOf('function diagShowConcurrency('), source.indexOf("\ndocument.querySelectorAll('[data-diag-stage]')"));
    const nodes = new Map(), buttons = [{ disabled: false }, { disabled: false }], calls = [];
    const $ = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, textContent: '', innerHTML: '',
            replaceChildren() { this.innerHTML = ''; }, add() {} });
        return nodes.get(id);
    };
    $('diagConcurrentTasks').value = '10'; $('diagPlan').value = 'gpt-plus'; $('diagSession').value = 'private-session';
    const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const api = new Function('$', 'document', 'crypto', 'escapeHtml', 'diagnosticFetch', 'diagFollow', 'diagReadLogs', 'Option', 'notice',
        'let diagPreflightBusy = false;\n' + block + '\nreturn { diagPreflight, diagShowConcurrency };')(
        $, { querySelectorAll: () => buttons }, { randomUUID: () => 'f5be614a-464e-47e3-b582-0dc03748f834' }, escapeHtml,
        async (url, input) => { calls.push({ url, input }); return fetchResult(); }, () => {}, async () => {}, function() {}, () => {});
    return { api, $, calls, buttons };
}

function simulation() {
    return { task_count: 10, summary: { assigned: 1, pay: 1, fund: 0, waiting: 9, blocked: 0, opening: 0, duplicate_assignments: 0 },
        initial_contention: { card_id: 42, tasks: 10 }, budget: { available: '100.00', reserved: '0.00', remaining: '100.00' },
        tasks: [{ task: 1, initial_card_id: 42, card_id: 42, action: 'pay', funding_amount: '0.00', reason: 'reserved_in_simulation' },
            { task: 2, initial_card_id: 42, card_id: null, action: 'wait', funding_amount: '0.00', reason: 'busy' }] };
}

test('concurrency UI sends one readonly request without Session and renders model results separately from payment readiness', async () => {
    let finish;
    const f = setup(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.diagPreflight('concurrency');
    await f.api.diagPreflight('concurrency');
    assert.equal(f.calls.length, 1); assert.ok(f.buttons.every(button => button.disabled));
    assert.deepEqual(f.calls[0].input, { stage: 'concurrency', request_id: 'f5be614a-464e-47e3-b582-0dc03748f834',
        plan_type: 'gpt-plus', concurrent_tasks: 10 });
    finish({ trace_id: 'debug-test', passed: true, ready: false, read_only: true,
        steps: [{ step: 'concurrency', state: 'passed', message: '模拟任务', elapsed_ms: 1 }], result: { concurrency: simulation() } });
    await pending;
    assert.equal(f.$('diagConcurrency').hidden, false);
    assert.match(f.$('diagSteps').innerHTML, /完成模拟/);
    assert.match(f.$('diagConcurrencySummary').textContent, /等待 9 个.*模型内重复分配 0 次/);
    assert.match(f.$('diagConcurrencyBudget').textContent, /不代表真实并发压测通过/);
    assert.match(f.$('diagConcurrencyRows').innerHTML, /已被其他任务占用/);
    assert.ok(f.buttons.every(button => !button.disabled));
});

test('simulation failures clear the previous table and invalid task counts do not send requests', async () => {
    const f = setup(async () => { throw Error('读取失败'); });
    f.api.diagShowConcurrency(simulation());
    await assert.rejects(f.api.diagPreflight('concurrency'), /读取失败/);
    assert.equal(f.$('diagConcurrency').hidden, true); assert.equal(f.$('diagConcurrencyRows').innerHTML, '');
    assert.ok(f.buttons.every(button => !button.disabled));
    for (const value of ['', '1', '101', '2.5']) {
        f.$('diagConcurrentTasks').value = value;
        await assert.rejects(f.api.diagPreflight('concurrency'), /2 到 100/);
    }
    assert.equal(f.calls.length, 1);
});

test('concurrency reasons are escaped before rendering', () => {
    const f = setup(() => {}), data = simulation();
    data.tasks[0].message = '<img src=x onerror=alert(1)>';
    f.api.diagShowConcurrency(data);
    assert.doesNotMatch(f.$('diagConcurrencyRows').innerHTML, /<img/);
    assert.match(f.$('diagConcurrencyRows').innerHTML, /&lt;img/);
});
