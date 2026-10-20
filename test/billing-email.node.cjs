const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectBillingEmail, fillOptionalBillingEmail } = require('../billing-email');

function node({ name = 'email', marker = '', text = '', required = false } = {}) {
    return { id: name, type: 'email', required, labels: [], getAttribute: () => '',
        parentElement: { tagName: 'SECTION', id: marker, textContent: text, getAttribute: () => '', parentElement: null } };
}

test('accepts billing email and excludes generic and Link signup email', () => {
    assert.equal(inspectBillingEmail(node({ name: 'billingEmail' })).accepted, true);
    assert.equal(inspectBillingEmail(node({ text: 'Billing address Email' })).accepted, true);
    assert.equal(inspectBillingEmail(node()).accepted, false);
    assert.equal(inspectBillingEmail(node({ name: 'billingEmail', marker: 'link-authentication' })).accepted, false);
    assert.equal(inspectBillingEmail(node({ text: 'Billing address I agree to create an account and save my payment info to Link' })).accepted, false);
});

function pageFor(nodes, { invalid = false } = {}) {
    const values = nodes.map(() => '');
    let fills = 0;
    const frame = { url: () => 'https://chatgpt.com/checkout/example', locator: () => ({
        count: async () => nodes.length,
        nth: (i) => ({ isVisible: async () => true, evaluate: async (fn) => fn(nodes[i]),
            inputValue: async () => values[i], fill: async (value) => { fills++; values[i] = value; }, press: async () => {},
            getAttribute: async () => invalid ? 'true' : null })
    }) };
    return { page: { frames: () => [frame] }, values, fills: () => fills };
}
test('fills current login email only into billing field and leaves Link unchanged', async () => {
    const f = pageFor([node({ name: 'billingEmail' }), node({ marker: 'link-authentication' })]);
    await fillOptionalBillingEmail(f.page, 'current@example.com');
    assert.deepEqual(f.values, ['current@example.com', '']);
    assert.equal(f.fills(), 1);
});
test('skips absent and optional fields without a login email, rejects missing required email', async () => {
    assert.equal((await fillOptionalBillingEmail(pageFor([]).page, 'current@example.com')).skipped, true);
    assert.equal((await fillOptionalBillingEmail(pageFor([node({ name: 'billingEmail' })]).page)).skipped, true);
    await assert.rejects(fillOptionalBillingEmail(pageFor([node({ name: 'billingEmail', required: true })]).page), /当前登录邮箱/);
});
test('stops on ambiguity or validation failure', async () => {
    await assert.rejects(fillOptionalBillingEmail(pageFor([node({ name: 'billingEmail' }), node({ name: 'contactEmail' })]).page, 'current@example.com'), /多个账单邮箱/);
    await assert.rejects(fillOptionalBillingEmail(pageFor([node({ name: 'billingEmail' })], { invalid: true }).page, 'current@example.com'), /已停止/);
});
