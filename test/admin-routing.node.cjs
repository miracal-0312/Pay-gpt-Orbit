'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const auth = require('../admin-auth');

test('shared admin handlers preserve login tokens, 2FA failures and route-specific error statuses', async t => {
    const previous = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 'r'.repeat(32);
    let telegram = {};
    const logs = [], config = { email: 'admin@example.test', passwordVersion: 1, secondaryPasswordVersion: 1,
        passwordHash: auth.createPasswordHash('test-password'), login2faMode: 'either', totpEnabled: false };
    const store = {
        getAdminPaths: async () => ({ loginPath: 'admin-login', panelPath: 'admin' }),
        getAdminAuthConfig: async () => config,
        getTelegramConfig: async () => telegram,
        insertAdminLoginLog: async log => logs.push(log),
        saveGptApiConfig: async () => { throw Error('invalid config'); },
        listAdminTaskLogs: async () => { throw Error('query failed'); },
        updateOrderStatus: async () => { throw Object.assign(Error('stale order'), { status: 409 }); }
    };
    const app = express(); app.use(express.json());
    require('../admin-http')(app, { store, ensureStoreReady: async () => {}, getTotalActiveJobs: () => 0 });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.ADMIN_TOKEN_SECRET; else process.env.ADMIN_TOKEN_SECRET = previous;
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body, headers = {}) => {
        const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    const login = await post('/api/admin/login', { email: config.email, password: 'test-password' });
    assert.equal(login.status, 200); assert.equal(login.data.requires2fa, false); assert.equal(login.data.setupRequired, true);
    assert.equal(login.data.loginPath, '/admin-login'); assert.equal(auth.verifyAdminToken(login.data.token).email, config.email);
    assert.equal(logs.at(-1).event, 'login_success');
    const headers = { Authorization: `Bearer ${login.data.token}`, 'x-admin-secondary-token': auth.issueSecondaryToken(1, '127.0.0.1').token };
    const urlToken = await fetch(base + `/api/admin/session?token=${encodeURIComponent(login.data.token)}`);
    assert.equal(urlToken.status, 401, 'URL tokens cannot authenticate administrator HTTP requests');
    const bearer = await fetch(base + '/api/admin/session?token=ignored', { headers });
    assert.equal(bearer.status, 200); assert.equal((await bearer.json()).email, config.email);
    const removedSession = await fetch(base + '/api/admin/secondary/session', { headers });
    assert.equal(removedSession.status, 404);
    assert.deepEqual(await post('/api/admin/gpt-api', {}, headers), { status: 400, data: { success: false, message: 'invalid config' } });
    assert.deepEqual(await post('/api/admin/orders/order-1/status', {}, headers), { status: 409, data: { success: false, message: 'stale order' } });
    const failedQuery = await fetch(base + '/api/admin/task-logs', { headers });
    assert.equal(failedQuery.status, 500); assert.equal((await failedQuery.json()).message, 'query failed');

    telegram = { bot_token: 'test', admin_chat_id: '1', notify_admin: false };
    const challengeLogin = await post('/api/admin/login', { email: config.email, password: 'test-password' });
    assert.equal(challengeLogin.data.requires2fa, true); assert.equal(challengeLogin.data.token, undefined);
    const challengeToken = challengeLogin.data.challengeToken;
    const challenge = auth.verifyLoginChallenge(challengeToken);
    const expired = await post('/api/admin/login/verify-2fa', { challengeToken, method: 'telegram', code: '123456' });
    assert.equal(expired.status, 401); assert.equal(expired.data.message, '验证码已过期，请重新获取');
    assert.equal(logs.at(-1).detail, 'Telegram 验证码错误 (expired)');
    auth.storeTelegramLoginCode(challenge.cid, '123456');
    const verified = await post('/api/admin/login/verify-2fa', { challengeToken, method: 'telegram', code: '123456' });
    assert.equal(verified.status, 200); assert.equal(auth.verifyAdminToken(verified.data.token).email, config.email);
    assert.equal(verified.data.setupRequired, undefined); assert.equal(logs.at(-1).detail, '二次验证成功 (telegram)');
});

test('platform status returns current plans and balance without the removed recent-order query', async t => {
    const api = require('../orbitcard-client'), previousCheck = api.testConnection;
    const previousSecret = process.env.ADMIN_TOKEN_SECRET;
    process.env.ADMIN_TOKEN_SECRET = 's'.repeat(32);
    api.testConnection = async () => ({success:true,plans:[{type:'gpt-plus'}],balance:{available_balance:'20.00'},checks:[]});
    const authConfig = {email:'admin@example.test',passwordVersion:1};
    const store = {
        getAdminAuthConfig: async () => authConfig,
        getGptApiConfig: async () => ({base_url:'https://orbitcard.test',api_key:'configured'})
    };
    const app = express(); app.use(express.json());
    require('../admin-http')(app, {store,ensureStoreReady:async()=>{},getTotalActiveJobs:()=>0});
    const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async()=>{
        server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
        api.testConnection = previousCheck;
        if(previousSecret===undefined)delete process.env.ADMIN_TOKEN_SECRET;else process.env.ADMIN_TOKEN_SECRET=previousSecret;
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/gpt-api/status`, {
        headers:{Authorization:`Bearer ${auth.issueAdminToken(1,authConfig.email).token}`}
    });
    assert.equal(response.status,200); const data = await response.json();
    assert.deepEqual(data.plans,[{type:'gpt-plus'}]); assert.equal(data.balance.available_balance,'20.00');
    assert.equal(Object.hasOwn(data,'recent_orders'),false);
});
