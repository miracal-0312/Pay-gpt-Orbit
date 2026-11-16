'use strict';

// Local checks only: never import application modules or read runtime configuration.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function inside(root, filename) {
    const relative = path.relative(root, filename);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkExactPath(root, filename) {
    const absolute = path.resolve(filename);
    if (!inside(root, absolute)) return { error: 'path escapes project' };
    let current = path.resolve(root), mismatch = false;
    for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
        if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return { error: 'missing path' };
        const entries = fs.readdirSync(current);
        const actual = entries.includes(segment) ? segment : entries.find(name => name.toLowerCase() === segment.toLowerCase());
        if (!actual) return { error: 'missing path' };
        mismatch ||= actual !== segment;
        current = path.join(current, actual);
    }
    return { path: current, error: mismatch ? 'path case mismatch' : null };
}

function checkLocalReference(root, filename, specifier) {
    const target = path.resolve(path.dirname(filename), specifier);
    if (!inside(root, target)) return { error: 'path escapes project' };
    const candidates = [target, ...['.js', '.json', '.node'].map(extension => target + extension)];
    // This project imports files or index modules; package-directory imports are
    // also resolved without loading their code.
    const directory = checkExactPath(root, target);
    if (directory.path && fs.statSync(directory.path).isDirectory()) {
        const manifest = path.join(directory.path, 'package.json');
        if (fs.existsSync(manifest)) {
            try {
                const main = JSON.parse(fs.readFileSync(manifest, 'utf8')).main;
                if (typeof main === 'string') {
                    const entry = path.resolve(target, main);
                    candidates.push(entry, ...['.js', '.json', '.node'].map(extension => entry + extension), path.join(entry, 'index.js'));
                }
            } catch (_) { return { error: 'invalid local package.json' }; }
        }
        candidates.push(...['index.js', 'index.json', 'index.node'].map(name => path.join(target, name)));
    }
    let mismatch;
    for (const candidate of candidates) {
        const result = checkExactPath(root, candidate);
        if (!result.path || !fs.statSync(result.path).isFile()) continue;
        if (!result.error) return result;
        mismatch ||= result;
    }
    return mismatch || { error: 'missing local module' };
}

// A small lexical scanner, not a JavaScript parser. Comments, regexes and whole
// template literals are skipped, including test fixtures that contain JS text.
// Only bare require('literal') and require.resolve('literal') are checked.
function relativeRequires(source) {
    const tokens = [];
    let index = 0, line = 1;
    function advance() { if (source[index] === '\n') line++; return source[index++]; }
    function quoted(quote) {
        advance(); let value = '';
        while (index < source.length) {
            const char = advance();
            if (char === quote) break;
            if (char !== '\\') { value += char; continue; }
            const escaped = advance();
            if ((escaped === 'x' || escaped === 'u') && /^[0-9a-f]+$/i.test(source.slice(index, index + (escaped === 'x' ? 2 : 4)))) {
                const count = escaped === 'x' ? 2 : 4;
                value += String.fromCharCode(parseInt(source.slice(index, index + count), 16)); index += count;
            } else value += ({ n: '\n', r: '\r', t: '\t', '\n': '' })[escaped] ?? escaped;
        }
        return value;
    }
    while (index < source.length) {
        const char = source[index], next = source[index + 1];
        if (/\s/.test(char)) { advance(); continue; }
        if (char === '/' && next === '/') { while (index < source.length && advance() !== '\n') {} continue; }
        if (char === '/' && next === '*') {
            advance(); advance();
            while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) advance();
            advance(); advance(); continue;
        }
        if (char === '"' || char === "'") { const start = line; tokens.push({ type: 'string', value: quoted(char), line: start }); continue; }
        if (char === '`') { quoted('`'); tokens.push({ value: '<template>' }); continue; }
        const previous = tokens.at(-1)?.value;
        if (char === '/' && (!previous || /^(?:[=(:,!&|?;{\[]|return|throw|case|=>)$/.test(previous))) {
            advance(); let characterClass = false;
            while (index < source.length) {
                const part = advance();
                if (part === '\\') { advance(); continue; }
                if (part === '[') characterClass = true;
                if (part === ']') characterClass = false;
                if (part === '/' && !characterClass) break;
            }
            while (/[a-z]/i.test(source[index] || '') && index < source.length) advance();
            tokens.push({ value: '<regex>' }); continue;
        }
        if (/[A-Za-z_$]/.test(char)) {
            const start = index, startLine = line;
            while (index < source.length && /[\w$]/.test(source[index])) advance();
            tokens.push({ value: source.slice(start, index), line: startLine }); continue;
        }
        tokens.push({ value: advance(), line });
    }
    const found = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].value !== 'require' || tokens[i - 1]?.value === '.') continue;
        let cursor = i + 1;
        if (tokens[cursor]?.value === '.' && tokens[cursor + 1]?.value === 'resolve') cursor += 2;
        const literal = tokens[cursor + 1];
        if (tokens[cursor]?.value === '(' && literal?.type === 'string' && tokens[cursor + 2]?.value === ')'
            && /^\.\.?\//.test(literal.value)) found.push({ specifier: literal.value, line: tokens[i].line });
    }
    return found;
}

function markdownTargets(source) {
    const prose = source.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, '');
    const targets = [];
    for (const match of prose.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)|^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)) {
        const raw = (match[1] || match[2]).replace(/^<|>$/g, '');
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
        const target = raw.split(/[?#]/, 1)[0];
        if (target) {
            try { targets.push(decodeURIComponent(target)); } catch (_) { targets.push(target); }
        }
    }
    return targets;
}

function filesBelow(root, directory, accept) {
    const start = path.join(root, directory), result = [];
    if (!fs.existsSync(start)) return result;
    for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...filesBelow(root, relative, accept));
        else if (entry.isFile() && accept(relative)) result.push(path.join(root, relative));
    }
    return result;
}

function checkProject(root = path.resolve(__dirname, '..'), { syntax = true } = {}) {
    root = path.resolve(root);
    const errors = [], label = filename => path.relative(root, filename).split(path.sep).join('/');
    const entry = path.join(root, 'server.js');
    const files = [entry, ...['src', 'scripts', 'test', 'public'].flatMap(directory => filesBelow(root, directory, name => /\.(?:c?js|mjs)$/.test(name)))];
    let imports = 0, links = 0;
    for (const filename of files) {
        if (!fs.existsSync(filename)) { errors.push(`${label(filename)}: missing file`); continue; }
        const source = fs.readFileSync(filename, 'utf8');
        if (syntax) {
            const checked = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', timeout: 10000, windowsHide: true,
                env: { ...process.env, NODE_OPTIONS: '' } });
            if (checked.status !== 0) errors.push(`${label(filename)}: syntax check failed\n${(checked.error?.message || checked.stderr || '').trim().slice(0, 1000)}`);
        }
        for (const reference of relativeRequires(source)) {
            imports++;
            const result = checkLocalReference(root, filename, reference.specifier);
            if (result.error) errors.push(`${label(filename)}:${reference.line}: ${reference.specifier}: ${result.error}`);
        }
    }
    if (fs.existsSync(entry) && !relativeRequires(fs.readFileSync(entry, 'utf8')).some(reference =>
        ['src/server', 'src/server.js'].includes(path.relative(root, path.resolve(path.dirname(entry), reference.specifier)).split(path.sep).join('/')))) {
        errors.push('server.js: compatibility entry must require ./src/server');
    }
    const docs = [path.join(root, 'README.md'), ...filesBelow(root, 'docs', name => name.endsWith('.md') && !name.startsWith(`docs${path.sep}api${path.sep}`))];
    for (const filename of docs) {
        if (!fs.existsSync(filename)) { errors.push(`${label(filename)}: missing file`); continue; }
        for (const target of markdownTargets(fs.readFileSync(filename, 'utf8'))) {
            links++;
            const destination = target.startsWith('/') ? path.resolve(root, '.' + target) : path.resolve(path.dirname(filename), target);
            const result = checkExactPath(root, destination);
            if (result.error) errors.push(`${label(filename)}: ${target}: ${result.error}`);
        }
    }
    const compose = path.join(root, 'docker-compose.yml');
    if (!fs.existsSync(compose)) errors.push('docker-compose.yml: missing file');
    else {
        const match = fs.readFileSync(compose, 'utf8').match(/^\s*-\s*["']?(\.\/[^:\r\n"']+):\/docker-entrypoint-initdb\.d\/01-schema\.sql:ro["']?\s*$/m);
        if (!match || match[1] !== './database/mysql-schema.sql') errors.push('docker-compose.yml: expected read-only ./database/mysql-schema.sql initialization mount');
        else {
            const checked = checkExactPath(root, path.resolve(root, match[1]));
            if (checked.error || !fs.statSync(checked.path).isFile()) errors.push(`docker-compose.yml: schema ${checked.error || 'is not a file'}`);
        }
    }
    return { errors, files: files.length, imports, links };
}

module.exports = { checkProject, checkExactPath, checkLocalReference, relativeRequires, markdownTargets };

if (require.main === module) {
    const result = checkProject();
    if (result.errors.length) {
        process.stderr.write(result.errors.join('\n') + '\n');
        process.exitCode = 1;
    } else process.stdout.write(`Project checks passed: ${result.files} JavaScript files, ${result.imports} local imports, ${result.links} documentation links.\n`);
}
