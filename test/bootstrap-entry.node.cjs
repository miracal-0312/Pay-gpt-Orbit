'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the established server.js command starts the implementation, while importing it does not', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-bootstrap-'));
    fs.mkdirSync(path.join(directory, 'src'));
    const entry = path.join(directory, 'server.js');
    fs.copyFileSync(require.resolve('../server.js'), entry);
    fs.writeFileSync(path.join(directory, 'src', 'server.js'),
        "module.exports = { marker: 'same exports', run() { console.log('started once'); } };\n");
    t.after(() => {
        fs.unlinkSync(entry);
        fs.unlinkSync(path.join(directory, 'src', 'server.js'));
        fs.rmdirSync(path.join(directory, 'src'));
        fs.rmdirSync(directory);
    });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const started = spawnSync(process.execPath, [entry], { cwd: os.tmpdir(), env, encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout.trim(), 'started once');
    const imported = spawnSync(process.execPath, ['-e',
        "const assert = require('node:assert/strict'); const server = require(process.argv[1]); assert.equal(server.marker, 'same exports');",
        entry], { cwd: os.tmpdir(), env, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
});
