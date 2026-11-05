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
