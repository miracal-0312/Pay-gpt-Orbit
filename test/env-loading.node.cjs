'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-orbit-env-test-'));
    const files = [];
    function write(name, content) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content);
        files.push(file);
        return file;
    }
    const loader = write('load-env.js', fs.readFileSync(path.join(__dirname, '..', 'load-env.js')));
    t.after(() => {
        for (const file of files) fs.unlinkSync(file);
        fs.rmdirSync(dir);
    });
    function run(code, overrides = {}) {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
            if (/^(ORBITCARD_API_SECRET|DB_PASSWORD|DB_NAME|NODE_OPTIONS|PAY_ORBIT_TEST_LOADER)$/i.test(key)) delete env[key];
        }
        const result = spawnSync(process.execPath, ['-e', code], {
            cwd: os.tmpdir(),
            env: { ...env, PAY_ORBIT_TEST_LOADER: loader, ...overrides },
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    }
    return { dir, write, run };
}

test('loads project .env from another cwd, including quoted #, $ and spaces', (t) => {
    const f = fixture(t);
    f.write('.env', "ORBITCARD_API_SECRET='fixture#value$with spaces'\nDB_NAME=orbit_fixture\n");
    const output = f.run(`
        const assert = require('node:assert/strict');
        assert.equal(require(process.env.PAY_ORBIT_TEST_LOADER)(), true);
        assert.equal(process.env.ORBITCARD_API_SECRET, 'fixture#value$with spaces');
        assert.equal(process.env.DB_NAME, 'orbit_fixture');
        console.log('loaded');
    `);
    assert.equal(output, 'loaded');
});

test('Docker or process environment takes precedence, including an explicit empty value', (t) => {
    const f = fixture(t);
    f.write('.env', 'ORBITCARD_API_SECRET=from-file\nDB_PASSWORD=from-file\n');
    const output = f.run(`
        const assert = require('node:assert/strict');
        require(process.env.PAY_ORBIT_TEST_LOADER)();
        assert.equal(process.env.ORBITCARD_API_SECRET, 'from-process');
        assert.equal(process.env.DB_PASSWORD, '');
        console.log('preserved');
    `, { ORBITCARD_API_SECRET: 'from-process', DB_PASSWORD: '' });
    assert.equal(output, 'preserved');
});

test('missing .env allows deployment with environment variables only', (t) => {
    const f = fixture(t);
    const output = f.run(`
        const assert = require('node:assert/strict');
        assert.equal(require(process.env.PAY_ORBIT_TEST_LOADER)(), false);
        assert.equal(process.env.ORBITCARD_API_SECRET, 'injected');
        console.log('environment-only');
    `, { ORBITCARD_API_SECRET: 'injected' });
    assert.equal(output, 'environment-only');
});

test('unexpected load failures stop startup without disclosing file contents or secrets', (t) => {
    const f = fixture(t);
    const output = f.run(`
        const assert = require('node:assert/strict');
        process.loadEnvFile = () => { throw Object.assign(new Error('secret-must-not-appear'), { code: 'EACCES' }); };
        assert.throws(() => require(process.env.PAY_ORBIT_TEST_LOADER)(), error => {
            assert.equal(error.message, 'Cannot load environment file (EACCES).');
            return true;
        });
        console.log('safe-error');
    `);
    assert.equal(output, 'safe-error');
});

test('server loads .env before importing its application dependencies', (t) => {
    const f = fixture(t);
    f.write('.env', 'ORBITCARD_API_SECRET=bootstrap-fixture\nDB_NAME=orbit_bootstrap\n');
    f.write('server.js', fs.readFileSync(path.join(__dirname, '..', 'server.js')));
    const output = f.run(`
        const assert = require('node:assert/strict');
        const Module = require('node:module');
        const path = require('node:path');
        const original = Module._load;
        Module._load = function (name, parent, isMain) {
            if (name === 'express') {
                assert.equal(process.env.ORBITCARD_API_SECRET, 'bootstrap-fixture');
                assert.equal(process.env.DB_NAME, 'orbit_bootstrap');
                console.log('loaded-before-dependencies');
                process.exit(0);
            }
            return original.apply(this, arguments);
        };
        require(path.join(path.dirname(process.env.PAY_ORBIT_TEST_LOADER), 'server.js'));
    `);
    assert.equal(output, 'loaded-before-dependencies');
});
