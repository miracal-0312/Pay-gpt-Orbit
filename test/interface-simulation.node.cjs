'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const contract = require('../orbitcard-api-contract');
const { simulate } = require('../orbitcard-interface-simulation');

test('every supported write operation is checked locally and clearly does not claim remote success', () => {
    for (const [operation, spec] of Object.entries(contract.OPERATIONS)) {
        if (!spec.write) { assert.throws(() => simulate(operation)); continue; }
        const result = simulate(operation);
        assert.equal(result.passed, true, operation);
        assert.equal(result.summary.sent_to_platform, false);
        assert.equal(result.summary.validation, 'request_contract');
        assert.ok(result.checks.length >= 4);
        assert.equal(result.checks.every(check => check.status === 'passed'), true);
        assert.match(result.message, /未验证远端权限/);
        assert.doesNotMatch(JSON.stringify(result), /local-synthetic-token|session_json|diagnostic@example|LOCAL_FIXTURE/);
    }
    for (const invalid of ['freezeCard','refundCard','../createCard','toString',null,{}]) {
        assert.throws(() => simulate(invalid));
    }
});

test('simulation cannot reach a transport and detects a broken write-validation contract', () => {
    const module = { exports: {} }, imports = [];
    const context = vm.createContext({ module, exports: module.exports,
        require(name) {
            imports.push(name);
            assert.equal(name, './orbitcard-api-contract', 'no transport or financial dependency may be loaded');
            return { OPERATIONS: contract.OPERATIONS, validateRequest() {} };
        }
    });
    vm.runInContext(fs.readFileSync(require.resolve('../orbitcard-interface-simulation'), 'utf8'), context);
    const result = module.exports.simulate('createCard');
    assert.equal(result.passed, false);
    assert.equal(result.summary.sent_to_platform, false);
    assert.ok(result.checks.some(check => check.status === 'failed'));
    assert.deepEqual(imports, ['./orbitcard-api-contract']);
});
