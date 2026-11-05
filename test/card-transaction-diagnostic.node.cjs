'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnostic } = require('../scripts/inspect-card-transactions.cjs');

test('transaction diagnostics retain raw counting fields and exclude card credentials and personal data', () => {
    const record = { transaction_id: 'fixture-tx', card_id: 42, transaction_type: 'Authorization', status: 7,
        amount: '-15.54', currency: 'USD', card_number: 'synthetic-private-pan', cvv: 'private-cvv',
        merchant: 'private-merchant', email: 'private-email', session: { accessToken: 'private-token' } };
    const result = diagnostic({ success: true, status: 200, code: 0, data: { list: [record], total: 1 } }, 42, 1);
    assert.deepEqual(result.records, [{ transaction_id: 'fixture-tx', card_id: 42,
        transaction_type: 'Authorization', status: 7, amount: '-15.54', currency: 'USD' }]);
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(result.total, 1);
    assert.equal(diagnostic({ success: false, error: 'private-upstream-error' }, 42, 1).success, false);
    assert.ok(!JSON.stringify(diagnostic({ data: { list: [null] } }, 42, 1)).includes('private'));
});

test('transaction diagnostics distinguish missing or malformed lists from an empty page', () => {
    for (const data of [undefined, null, {}, { list: null }, { list: 'private-records' }, { list: {} }]) {
        const result = diagnostic({ success: true, data }, 42, 3);
        assert.equal(result.success, true);
        assert.equal(result.list_valid, false);
        assert.deepEqual(result.records, []);
        assert.deepEqual(result.record_structures, []);
        assert.equal(result.total, null);
        assert.deepEqual(result.pagination, { page: null, page_size: null });
        assert.ok(!JSON.stringify(result).includes('private'));
    }
    const empty = diagnostic({ success: true, data: { list: [], total: 0 } }, 42, 3);
    assert.equal(empty.list_valid, true);
    assert.equal(empty.total, 0);
    assert.equal(empty.page, 3);
});

test('transaction diagnostics validate totals and returned pagination without coercing missing data to zero', () => {
    for (const value of [undefined, null, '', ' ', false, true, [], {}, -1, '-1', 0.5, '0.5', '1e2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const result = diagnostic({ data: { list: [], total: value, page: value, page_size: value } }, 42, 3);
        assert.equal(result.total, null, `unexpected total for ${String(value)}`);
        assert.deepEqual(result.pagination, { page: null, page_size: null });
    }
    for (const value of [0, '0', 7, '7', Number.MAX_SAFE_INTEGER]) {
        const result = diagnostic({ data: { list: [], total: value, page: '2', page_size: 20 } }, 42, 3);
        assert.equal(result.total, Number(value));
        assert.equal(result.page, 3);
        assert.deepEqual(result.pagination, { page: 2, page_size: 20 });
    }
    const zeroPage = diagnostic({ data: { list: [], page: 0, page_size: '0' } }, 42, 3);
    assert.deepEqual(zeroPage.pagination, { page: null, page_size: null });
});

test('transaction diagnostics expose field structure without arbitrary record values', () => {
    const record = {
        transaction_id: 'fixture-tx', transaction_type: 'Authorization', status: 'SUCCESS',
        payment: { value: 'private-amount', currency: 'private-currency', meta: { token: 'private-token', deeper: { password: 'private-password' } } },
        card_number: 'private-pan', cvv: 'private-cvv', session: { accessToken: 'private-session' },
        merchant: ['private-merchant'], optional: null, enabled: true,
        'private@example.test': 'private-value', '1234567890123456': 'private-value',
        ['long'.repeat(20)]: 'private-value'
    };
    const result = diagnostic({ success: true, data: { list: [record, null], total: '2', extra: { secret: 'private-data' } } }, 42, 1);
    assert.deepEqual(result.data_structure, { list: 'array', total: 'string', extra: 'object' });
    assert.deepEqual(result.record_structures, [{
        transaction_id: 'string', transaction_type: 'string', status: 'string',
        payment: { value: 'string', currency: 'string', meta: { token: 'string', deeper: 'object' } },
        card_number: 'string', cvv: 'string', session: { accessToken: 'string' },
        merchant: 'array', optional: 'null', enabled: 'boolean'
    }, 'null']);
    assert.deepEqual(result.records, [{ transaction_id: 'fixture-tx', transaction_type: 'Authorization', status: 'SUCCESS' }, {}]);
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.ok(!JSON.stringify(result).includes('1234567890123456'));
});

test('transaction diagnostic structure and records remain bounded', () => {
    const record = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`field_${index}`, 'private-value']));
    const result = diagnostic({ data: { list: Array.from({ length: 30 }, () => record) } }, 42, 1);
    assert.equal(result.records.length, 20);
    assert.equal(result.record_structures.length, 20);
    assert.equal(Object.keys(result.record_structures[0]).length, 50);
    assert.ok(!JSON.stringify(result).includes('private'));
});

test('transaction diagnostics never print malformed HTTP status or platform code values', () => {
    for (const value of ['private-error', { secret: 'private-token' }, ['private-value'], true, false, null, undefined,
        '200', 200.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const result = diagnostic({ status: value, code: value, data: { list: [] } }, 42, 1);
        assert.equal(result.http_status, null);
        assert.equal(result.platform_code, null);
        assert.ok(!JSON.stringify(result).includes('private'));
    }
    for (const status of [-1, 0, 99, 600, 1000]) {
        assert.equal(diagnostic({ status }, 42, 1).http_status, null);
    }
    for (const status of [100, 200, 403, 599]) {
        assert.equal(diagnostic({ status }, 42, 1).http_status, status);
    }
    for (const code of [0, -1, 403, Number.MAX_SAFE_INTEGER]) {
        assert.equal(diagnostic({ code }, 42, 1).platform_code, code);
    }
});
