'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');

function inputFixture() {
    const nodes = { apiEnabled: { checked: true }, baseUrl: { value: 'https://orbitcard.test' },
        productCode: { value: '' }, cardAuthorizationLimit: { value: '4' }, maxInitialAmount: { value: '' }, maxFee: { value: '' } };
    const block = source.slice(source.indexOf('function apiInput()'), source.indexOf('function renderCardRow('));
    const apiInput = new Function('$', 'cardPlans', block + '\nreturn apiInput;')(id => nodes[id], {});
    return { nodes, apiInput };
}

test('card authorization limit uses native required positive integer validation and the common configuration save form', () => {
    const form = html.match(/<form id="apiForm"[^>]*>[\s\S]*?<\/form>/)[0];
    const input = form.match(/<input id="cardAuthorizationLimit"[^>]*>/)[0];
    for (const expected of ['type="number"', 'min="1"', 'step="1"', 'value="4"', 'required']) assert.ok(input.includes(expected), expected);
    assert.match(input, /max="9007199254740991"/);
    assert.doesNotMatch(form, /novalidate/);
    assert.match(form, /保存配置/);
    assert.match(form, /提高上限不会恢复已注销卡/);
    assert.match(form, /已提交订单仍查询原单/);
    const cards = html.match(/<section id="cards"[\s\S]*?<\/section>/)[0];
    assert.match(cards, /href="#orbitcard"/);
    assert.match(cards, /达到配置上限/);
    assert.doesNotMatch(cards, /累计 7 次/);
});

test('configuration serializes the chosen limit as a positive safe integer without an arbitrary business cap', () => {
    const f = inputFixture();
    for (const limit of [1, 4, 7, 12, 1001, Number.MAX_SAFE_INTEGER]) {
        f.nodes.cardAuthorizationLimit.value = String(limit);
        const result = f.apiInput();
        assert.equal(result.orbitcard_max_authorizations, limit);
        assert.equal(typeof result.orbitcard_max_authorizations, 'number');
    }
    for (const invalid of ['', ' ', '0', '-1', '1.5', 'not-a-number', 'Infinity', '9007199254740992']) {
        f.nodes.cardAuthorizationLimit.value = invalid;
        assert.throws(f.apiInput, /正整数/, invalid);
    }
});

test('configuration reloads a saved authorization limit and defaults older configurations to four', async () => {
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', dataset: {} });
        return nodes.get(id);
    };
    const block = source.slice(source.indexOf('async function loadApi()'), source.indexOf('function regionLabel('));
    let config = { base_url: 'https://orbitcard.test', orbitcard_max_authorizations: 1001 };
    const loadApi = new Function('$', 'request', 'cardPlans', 'renderPaymentRegionOptions',
        'let savedBaseUrl, paymentRegionLoadSequence=0;\n' + block + '\nreturn loadApi;')(
        node, async () => ({ config }), {}, () => {});
    await loadApi();
    assert.equal(node('cardAuthorizationLimit').value, '1001');
    config = { base_url: 'https://orbitcard.test' };
    await loadApi();
    assert.equal(node('cardAuthorizationLimit').value, '4');
});

test('saving uses the existing configuration endpoint and preserves the edited value if backend validation rejects it', async () => {
    const f = inputFixture(), calls = [], notices = [];
    let handler, reloads = 0, reject = false;
    const block = source.slice(source.indexOf("form('apiForm'"), source.indexOf('const diagnosticLines'));
    new Function('form', 'request', 'apiInput', 'notice', 'loadApi', block)(
        (id, fn) => { assert.equal(id, 'apiForm'); handler = fn; },
        async (url, body) => { calls.push({ url, body }); if (reject) throw Error('上限参数未通过服务端验证'); return { message: '已保存' }; },
        f.apiInput, message => notices.push(message), async () => { reloads++; });
    f.nodes.cardAuthorizationLimit.value = '12';
    await handler();
    assert.equal(calls[0].url, '/api/admin/gpt-api');
    assert.equal(calls[0].body.orbitcard_max_authorizations, 12);
    assert.equal(reloads, 1);
    reject = true; f.nodes.cardAuthorizationLimit.value = '25';
    await assert.rejects(handler(), /服务端验证/);
    assert.equal(f.nodes.cardAuthorizationLimit.value, '25');
    assert.equal(reloads, 1);
    assert.deepEqual(notices, ['已保存']);
    f.nodes.cardAuthorizationLimit.value = '0';
    await assert.rejects(handler(), /正整数/);
    assert.equal(calls.length, 2, 'invalid local values do not reach the configuration endpoint');
});

test('card rows display the server supplied authorization limit and apply it to the status label', () => {
    const block = source.slice(source.indexOf('function renderCardRow('), source.indexOf('async function loadCards('));
    const renderCardRow = new Function('escapeHtml', block + '\nreturn renderCardRow;')(value => String(value ?? ''));
    const card = { card_id: 42, authorization_count: 7, authorization_limit: 12, provider_status: 'ACTIVE' };
    assert.match(renderCardRow(card), /7 \/ 12 次成功消费授权/);
    assert.doesNotMatch(renderCardRow(card), /达到上限，停止分配/);
    card.authorization_limit = 3;
    assert.match(renderCardRow(card), /7 \/ 3 次成功消费授权/);
    assert.match(renderCardRow(card), /达到上限，停止分配/);
});
