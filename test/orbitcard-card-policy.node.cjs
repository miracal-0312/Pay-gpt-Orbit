'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planFor, cardScope, capacity, settlementState } = require('../orbitcard-card-policy');

test('each Pro denomination has its own quota and historical names map to the right plan', () => {
    for (const plan of ['pro100', 'pro200', 'pro500', 'pro_5x', 'pro_20x', 'gpt-pro-5x', 'gpt-pro-20x', 'gpt-pro-25x']) {
        assert.ok(['pro100','pro200','pro500'].includes(planFor(plan)));
        assert.equal(capacity(plan, []).limit, 1);
    }
    assert.equal(planFor('pro_5x'),'pro100'); assert.equal(planFor('pro_20x'),'pro200');
    assert.throws(() => planFor('arbitrary-plan'));
});

test('Plus permits four successful or unresolved orders in total', () => {
    const rows = Array.from({ length: 3 }, () => ({ plan_type: 'plus', state: 'consumed' }));
    assert.equal(capacity('plus', rows).remaining, 1);
    rows.push({ plan_type: 'plus', state: 'reserved' });
    assert.equal(capacity('plus', rows).eligible, false);
    rows[3].state = 'consumed';
    assert.equal(capacity('plus', rows).used, 4);
    assert.equal(capacity('plus', rows).eligible, false);
});

test('an unresolved Pro 100 order uses only its own quota', () => {
    const rows = [{ plan_type: 'pro100', state: 'reserved' }];
    assert.equal(capacity('pro100',rows).eligible,false);
    for (const plan of ['plus','pro200','pro500']) assert.equal(capacity(plan,rows).eligible,true);
});

test('confirmed failure releases the occupied slot; uncertain outcomes keep it', () => {
    let state = 'reserved';
    for (const outcome of ['prepared', 'submitting', 'pending', 'manual']) {
        state = settlementState(state, outcome);
        assert.equal(capacity('pro100', [{ plan_type: 'pro100', state }]).eligible, false);
    }
    state = settlementState(state, 'failed');
    assert.equal(capacity('pro100', [{ plan_type: 'pro100', state }]).remaining, 1);
});

test('repeated success and stale failure never restore a consumed slot', () => {
    let state = settlementState('reserved', 'success');
    for (const outcome of ['success', 'failed', 'rejected', 'manual']) {
        state = settlementState(state, outcome);
        assert.equal(state, 'consumed');
    }
});

test('one card can hold four Plus uses and one of every Pro plan', () => {
    const rows=[...Array.from({length:4},() => ({plan_type:'plus',state:'consumed'})),
        ...['pro100','pro200','pro500'].map(plan_type => ({plan_type,state:'consumed'}))];
    for(const plan of ['plus','pro100','pro200','pro500']) assert.equal(capacity(plan,rows).eligible,false);
    rows.pop(); assert.equal(capacity('pro500',rows).remaining,1); assert.equal(capacity('pro200',rows).remaining,0);
});

test('corrupt ledger states fail closed and separate platform identities stay separate', () => {
    assert.equal(capacity('plus', [{ plan_type: 'plus', state: 'unexpected' }]).reason, 'unknown_history');
    assert.equal(cardScope('https://orbitcard.test/'), cardScope('https://orbitcard.test'));
    assert.notEqual(cardScope('https://other.orbitcard.test'), cardScope('https://orbitcard.test'));
    assert.throws(() => cardScope('https://orbitcard.test/api'));
});
