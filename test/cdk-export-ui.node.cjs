'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
    const source = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
    const block = source.slice(source.indexOf('function cdkListQuery('), source.indexOf('async function loadLogs('));
    const nodes = new Map(), requests = [], exports = [], downloads = [], notices = [];
    const $ = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, checkValidity: () => true, reportValidity() {} });
        return nodes.get(id);
    };
    $('cdkStatusFilter').value = 'unused'; $('cdkShippedFilter').value = 'false';
    $('cdkExportFormat').value = 'secret'; $('cdkMarkShipped').checked = true;
    let codes = [{ code: 'DEMO-PLUS', status: 'unused', shipped: false, plan_type: 'plus' }];
    let response = async () => ({ ok: true, status: 200, blob: async () => new Blob(['secret\r\nDEMO-PLUS\r\n']) });
    const tokens = new Map([['token', 'login'], ['secondary', 'verified']]);
    const api = new Function('$', 'request', 'fetch', 'localStorage', 'document', 'URL', 'URLSearchParams', 'setTimeout', 'notice', `
        const TOKEN_KEY = 'token', SECONDARY_KEY = 'secondary', cardPlans = {plus:'Plus'}, cdkPlans = {};
        const escapeHtml = value => String(value ?? ''), status = escapeHtml;
        const logout = () => { throw new Error('logged out'); };
        let cdkPlanFilter = 'plus', cdkLoadSequence = 0, cdkLoadedFilter = null, cdkLoadedCount = 0, cdkExporting = false;
        ${block}
        return {loadCdks, exportCdks, setPlan: plan => {cdkPlanFilter = plan;}};
    `)($, async url => { requests.push(url); return codes; }, async (url, options) => {
        exports.push({ url, options }); return response();
    }, { getItem: key => tokens.get(key), removeItem: key => tokens.delete(key) },
    { body: { append() {} }, createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }) },
    { createObjectURL: () => 'blob:download', revokeObjectURL() {} }, URLSearchParams, () => {}, (...args) => notices.push(args));
    return { $, api, requests, exports, downloads, notices, codes: value => { codes = value; }, respond: value => { response = value; } };
}

test('list and export share filters and send explicit format, quantity and shipping choice', async () => {
    const f = setup();
    await f.api.loadCdks();
    f.$('cdkExportQuantity').value = '10'; f.$('cdkMarkShipped').checked = false;
    await f.api.exportCdks();
    const url = new URL(f.exports[0].url, 'http://localhost');
    assert.equal(f.exports[0].options.method, 'POST');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
        plan_type: 'plus', status: 'unused', shipped: 'false', quantity: '10', format: 'secret', mark_shipped: 'false'
    });
    assert.ok(f.requests.every(url => url.endsWith('?plan_type=plus&status=unused&shipped=false')));
    assert.match(f.downloads[0], /^cdks-plus-secret-.*\.csv$/);
    assert.match(f.notices[0][0], /出库状态未变更/);
    assert.equal(f.$('exportCdks').disabled, false);
});

test('export blocks duplicates during refresh and keeps the original filter snapshot', async () => {
    const f = setup(); await f.api.loadCdks();
    let finish;
    f.respond(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.exportCdks();
    f.api.setPlan('pro100'); await f.api.loadCdks();
    assert.equal(f.$('exportCdks').disabled, true);
    await f.api.exportCdks();
    assert.equal(f.exports.length, 1);
    const loads = f.requests.length;
    finish({ ok: true, status: 200, blob: async () => new Blob(['secret']) });
    await pending;
    assert.match(f.downloads[0], /^cdks-plus-secret-/);
    assert.equal(f.requests.length, loads, 'must not refresh using stale export filters');
    assert.equal(f.$('exportCdks').disabled, false);
});

test('empty results, invalid input and failed secondary auth do not produce downloads', async () => {
    const f = setup(); await f.api.loadCdks();
    f.$('cdkExportQuantity').checkValidity = () => false;
    await assert.rejects(f.api.exportCdks(), /导出数量/);
    assert.equal(f.exports.length, 0);
    f.$('cdkExportQuantity').checkValidity = () => true;
    f.respond(async () => ({ ok: false, status: 403, json: async () => ({ secondaryRequired: true, message: '请重新验证' }) }));
    await assert.rejects(f.api.exportCdks(), /请重新验证/);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.$('exportCdks').disabled, true);
    assert.equal(f.$('exportCdks').textContent, '按配置导出 CSV');

    const empty = setup(); await empty.api.loadCdks();
    empty.codes([]);
    await empty.api.exportCdks();
    assert.equal(empty.$('exportCdks').disabled, true, 'empty inventory after shipping must stay disabled');
});

test('a completed download with a failed refresh is reported separately and requires reloading', async () => {
    const f = setup(); await f.api.loadCdks();
    f.codes(null);
    await f.api.exportCdks();
    assert.equal(f.downloads.length, 1);
    assert.match(f.notices.at(-1)[0], /文件已导出，但列表刷新失败/);
    assert.equal(f.$('exportCdks').disabled, true);
});
