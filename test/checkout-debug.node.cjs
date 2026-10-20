const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { CHECKOUT_SUBMIT_NAME, waitForCheckoutSubmit } = require('../checkout-submit');

test('recognizes final checkout names and excludes wallet buttons', async () => {
    for (const name of ['Upgrade to Pro', 'Upgrade to Plus', 'Subscribe', 'Pay now']) assert.match(name, CHECKOUT_SUBMIT_NAME);
    for (const name of ['Apple Pay', 'Google Pay', 'Get Pro']) assert.doesNotMatch(name, CHECKOUT_SUBMIT_NAME);
    await waitForCheckoutSubmit({ getByRole: () => ({ count: async () => 1, isVisible: async () => true, isEnabled: async () => true }) });
});

function loadModule(file, dependencies, extra = {}) {
    const sandbox = { module: { exports: {} }, console, process: { env: {}, pid: 1 }, require: (name) => dependencies[name] || {}, ...extra };
    vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), sandbox);
    return sandbox;
}

test('debug wrapper always releases card and never writes payment records', async () => {
    for (const fails of [false, true]) {
        let released = 0;
        const store = {
            getAppConfigValue: async () => null,
            reserveCard: async () => ({ id: 1, card_number: '1234' }),
            releaseCard: async (id) => { assert.equal(id, 1); released++; }
        };
        const sandbox = loadModule('../payment-retry', {
            './mysql-store': store,
            './tax-free-address': { pickBillingAddressForCheckout: async () => ({ country: 'US' }) },
            './stripe-payment': { completeStripeCardPayment: async (page, card, address, options) => {
                assert.equal(address.country, 'US');
                assert.equal(options.stopBeforeSubmit, true);
                assert.equal(options.billingEmail, 'current@example.com');
                if (fails) throw new Error('fill failed');
                return { debugReady: true, submitted: false };
            } }
        });
        const run = sandbox.module.exports.debugCheckoutCardAndAddress({}, { billingEmail: 'current@example.com' });
        if (fails) await assert.rejects(run, /fill failed/);
        else assert.equal((await run).submitted, false);
        assert.equal(released, 1);
    }
});

test('filled debug flow cannot reach payment finalization, including environment guard', async () => {
    for (const viaEnv of [false, true]) {
        const sandbox = loadModule('../stripe-payment', {
            './checkout-submit': { waitForCheckoutSubmit: async () => {} },
            './billing-email': { fillOptionalBillingEmail: async () => ({ skipped: true }) }
        }, { Buffer });
        sandbox.process.env.CHECKOUT_DEBUG_ONLY = viaEnv ? '1' : '';
        vm.runInNewContext(`
            dismissCheckoutPaymentError = async () => {};
            prepareCheckoutCardSection = async () => {};
            fillCardFieldsOpenAiCheckout = async () => ({ ok: true });
            captureCheckoutDueAmount = async () => null;
            saveDebugScreenshot = async () => 'debug.png';
            finalizeCheckoutPayment = async () => { throw new Error('MUST NOT SUBMIT'); };
        `, sandbox);
        const result = await sandbox.module.exports.completeStripeCardPayment({ waitForTimeout: async () => {} }, {}, {}, {
            cardAttempt: 2, stopBeforeSubmit: !viaEnv
        });
        assert.equal(result.debugReady, true);
        assert.equal(result.submitted, false);
    }
});
