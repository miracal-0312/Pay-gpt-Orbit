const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const registry = require('../plan-registry');

test('maps all four plans and preserves legacy reads without accepting legacy writes', () => {
    assert.deepEqual(registry.PLAN_NAME_MAP, {
        plus: 'chatgptplusplan', pro100: 'chatgptprolite', pro200: 'chatgptpro', pro500: 'chatgptpromax'
    });
    assert.equal(registry.resolvePlanName(' PRO500 '), 'chatgptpromax');
    assert.equal(registry.resolvePlanName('pro_5x'), 'chatgptprolite');
    assert.equal(registry.resolvePlanName('pro_20x'), 'chatgptpro');
    assert.throws(() => registry.normalizePlanType('pro_5x', { allowLegacy: false }));
    for (const value of ['unknown', '', '__proto__']) assert.throws(() => registry.resolvePlanName(value));
});

test('selects each actual Pro checkout value and rejects unconfirmed selections', async () => {
    const sandbox = { module: { exports: {} }, console, require: (name) => name === './checkout-pro-option' ? require('../checkout-pro-option') : {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../pricing-checkout'), 'utf8'), sandbox);
    const pricing = sandbox.module.exports;
    for (const type of ['pro100', 'pro200', 'pro500']) {
        const value = registry.resolvePlanName(type);
        let clicked = false;
        const option = {
            waitFor: async () => {}, count: async () => 1, isVisible: async () => true,
            click: async () => { clicked = true; },
            getAttribute: async (name) => ({ role: 'radio', value, 'aria-checked': clicked ? 'true' : 'false', 'data-state': clicked ? 'checked' : 'unchecked' })[name]
        };
        const page = { locator: (selector) => { assert.equal(selector, `#${value}`); return option; }, waitForTimeout: async () => {} };
        await pricing.selectProVariantOnCheckoutPage(page, type);
        assert.equal(clicked, true);
        option.getAttribute = async (name) => ({ role: 'radio', value, 'aria-checked': 'false', 'data-state': 'unchecked' })[name];
        await assert.rejects(pricing.selectProVariantOnCheckoutPage(page, type));
    }
});

test('frontend pages contain four choices and valid inline JavaScript', () => {
    for (const file of ['../public/admin.html', '../public/index.html']) {
        const html = fs.readFileSync(require.resolve(file), 'utf8');
        for (const type of Object.keys(registry.PLAN_NAME_MAP)) assert.ok(html.includes(type));
        for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
            if (/\bsrc\s*=/.test(match[1]) || /application\/(?:json|ld\+json)/.test(match[1])) continue;
            new vm.Script(match[2]);
        }
    }
});
