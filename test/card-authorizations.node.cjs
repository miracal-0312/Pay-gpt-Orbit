'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readAuthorizations } = require('../orbitcard-authorizations');
const { CardPreparationError } = require('../orbitcard-card-policy');
const cfg = { base_url: 'https://orbitcard.test' };
const authorization = (id, extra = {}) => ({ transaction_id: String(id), card_id: 42,
    transaction_type: 'Authorization', status: 'approved', ...extra });
function apiFor(rows, calls = []) {
    return { request: async (config, operation, body) => {
        calls.push({ config, operation, body });
        return { success: true, data: { list: rows.slice((body.page - 1) * body.page_size, body.page * body.page_size),
            total: rows.length, page: body.page, page_size: body.page_size } };
    } };
}

test('reads every page and counts successful authorizations without counting their settlements twice', async () => {
    const rows = Array.from({ length: 102 }, (_, i) => authorization(i));
    rows.push(authorization(0, { transaction_type: 'Settlement' }), authorization('refund', { transaction_type: 'Refund' }),
        authorization('reversal', { transaction_type: 'Reversal' }), authorization('chargeback', { transaction_type: 'Chargeback' }),
        authorization('failed', { status: 'declined' }));
    const calls = [], ids = await readAuthorizations(apiFor(rows, calls), cfg, 42);
    assert.equal(ids.length, 102); assert.equal(new Set(ids).size, 102);
    assert.deepEqual(calls.map(call => call.body), [{ card_id: 42, page: 1, page_size: 100 }, { card_id: 42, page: 2, page_size: 100 }]);
    assert.ok(calls.every(call => call.config === cfg && call.operation === 'cardTransaction'));
});

test('recognizes explicit successful authorization outcomes without requiring amounts', async () => {
    const statuses = ['authorized', 'APPROVED', 'SUCCESS', 'successful', 'succeeded', 'completed', '授权成功', '已完成'];
    const rows = statuses.map((status, i) => authorization(i, { status, transaction_type: i % 2 ? 'aUtHoRiZaTiOn' : '消费授权' }));
    assert.deepEqual(await readAuthorizations(apiFor(rows), cfg, 42), statuses.map((_, i) => String(i)));
});

test('counts the reported platform Authorization SUCCESS record with no amount fields', async () => {
    const row = { transaction_id: 59304931, card_id: 19468968, type: 'Authorization', status: 'SUCCESS' };
    const api = { request: async () => ({ success: true, status: 200, code: 0,
        data: { list: [row], total: 1 } }) };
    assert.deepEqual(await readAuthorizations(api, cfg, row.card_id), ['59304931']);
});

test('pending, rejected, expired and canceled authorizations do not count until a later success', async () => {
    const statuses = ['pending', 'processing', 'failed', 'declined', 'rejected', 'cancelled', 'canceled', 'reversed', 'expired', 'voided'];
    const rows = statuses.map((status, i) => authorization(i, { status }));
    assert.deepEqual(await readAuthorizations(apiFor(rows), cfg, 42), []);
    rows[0].status = 'approved';
    assert.deepEqual(await readAuthorizations(apiFor(rows), cfg, 42), ['0']);
});

test('rejects unknown status codes or types without leaking private provider values', async () => {
    const secret = 'private-full-response-value';
    for (const row of [authorization('one', { status: 0 }), authorization('one', { status: true }),
        authorization('one', { status: '0' }), authorization('one', { status: secret }),
        authorization('one', { transaction_type: secret }), authorization('one', { transaction_type: null, type: null })]) {
        await assert.rejects(readAuthorizations(apiFor([row]), cfg, 42), error =>
            error instanceof CardPreparationError && !error.message.includes(secret));
    }
    await assert.rejects(readAuthorizations({ request: async () => { throw Error(secret); } }, cfg, 42), error =>
        error instanceof CardPreparationError && !error.message.includes(secret));
});

test('requires stable bounded IDs and card ownership, rejecting duplicate pages', async () => {
    for (const row of [null, [], authorization('foreign', { card_id: 43 }), authorization('foreign', { card_id: false }),
        authorization('', {}), authorization(' '.repeat(3)), authorization('trailing '), authorization('x'.repeat(129)), authorization('line\nbreak'),
        authorization(1, { transaction_id: Number.MAX_SAFE_INTEGER + 1 }), authorization(1, { transaction_id: {} })])
        await assert.rejects(readAuthorizations(apiFor([row]), cfg, 42), CardPreparationError);
    await assert.rejects(readAuthorizations(apiFor([authorization('same'), authorization('same')]), cfg, 42), /重复/);
    const rows = Array.from({ length: 100 }, (_, i) => authorization(i)); rows.push(authorization(0));
    await assert.rejects(readAuthorizations(apiFor(rows), cfg, 42), /重复/);
    assert.deepEqual(await readAuthorizations(apiFor([authorization('Case'), authorization('case')]), cfg, 42), ['Case', 'case']);
});

test('successful authorization counting ignores missing, zero and differently formatted amounts', async () => {
    const amounts = [{}, { authorization_amount: null }, { authorization_amount: '0.00' }, { amount: 0 },
        { authorization_amount: '-15.54' }, { amount: '15.54' }, { authorization_amount: 'unavailable' },
        { amount: { value: '15.54', currency: 'USD' } }, { authorization_amount: 0, amount: '-15.54' }];
    const rows = amounts.map((fields, i) => authorization(i, fields));
    assert.deepEqual(await readAuthorizations(apiFor(rows), cfg, 42), amounts.map((_, i) => String(i)));
});

test('pagination failures never return a partial successful authorization count', async () => {
    const first = Array.from({ length: 100 }, (_, i) => authorization(i));
    for (const second of [
        { success: false, error: 'private-provider-error' },
        { success: true, data: { list: [] , total: 101 } },
        { success: true, data: { list: [authorization(100)], total: 102 } },
        { success: true, data: { list: [authorization(100)] } },
        { success: true, data: { list: [authorization(100)], total: 101, page: 1 } },
        { success: true, data: { list: [authorization(100)], total: 101, page_size: 20 } }
    ]) {
        const api = { request: async (_, __, body) => body.page === 1
            ? { success: true, data: { list: first, total: 101 } } : second };
        await assert.rejects(readAuthorizations(api, cfg, 42), CardPreparationError);
    }
    for (const data of [{ list: [], total: false }, { list: [authorization(1)], total: 0 }, { list: first.concat(authorization(101)), total: 101 },
        { list: [], total: -1 }, { list: [], total: 'bad' }, { list: {} }])
        await assert.rejects(readAuthorizations({ request: async () => ({ success: true, data }) }, cfg, 42), CardPreparationError);
});

test('supports pagination without totals while requiring total presence to stay consistent', async () => {
    const rows = Array.from({ length: 102 }, (_, i) => authorization(i));
    const api = { request: async (_, __, body) => ({ success: true, data: { list: rows.slice((body.page - 1) * 100, body.page * 100) } }) };
    assert.equal((await readAuthorizations(api, cfg, 42)).length, 102);
    await assert.rejects(readAuthorizations({ request: async (_, __, body) => ({ success: true, data: {
        list: rows.slice((body.page - 1) * 100, body.page * 100), ...(body.page === 2 ? { total: 102 } : {}) } }) }, cfg, 42), /分页总数/);
    assert.deepEqual(await readAuthorizations(apiFor([]), cfg, 42), []);
    for (const cardId of [0, -1, NaN, 'bad', Number.MAX_SAFE_INTEGER + 1])
        await assert.rejects(readAuthorizations(apiFor([]), cfg, cardId), CardPreparationError);
});

test('failed transaction reads identify the card and failing page without exposing provider errors', async () => {
    const first = Array.from({length:100}, (_, i) => authorization(i));
    for (const [status, hint] of [[401,/签名凭据/],[403,/transactions:read/],[404,/未找到/],[429,/请求受限/],[500,/平台连接/]]) {
        await assert.rejects(readAuthorizations({request:async(_,__,body) => body.page === 1
            ? {success:true,data:{list:first,total:101}}
            : {success:false,status,code:11000,error:'private-provider-error',data:{secret:'private-value'}}}, cfg, 42), error => {
            assert.ok(error instanceof CardPreparationError);
            assert.match(error.message,/卡片 42，交易第 2 页/);
            assert.ok(error.message.includes(`HTTP ${status}`)); assert.match(error.message,/平台 code 11000/);
            assert.match(error.message,hint); assert.ok(!error.message.includes('private'));
            return true;
        });
    }
    await assert.rejects(readAuthorizations({request:async()=>{throw Error('private-network-error');}},cfg,42), error => {
        assert.match(error.message,/卡片 42，交易第 1 页.*未收到 HTTP 响应/);
        assert.ok(!error.message.includes('private'));return true;
    });
});

test('unknown statuses remain uncounted but identify the affected card and page', async () => {
    await assert.rejects(readAuthorizations(apiFor([authorization('unknown',{status:'private-unmapped-status'})]),cfg,42), error => {
        assert.match(error.message,/卡片 42，交易第 1 页.*未知消费授权状态/);
        assert.ok(!error.message.includes('private'));return true;
    });
});

test('an unbounded transaction feed stops at the page limit instead of returning a partial count', async () => {
    let calls = 0;
    const api = { request: async (_, __, body) => {
        calls++;
        return { success: true, data: { list: [authorization(body.page)], total: 10001 } };
    } };
    await assert.rejects(readAuthorizations(api, cfg, 42), /分页超限/);
    assert.equal(calls, 10000);
});
