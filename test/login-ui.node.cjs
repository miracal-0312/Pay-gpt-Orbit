'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    const html = fs.readFileSync(require.resolve('../public/admin-login.html'), 'utf8');
    const nodes = new Map(), tokens = new Map([['plus_admin_secondary_token', 'old-secondary']]), calls = [], timers = new Map();
    let reply = async () => ({ ok: true, json: async () => ({ success: true, token: 'login-token', panelUrl: '/custom-admin' }) });
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, style: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {} });
        return nodes.get(id);
    };
    const context = vm.createContext({ AbortController, document: { getElementById: node, querySelectorAll: () => [] },
        navigator: { userAgent: 'test', language: 'zh-CN' }, screen: { width: 1, height: 1 },
        btoa: value => Buffer.from(value).toString('base64'), unescape, encodeURIComponent,
        localStorage: { getItem: key => tokens.get(key), setItem: (key, value) => tokens.set(key, value), removeItem: key => tokens.delete(key) },
        location: {}, setTimeout: fn => { timers.set(fn, fn); return fn; }, clearTimeout: id => timers.delete(id),
        fetch: async (url, options) => { calls.push({ url, options }); return reply(options); }
    });
    vm.runInContext(html.slice(html.indexOf('const TOKEN_KEY ='), html.indexOf("document.getElementById('stepLogin').addEventListener")), context);
    return { node, calls, tokens, context, timers, reply: fn => { reply = fn; } };
}

test('password and second-factor login share submission handling and preserve their distinct credentials', async () => {
    const f = fixture(); f.node('email').value = ' admin@example.test '; f.node('password').value = 'test-password';
    f.reply(async () => ({ ok: true, json: async () => ({ success: true, requires2fa: true, challengeToken: 'challenge', methods: ['totp'] }) }));
    await f.context.login();
    assert.equal(f.calls[0].url, '/api/admin/login');
    assert.equal(JSON.parse(f.calls[0].options.body).email, 'admin@example.test');
    assert.equal(f.tokens.get('plus_admin_token'), undefined);
    f.node('code').value = '123456';
    f.reply(async () => ({ ok: true, json: async () => ({ success: true, token: 'verified', panelUrl: '/custom-admin' }) }));
    await f.context.verify2fa();
    const verification = JSON.parse(f.calls[1].options.body);
    assert.equal(f.calls[1].url, '/api/admin/login/verify-2fa');
    assert.equal(verification.challengeToken, 'challenge'); assert.equal(verification.method, 'totp'); assert.equal(verification.code, '123456');
    assert.equal(f.tokens.get('plus_admin_token'), 'verified'); assert.equal(f.tokens.has('plus_admin_secondary_token'), false);
    assert.equal(f.context.location.href, '/custom-admin'); assert.equal(f.timers.size, 0);
});

test('login rejects duplicate submissions and clears its busy state after timeout or authentication failure', async () => {
    const f = fixture(); f.node('email').value = 'admin@example.test'; f.node('password').value = 'test-password';
    f.reply(options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')))));
    const pending = f.context.login(); await f.context.login(); assert.equal(f.calls.length, 1);
    [...f.timers.values()][0](); await pending;
    assert.equal(f.node('loginBtn').disabled, false); assert.match(f.node('message').textContent, /请求超时/);
    f.reply(async () => ({ ok: false, json: async () => ({ success: false, message: '密码错误' }) }));
    await f.context.login();
    assert.equal(f.node('message').textContent, '密码错误'); assert.equal(f.tokens.has('plus_admin_token'), false);
    assert.equal(f.node('loginBtn').disabled, false); assert.equal(f.timers.size, 0);
});
