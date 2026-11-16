'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkProject, checkLocalReference, relativeRequires } = require('../scripts/check-project.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-project-check-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function write(name, content) {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
        return filename;
    }
    write('server.js', "require('./src/server');\n");
    write('src/server.js', "throw new Error('Structure checks must not execute the application');\n");
    write('README.md', '[Guide](docs/Guide.md)\n');
    write('docs/Guide.md', '[Schema](../database/mysql-schema.sql)\n');
    write('database/mysql-schema.sql', 'SELECT 1;\n');
    write('docker-compose.yml', 'services:\n  mysql:\n    volumes:\n      - ./database/mysql-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro\n');
    return { root, write };
}

test('structure checks validate syntax and links without executing source or reading ignored directories', t => {
    const f = fixture(t);
    for (const directory of ['node_modules', 'data', 'scratch']) f.write(`${directory}/broken.js`, 'invalid !!!');
    f.write('docs/api/provider.md', '[External snapshot relative reference](missing-original.md)');
    assert.deepEqual(checkProject(f.root).errors, []);
});

test('Linux-incompatible case and missing local imports are reported on every host', t => {
    const f = fixture(t), caller = f.write('src/caller.js', '');
    f.write('src/Policy.js', 'module.exports = {};');
    assert.equal(checkLocalReference(f.root, caller, './Policy').error, null);
    assert.equal(checkLocalReference(f.root, caller, './policy').error, 'path case mismatch');
    assert.equal(checkLocalReference(f.root, caller, './absent').error, 'missing local module');
    f.write('src/caller.js', "require('./policy');\nrequire.resolve('./absent');\n");
    const errors = checkProject(f.root, { syntax: false }).errors.join('\n');
    assert.match(errors, /caller\.js:1: .*case mismatch/);
    assert.match(errors, /caller\.js:2: .*missing local module/);
});

test('mock keys and virtual fixture text are not interpreted as real imports', () => {
    const source = [
        "// require('./comment')",
        "const mock = {'./mock': {}, code: \"require('./fixture')\"};",
        "const pattern = /require\\('fake'\\)/;",
        "const embedded = `require('./temporary-module')`;",
        "require('./actual'); require.resolve('../real.json');",
        "object.require('./method'); require(variable); require('./prefix' + variable);"
    ].join('\n');
    assert.deepEqual(relativeRequires(source).map(item => item.specifier), ['./actual', '../real.json']);
});

test('broken deployment paths, documentation case, bootstrap and syntax fail together', t => {
    const f = fixture(t);
    f.write('server.js', "require('./src/other');");
    f.write('src/other.js', 'module.exports = {};');
    f.write('src/broken.js', 'const = ;');
    f.write('README.md', '[Guide](docs/guide.md)\n[Missing](docs/missing.md)');
    f.write('docker-compose.yml', 'volumes:\n  - ./mysql-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro\n');
    const errors = checkProject(f.root).errors.join('\n');
    assert.match(errors, /src\/broken\.js: syntax check failed/);
    assert.match(errors, /compatibility entry/);
    assert.match(errors, /docs\/guide\.md: path case mismatch/);
    assert.match(errors, /docs\/missing\.md: missing path/);
    assert.match(errors, /expected read-only/);
});
