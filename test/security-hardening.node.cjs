'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const express = require('express');
const auth = require('../src/http/admin-auth');
const orbitcardConfig = require('../src/config/orbitcard-config');
const emailConfig = require('../src/integrations/email-config');
const telegram = require('../src/integrations/telegram-notify');

test('Orbitcard base_url enforces host allowlist and blocks SSRF targets', () => {
    const prod = { NODE_ENV: 'production' };
    assert.equal(orbitcardConfig.normalizeBaseUrl('https://orbitcard.cc', prod), 'https://orbitcard.cc');
    assert.equal(orbitcardConfig.normalizeBaseUrl('https://api.orbitcard.cc', prod), 'https://api.orbitcard.cc');
    for (const bad of [
        'https://evil.example',
        'https://127.0.0.1',
        'https://169.254.169.254',
        'https://[::1]',
        'https://localhost',
        'https://orbitcard.cc.evil.example',
        'https://orbitcard.test'
    ]) {
        assert.throws(() => orbitcardConfig.normalizeBaseUrl(bad, prod), /白名单/);
    }
    assert.equal(orbitcardConfig.normalizeBaseUrl('https://relay.partner.example', {
        NODE_ENV: 'production', ORBITCARD_ALLOWED_HOSTS: 'partner.example'
    }), 'https://relay.partner.example');
});

test('email config rejects private, loopback and metadata SMTP hosts', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'localhost', 'mail.internal']) {
        assert.throws(() => emailConfig.validateSmtpConfig({
            smtp_host: host, smtp_port: 465, smtp_secure: true,
            smtp_user: 'u', smtp_password: 'p', from_email: 'a@example.com', to_email: 'b@example.com'
        }), /内网|本机/);
    }
});

test('Telegram rejects unsafe bot tokens before constructing API URLs', async () => {
    const result = await telegram.sendTelegramMessage('../evil?x=1', '123', 'hi');
    assert.equal(result.ok, false);
    assert.match(result.error, /格式无效/);
});

test('2FA setup cannot disable an active authenticator, admin paths are not public, and challenges are single-use', async t => {
    const previous = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 'k'.repeat(32);
    const config = {
        email: 'admin@example.test',
        passwordVersion: 1,
        secondaryPasswordVersion: 1,
        passwordHash: auth.createPasswordHash('CorrectPass123'),
        secondaryPasswordHash: auth.createPasswordHash('SecondaryPass123'),
        totpSecret: auth.generateTotpSecret(),
        totpEnabled: true,
        login2faMode: 'either'
    };
    const store = {
        getAdminPaths: async () => ({ loginPath: 'secret-login', panelPath: 'secret-panel' }),
        getAdminAuthConfig: async () => config,
        getTelegramConfig: async () => ({ bot_token: '123:abc', admin_chat_id: '1' }),
        insertAdminLoginLog: async () => {},
        saveAdminTotpConfig: async next => { config.totpSecret = next.secret; config.totpEnabled = next.enabled; }
    };
    const app = express();
    app.use(express.json());
    require('../src/http/admin-http')(app, { store, ensureStoreReady: async () => {}, getTotalActiveJobs: () => 0 });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET = previous;
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body, headers = {}) => {
        const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json() };
    };

    // Public admin paths endpoint is removed.
    assert.equal((await fetch(base + '/api/public/admin-paths')).status, 404);

    // Active TOTP cannot be disabled or overwritten via /api/admin/2fa/setup.
    const adminToken = auth.issueAdminToken(1, config.email).token;
    const setupRes = await post('/api/admin/2fa/setup', {}, { Authorization: `Bearer ${adminToken}` });
    assert.equal(setupRes.status, 409);
    assert.equal(config.totpEnabled, true);

    // /api/admin/gpt-api/test requires secondary auth.
    const testNoSecondary = await post('/api/admin/gpt-api/test', { base_url: 'https://evil.example' }, { Authorization: `Bearer ${adminToken}` });
    assert.equal(testNoSecondary.status, 403);

    // Challenge token cannot be reused after successful Telegram 2FA.
    const login = await post('/api/admin/login', { email: config.email, password: 'CorrectPass123' });
    assert.equal(login.data.requires2fa, true);
    const challenge = auth.verifyLoginChallenge(login.data.challengeToken);
    auth.storeTelegramLoginCode(challenge.cid, '654321');
    // Immediate resend is throttled.
    assert.throws(() => auth.storeTelegramLoginCode(challenge.cid, '111111'), /频繁/);
    const firstVerify = await post('/api/admin/login/verify-2fa', { challengeToken: login.data.challengeToken, method: 'telegram', code: '654321' });
    assert.equal(firstVerify.status, 200);
    const replayVerify = await post('/api/admin/login/verify-2fa', { challengeToken: login.data.challengeToken, method: 'telegram', code: '654321' });
    assert.equal(replayVerify.status, 401);
});

test('public HTML pages contain no inline scripts or inline style attributes for strict CSP', () => {
    for (const file of ['index.html', 'admin.html', 'admin-login.html']) {
        const html = fs.readFileSync(require.resolve(`../public/${file}`), 'utf8');
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} must not contain inline scripts`);
        assert.doesNotMatch(html, /\sstyle=/i, `${file} must not contain inline style attributes`);
    }
});
