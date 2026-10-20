const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PRO_OPTION_LABELS, resolveProCheckoutOption, isProOptionSelected } = require('../checkout-pro-option');
const empty = { count: async () => 0 };
const option = (attributes = {}) => ({ count: async () => 1, isVisible: async () => true,
    getAttribute: async (key) => attributes[key] ?? null, evaluate: async () => false });

test('supports English and Chinese tier labels and keeps tiers distinct', async () => {
    for (const [value, names] of Object.entries({ chatgptprolite: ['Standard', '标准'], chatgptpro: ['More usage', '更高使用额度'], chatgptpromax: ['Max usage', '最高使用额度'] })) {
        for (const name of names) {
            assert.match(name, PRO_OPTION_LABELS[value]);
            for (const [other, pattern] of Object.entries(PRO_OPTION_LABELS)) if (other !== value) assert.doesNotMatch(name, pattern);
            const target = option();
            const page = { locator: () => ({ ...empty, filter: () => empty }), getByRole: (role, { name: pattern }) => role === 'radio' && pattern.test(name) ? target : empty };
            // The returned option is the semantic radio containing that tier label.
            assert.equal((await resolveProCheckoutOption(page, value)).option, target);
        }
    }
});
test('retains exact id lookup and rejects missing or ambiguous options', async () => {
    const exact = option();
    assert.equal((await resolveProCheckoutOption({ locator: () => exact }, 'chatgptprolite')).byId, true);
    await assert.rejects(resolveProCheckoutOption({}, 'chatgptprolite', 0), /加载超时/);
    const duplicate = { count: async () => 2, nth: () => exact };
    await assert.rejects(resolveProCheckoutOption({ locator: () => duplicate }, 'chatgptprolite'), /多个可见/);
});
test('requires semantic selected state rather than a border or label', async () => {
    assert.equal(await isProOptionSelected(option({ 'aria-checked': 'true' })), true);
    assert.equal(await isProOptionSelected(option({ 'aria-pressed': 'true' })), true);
    assert.equal(await isProOptionSelected(option({ 'data-state': 'checked' })), true);
    assert.equal(await isProOptionSelected(option({ 'aria-checked': 'false', 'data-state': 'checked' })), false);
    assert.equal(await isProOptionSelected(option()), false);
});
