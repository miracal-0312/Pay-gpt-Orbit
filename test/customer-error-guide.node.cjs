'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCustomerGuidance } = require('../src/payments/customer-error-guide');

test('Orbitcard failure codes map to brand-safe actionable customer guidance', () => {
    const sessionGuide = buildCustomerGuidance(
        { status: 'failed', orbitcard_state: 'rejected' },
        { failureCode: 'session_expired', failureMessage: 'Session invalid' }
    );
    assert.equal(sessionGuide.category, 'session');
    assert.equal(sessionGuide.can_self_fix, true);
    assert.ok(sessionGuide.steps.length >= 2);
    assert.doesNotMatch(JSON.stringify(sessionGuide), /orbitcard/i);

    const accountGuide = buildCustomerGuidance(
        { status: 'failed', orbitcard_state: 'support_locked' },
        { failureCode: 'already_subscribed', failureMessage: 'Account already has Plus' }
    );
    assert.equal(accountGuide.category, 'account');
    assert.equal(accountGuide.need_support, true);

    const cardGuide = buildCustomerGuidance(
        { status: 'failed', orbitcard_state: 'support_locked' },
        { failureCode: 'card_declined', failureMessage: 'Card declined' }
    );
    assert.equal(cardGuide.category, 'card');
    assert.equal(cardGuide.need_support, true);

    const captchaGuide = buildCustomerGuidance(
        { status: 'running', orbitcard_state: 'pending' },
        { stage: 'awaiting_captcha' }
    );
    assert.equal(captchaGuide.category, 'captcha');
    assert.equal(captchaGuide.can_self_fix, true);

    const capacityGuide = buildCustomerGuidance(
        { status: 'failed', orbitcard_state: 'rejected' },
        { platform_code: 59016, http_status: 429 }
    );
    assert.equal(capacityGuide.category, 'capacity');

    const successGuide = buildCustomerGuidance({ status: 'success', orbitcard_state: 'success' }, {});
    assert.equal(successGuide, null);
});
