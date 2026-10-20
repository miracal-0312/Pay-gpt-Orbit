'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const registry = require('../plan-registry');
test('four CDK plans remain distinct and old plan names are read-only aliases', () => {
    assert.deepEqual(registry.PLAN_TYPES, ['plus','pro100','pro200','pro500']);
    assert.equal(registry.normalizePlanType('pro_5x'), 'pro100');
    assert.equal(registry.normalizePlanType('pro_20x'), 'pro200');
    assert.throws(() => registry.normalizePlanType('pro_5x', { allowLegacy: false }));
    assert.throws(() => registry.normalizePlanType('pro'));
    assert.equal(registry.PLAN_NAME_MAP, undefined);
});
test('public/admin pages offer all four plans and their JavaScript compiles', () => {
    for (const page of ['index', 'admin']) {
        const html = fs.readFileSync(require.resolve(`../public/${page}.html`), 'utf8');
        for (const plan of registry.PLAN_TYPES) assert.ok(html.includes(plan));
    }
    for (const file of ['app.js', 'admin.js']) new vm.Script(fs.readFileSync(require.resolve(`../public/${file}`), 'utf8'));
    const login = fs.readFileSync(require.resolve('../public/admin-login.html'), 'utf8');
    for (const match of login.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc=/.test(match[1])) new vm.Script(match[2]);
});
