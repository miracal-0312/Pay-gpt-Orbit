'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planFor, cardScope, settlementState } = require('../orbitcard-card-policy');

test('historical and provider plan names map to the right plan', () => {
    for (const plan of ['pro100', 'pro200', 'pro500', 'pro_5x', 'pro_20x', 'gpt-pro-5x', 'gpt-pro-20x', 'gpt-pro-25x']) {
        assert.ok(['pro100','pro200','pro500'].includes(planFor(plan)));
    }
    assert.equal(planFor('pro_5x'),'pro100'); assert.equal(planFor('pro_20x'),'pro200');
    assert.throws(() => planFor('arbitrary-plan'));
});

test('confirmed failure releases the occupied slot; uncertain outcomes keep it', () => {
    let state = 'reserved';
    for (const outcome of ['prepared', 'submitting', 'pending', 'manual']) {
        state = settlementState(state, outcome);
        assert.equal(state, 'reserved');
    }
    state = settlementState(state, 'failed');
    assert.equal(state, 'released');
});

test('repeated success and stale failure never restore a consumed slot', () => {
    let state = settlementState('reserved', 'success');
    for (const outcome of ['success', 'failed', 'rejected', 'manual']) {
        state = settlementState(state, outcome);
        assert.equal(state, 'consumed');
    }
});

test('separate platform identities stay separate', () => {
    assert.equal(cardScope('https://orbitcard.test/'), cardScope('https://orbitcard.test'));
    assert.notEqual(cardScope('https://other.orbitcard.test'), cardScope('https://orbitcard.test'));
    assert.throws(() => cardScope('https://orbitcard.test/api'));
});
