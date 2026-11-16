'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const register = require('../src/http/email-notification-http');

async function httpFixture(t, overrides = {}) {
    const calls = [], config = { enabled: false, smtp_host: 'smtp.example.test', smtp_port: 465,
        smtp_secure: true, smtp_user: 'user', smtp_password_saved: true, smtp_password_error: false,
        from_email: 'notice@example.test', to_email: 'admin@example.test', balance_threshold: '20.00',
        balance_cooldown_minutes: 360, on_low_balance: true, on_success: true, on_failure: true,
        smtp_password: 'must-never-be-returned', private: 'internal-only' };
    const store = { getPublicEmailConfig: async () => { calls.push(['read']); return config; },
        getEmailNotificationHistory: async options => { calls.push(['history', options]); return [{ event_type: 'order_success',
            target_email: 'admin@example.test', status: 'sent', attempts: 1, last_error: null, created_at: '2026-11-16',
            delivered_at: '2026-11-16', payload: 'private-message', smtp_password: 'must-never-be-returned' }]; },
        saveEmailConfig: async body => { calls.push(['save', body]); return config; }, ...overrides.store };
    const emailNotifications = { testEmail: async (...args) => { calls.push(['test', args]); return { success: true, message: '测试邮件已发送' }; }, ...overrides.service };
    const app = express(); app.use(express.json());
    app.use((req, res, next) => req.headers.authorization === 'Bearer administrator' ? next() : res.status(401).json({ success: false }));
    register(app, { store, emailNotifications, requireSecondaryAuth(req, res, next) {
        if (req.headers['x-admin-secondary-token'] !== 'verified') return res.status(403).json({ success: false, secondaryRequired: true });
        next();
    } });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    async function request(path = '', body, headers = { Authorization: 'Bearer administrator', 'x-admin-secondary-token': 'verified' }) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email-notifications${path}`, {
            method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, headers: response.headers, data: await response.json() };
    }
    return { calls, request, store };
}

test('SMTP configuration and test delivery require both administrator and secondary authentication', async t => {
    const f = await httpFixture(t);
    for (const [path, body] of [['', undefined], ['', {}], ['/test', {}]]) {
        assert.equal((await f.request(path, body, {})).status, 401);
        const denied = await f.request(path, body, { Authorization: 'Bearer administrator' });
        assert.equal(denied.status, 403); assert.equal(denied.data.secondaryRequired, true);
    }
    assert.deepEqual(f.calls, []);
});

test('configuration and history responses exclude SMTP secrets and message payloads', async t => {
    const f = await httpFixture(t), response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.data.config.smtp_password_saved, true);
    assert.equal(response.data.config.smtp_password_error, false);
    assert.equal(response.data.history[0].status, 'sent');
    assert.doesNotMatch(JSON.stringify(response.data), /must-never-be-returned|private-message|internal-only/);
    assert.deepEqual(f.calls, [['read'], ['history', { limit: 20 }]]);
});

test('saving configuration does not send mail and never echoes the submitted password', async t => {
    const f = await httpFixture(t);
    const response = await f.request('', { enabled: false, smtp_password: 'replacement-secret', to_email: 'admin@example.test' });
    assert.equal(response.status, 200);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'save');
    assert.equal(f.calls[0][1].smtp_password, 'replacement-secret');
    assert.doesNotMatch(JSON.stringify(response.data), /replacement-secret|must-never-be-returned/);
    assert.equal((await f.request('', [])).status, 400);
    assert.equal(f.calls.length, 1);
});

test('test email ignores request recipients and content and uses only the saved configuration', async t => {
    const f = await httpFixture(t);
    const response = await f.request('/test', { to_email: 'unexpected@example.test', subject: 'injected', text: 'do not send', smtp_password: 'fake' });
    assert.equal(response.status, 200); assert.equal(response.data.success, true);
    assert.deepEqual(f.calls, [['test', []]]);
});

test('known validation errors remain actionable while database and SMTP exceptions stay private', async t => {
    const invalid = await httpFixture(t, { store: { saveEmailConfig: async () => { throw Object.assign(new Error('SMTP 端口必须为 1-65535 的整数'), { code: 'EMAIL_CONFIG_INVALID' }); } } });
    const rejected = await invalid.request('', {});
    assert.equal(rejected.status, 400); assert.equal(rejected.data.message, 'SMTP 端口必须为 1-65535 的整数');
    const broken = await httpFixture(t, { store: { getPublicEmailConfig: async () => { throw new Error('SQL_PASSWORD=private'); } },
        service: { testEmail: async () => { throw new Error('AUTH smtp-password-private'); } } });
    for (const response of [await broken.request(), await broken.request('/test', {})]) {
        assert.equal(response.status, 503);
        assert.equal(response.data.message, '邮件通知服务暂不可用，请检查配置后重试');
        assert.doesNotMatch(JSON.stringify(response.data), /private/);
    }
});

const source = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
function uiFixture({ verified = true } = {}) {
    const nodes = new Map(), calls = [], notices = [], errors = [];
    const node = id => { if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, textContent: '', innerHTML: '' }); return nodes.get(id); };
    const tokens = new Map(verified ? [['secondary', 'verified']] : []);
    const context = vm.createContext({ $: node, SECONDARY_KEY: 'secondary', localStorage: { getItem: key => tokens.get(key) },
        escapeHtml: value => String(value ?? '').replace(/</g, '&lt;'), notice: (...args) => notices.push(args), reportError: error => errors.push(error.message),
        request: async (...args) => { calls.push(args); return { config: { enabled: false, smtp_password_saved: true }, history: [], message: '邮件配置已保存' }; } });
    vm.runInContext(source.slice(source.indexOf('function lockEmailNotificationForm('), source.indexOf('async function loadApi(')), context);
    return { context, node, calls, notices, errors, tokens };
}

test('settings do not request email configuration while locked and never fill the password from a response', async () => {
    const f = uiFixture({ verified: false }); f.node('smtpPassword').value = 'transient-input';
    await f.context.loadEmailNotifications();
    assert.deepEqual(f.calls, []); assert.equal(f.node('emailNotificationFields').disabled, true);
    assert.equal(f.node('smtpPassword').value, '');
    f.tokens.set('secondary', 'verified');
    await f.context.loadEmailNotifications();
    assert.equal(f.calls[0][0], '/api/admin/email-notifications');
    assert.equal(f.node('emailNotificationFields').disabled, false);
    assert.equal(f.node('smtpPassword').value, '');
    f.context.renderEmailNotificationConfig({ smtp_password: 'must-not-fill', smtp_password_saved: true, smtp_password_error: true });
    assert.equal(f.node('smtpPassword').value, '');
    assert.match(f.node('smtpPasswordState').textContent, /重新填写/);
});

test('save failures retain typed settings, successful saves clear only the submitted password', async () => {
    const f = uiFixture(); f.node('smtpHost').value = 'smtp.example.test'; f.node('smtpPassword').value = 'typed-secret';
    f.context.request = async () => { throw new Error('invalid settings'); };
    await assert.rejects(f.context.saveEmailNotifications(), /invalid settings/);
    assert.equal(f.node('smtpPassword').value, 'typed-secret'); assert.equal(f.node('smtpHost').value, 'smtp.example.test');
    f.context.request = async (_url, body) => {
        assert.equal(body.smtp_password, 'typed-secret');
        return { config: { smtp_host: body.smtp_host, smtp_password_saved: true }, message: 'saved' };
    };
    await f.context.saveEmailNotifications();
    assert.equal(f.node('smtpPassword').value, ''); assert.equal(f.node('smtpHost').value, 'smtp.example.test');
});

test('test email sends an empty body and prevents double clicks while delivery is pending', async () => {
    const f = uiFixture(); let resolve, requests = 0;
    f.node('emailTo').value = 'unsaved@example.test'; f.node('smtpPassword').value = 'unsaved-secret';
    f.context.request = async (url, body) => {
        requests++; assert.equal(url, '/api/admin/email-notifications/test'); assert.deepEqual(JSON.parse(JSON.stringify(body)), {});
        return new Promise(done => { resolve = done; });
    };
    const first = f.context.testEmailNotifications();
    await f.context.testEmailNotifications();
    assert.equal(requests, 1); assert.equal(f.node('testEmailNotifications').disabled, true);
    resolve({ message: '测试邮件已发送' }); await first;
    assert.equal(f.node('testEmailNotifications').disabled, false);
    assert.equal(f.node('smtpPassword').value, 'unsaved-secret');
    assert.equal(f.node('emailTestResult').textContent, '测试邮件已发送');
});
