const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load() {
    const sandbox = { module: { exports: {} }, console, process: { env: {} }, require: () => ({}) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../stripe-payment'), 'utf8'), sandbox);
    return sandbox.module.exports.waitForBillingFields;
}
const empty = { count: async () => 0 };
function context({ country = false, street = false, editable = true }) {
    return { locator: (selector) => {
        if (selector === 'select[name="country"]' && country) return { count: async () => 1 };
        if (selector === 'input[name="addressLine1"]' && street) return { count: async () => 1,
            nth: () => ({ isVisible: async () => true, isEditable: async () => editable }) };
        return empty;
    } };
}
test('polls until real editable billing controls appear in an iframe', async () => {
    let polls = 0;
    const page = { frames: () => [context({ country: true }), context({ country: true, street: polls >= 2 })],
        waitForTimeout: async () => { polls++; } };
    assert.equal(await load()(page, 1000), true);
    assert.equal(polls, 2);
});
test('does not combine country and street from unrelated frames or accept read-only inputs', async () => {
    for (const frames of [[context({ country: true }), context({ street: true })], [context({ country: true, street: true, editable: false })]]) {
        const wait = load();
        // An immediate deadline must fail closed, rather than authorize filling.
        assert.equal(await wait({ frames: () => frames }, 0), false);
        const page = { frames: () => frames, waitForTimeout: async () => { throw new Error('still waiting'); } };
        await assert.rejects(wait(page, 1000), /still waiting/);
    }
});
