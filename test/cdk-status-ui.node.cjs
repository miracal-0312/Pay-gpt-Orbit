'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(state = 'unused') {
    const source = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
    const block = source.slice(source.indexOf('function cdkListQuery('), source.indexOf('async function exportCdks('));
    const nodes = new Map(), calls = [], notices = [];
    const $ = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, open: false,
            showModal() { this.open = true; }, close() { this.open = false; } });
        return nodes.get(id);
    };
    let code = { code: 'CODE-SUPPORT', status: state, shipped: false };
    let fail = false, hold = null;
    const request = async (url, body) => {
        calls.push({ url, body });
        if (!body) return [code];
        assert.equal($('cdkStatusFields').disabled, true);
        if (hold) await hold;
        if (fail) throw Error('状态已发生变化');
        code = { ...code, status: body.status || code.status, shipped: body.shipped ?? code.shipped };
        if (body.status === 'redeemed') Object.assign(code, { manual_redeemed_at: '2026-10-28', manual_redemption_reason: '<script>bad</script>' });
        return { message: '状态已保存' };
    };
    const api = new Function('$', 'request', 'escapeHtml', 'status', 'notice', 'URLSearchParams', `
        let cdkPlanFilter='', cdkLoadSequence=0, cdkLoadedFilter=null, cdkLoadedCount=0, cdkExporting=false;
        let cdkEditing=null, cdkStatusSaving=false;
        const cdkPlans={}, cardPlans={};
        ${block}
        return {loadCdks,editCdkStatus,saveCdkStatus};
    `)($, request, value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), value => value,
    (...args) => notices.push(args), URLSearchParams);
    return { $, api, calls, notices, fail(value) { fail = value; }, hold(promise) { hold = promise; },
        open() { api.editCdkStatus({ dataset: { cdkStatus: code.code, cdkState: code.status, cdkShipped: String(code.shipped) } }); } };
}

test('every inventory row offers editing and the dialog reflects current usage and shipping', async () => {
    for (const state of ['unused', 'processing', 'redeemed']) {
        const f = fixture(state); await f.api.loadCdks();
        assert.match(f.$('cdkRows').innerHTML, /修改状态/);
        assert.ok(f.$('cdkRows').innerHTML.includes(`data-cdk-state="${state}"`));
        f.open();
        assert.equal(f.$('cdkStatusDialog').open, true);
        assert.equal(f.$('cdkEditStatus').value, state);
        assert.equal(f.$('cdkEditStatus').disabled, state === 'redeemed');
        assert.equal(f.$('cdkEditShipped').value, 'false');
        assert.equal(f.$('cdkStatusCode').textContent, 'CODE-SUPPORT');
    }
});

test('saving shipping only sends the changed field plus expected states, then closes and refreshes', async () => {
    const f = fixture(); f.open();
    f.$('cdkEditShipped').value = 'true'; f.$('cdkStatusReason').value = ' 人工发货 ';
    await f.api.saveCdkStatus();
    assert.deepEqual(f.calls[0], { url: '/api/admin/cdks/CODE-SUPPORT/status', body: {
        reason: '人工发货', expected_status: 'unused', expected_shipped: false, shipped: true
    } });
    assert.equal(f.$('cdkStatusDialog').open, false);
    assert.equal(f.$('cdkStatusFields').disabled, false);
    assert.equal(f.calls.length, 2);
    assert.match(f.$('cdkRows').innerHTML, /已出库/);
});

test('combined edits save once, preserve redemption escaping and keep editing available', async () => {
    const f = fixture('processing'); f.open();
    f.$('cdkEditStatus').value = 'redeemed'; f.$('cdkEditShipped').value = 'true';
    f.$('cdkStatusReason').value = '售后完成';
    let finish; f.hold(new Promise(resolve => { finish = resolve; }));
    const pending = f.api.saveCdkStatus();
    await f.api.saveCdkStatus();
    assert.equal(f.calls.length, 1);
    assert.equal(f.$('cdkStatusFields').disabled, true);
    finish(); await pending;
    assert.deepEqual(f.calls[0].body, { reason: '售后完成', expected_status: 'processing', expected_shipped: false, status: 'redeemed', shipped: true });
    assert.match(f.$('cdkRows').innerHTML, /人工售后核销/);
    assert.doesNotMatch(f.$('cdkRows').innerHTML, /<script>/);
    assert.match(f.$('cdkRows').innerHTML, /修改状态/);
});

test('blank notes, unchanged status and failed saves keep the dialog open with actionable errors', async () => {
    const f = fixture(); f.open();
    await f.api.saveCdkStatus();
    assert.match(f.$('cdkStatusError').textContent, /备注/);
    f.$('cdkStatusReason').value = '备注';
    await f.api.saveCdkStatus();
    assert.match(f.$('cdkStatusError').textContent, /状态未变化/);
    assert.equal(f.calls.length, 0);
    f.$('cdkEditShipped').value = 'true'; f.fail(true);
    await f.api.saveCdkStatus();
    assert.match(f.$('cdkStatusError').textContent, /状态已发生变化/);
    assert.equal(f.$('cdkStatusDialog').open, true);
    assert.equal(f.$('cdkStatusReason').value, '备注');
    assert.equal(f.$('cdkStatusFields').disabled, false);
});
