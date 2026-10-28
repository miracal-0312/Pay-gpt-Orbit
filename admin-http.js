// Retained admin login, 2FA, CDK and Orbitcard management routes.
'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const adminAuth = require('./admin-auth');
const gptApi = require('./orbitcard-client');
const runtimeLog = require('./runtime-log');
const { buildAdminLoginUrl, buildAdminPanelUrl } = require('./admin-paths');
const { PLAN_TYPES, normalizePlanType } = require('./plan-registry');
const { notifyAdminSecurityEvent, sendTelegramLoginCode, sendTelegramTest } = require('./telegram-notify');
module.exports = function registerAdmin(app, { store, ensureStoreReady, getTotalActiveJobs, cardService, manualService }) {
    let cachedAdminPaths = null;
    const ADMIN_REFRESH_AFTER_MS = adminAuth.ADMIN_REFRESH_AFTER_MS;
    const verifyPassword = adminAuth.verifyPassword;
    const issueAdminToken = adminAuth.issueAdminToken;
    const verifyAdminToken = adminAuth.verifyAdminToken;
    const requireSecondaryAuth = adminAuth.createRequireSecondaryAuth(store, ensureStoreReady);
    const CDK_PREFIX = 'YZW-', CDK_RANDOM_LENGTH = 12, CDK_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function getCachedAdminPaths() {
    if (cachedAdminPaths) {
        return cachedAdminPaths;
    }
    await ensureStoreReady();
    cachedAdminPaths = await store.getAdminPaths();
    return cachedAdminPaths;
}

function invalidateAdminPathsCache() {
    cachedAdminPaths = null;
}

function normalizeRequestPathname(pathname) {
    return String(pathname || '/').replace(/\/+$/, '') || '/';
}

async function attachAdminPaths(payload) {
    const paths = await getCachedAdminPaths();
    return {
        ...payload,
        loginPath: buildAdminLoginUrl(paths),
        panelPath: buildAdminPanelUrl(paths)
    };
}

async function logAdminSecurityEvent(event, meta = {}) {
    try {
        await ensureStoreReady();
        await store.insertAdminLoginLog({
            event,
            adminEmail: meta.email || '',
            ip: meta.ip || '',
            userAgent: meta.userAgent || '',
            fingerprint: meta.fingerprint || '',
            detail: meta.detail || ''
        });
    } catch (error) {
        console.warn(`[AdminAuth] 登录日志写入失败: ${error.message}`);
    }
}

async function fireAdminSecurityNotification(event, payload = {}) {
    notifyAdminSecurityEvent(store, event, payload).catch((error) => {
        console.warn(`[AdminAuth] Telegram 通知失败: ${error.message}`);
    });
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) {
        return token.trim();
    }
    return (req.query?.token || '').trim() || null;
}

async function authenticateAdmin(req, res, next) {
    const token = getBearerToken(req);
    const payload = verifyAdminToken(token);
    if (!payload) {
        return res.status(401).json({ success: false, message: '未授权，请重新登录' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (Number(payload.pv || 0) !== authConfig.passwordVersion) {
            return res.status(401).json({ success: false, message: '登录状态已失效，请重新登录' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    req.admin = payload;
    req.adminToken = token;
    return next();
}

function randomCdkSuffix(length = CDK_RANDOM_LENGTH) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += CDK_CHARSET[bytes[i] % CDK_CHARSET.length];
    }
    return out;
}

function createCdks(count, planType) {
    const results = new Set();
    const target = Math.max(1, Math.min(Number(count) || 1, 100));
    while (results.size < target) {
        results.add(`${CDK_PREFIX}${randomCdkSuffix()}-${planType.toUpperCase()}`);
    }

    return [...results];
}
app.use((req, res, next) => {
    if (req.method === 'GET' && ['/admin.html', '/admin-login.html'].includes(req.path)) {
        return res.status(404).type('text/plain').send('Not Found');
    }
    next();
});
app.use(async (req, res, next) => {
    if (req.method !== 'GET') {
        return next();
    }
    try {
        const paths = await getCachedAdminPaths();
        const current = normalizeRequestPathname(req.path);
        const loginUrl = normalizeRequestPathname(buildAdminLoginUrl(paths));
        const panelUrl = normalizeRequestPathname(buildAdminPanelUrl(paths));
        if (current === loginUrl) {
            return res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
        }
        if (current === panelUrl) {
            return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
        }
    } catch (_) {
        // DB 尚未就绪时交给后续路由处理
    }
    return next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
});
app.get(['/admin-login', '/admin-login/', '/admin-login.html'], (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
});
app.post('/api/admin/login', async (req, res) => {
    const email = adminAuth.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const clientMeta = adminAuth.getClientMeta(req);

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '请输入管理员邮箱和密码' });
    }

    const rate = adminAuth.checkLoginRateLimit(clientMeta.ip);
    if (!rate.allowed) {
        return res.status(429).json({
            success: false,
            message: `登录尝试过多，请 ${rate.retryAfterSec} 秒后再试`
        });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const emailOk = email === adminAuth.normalizeEmail(authConfig.email);
        const passwordOk = verifyPassword(password, authConfig.passwordHash);

        if (!emailOk || !passwordOk) {
            adminAuth.recordLoginFailure(rate.key, rate.entry);
            await logAdminSecurityEvent('login_failed', {
                ...clientMeta,
                email,
                detail: '邮箱或密码错误'
            });
            fireAdminSecurityNotification('admin_login_failed', {
                email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                message: '邮箱或密码错误'
            });
            return res.status(401).json({ success: false, message: '邮箱或密码错误' });
        }

        adminAuth.clearLoginAttempts(rate.key);

        const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
        if (!adminAuth.is2faRequired(authConfig, telegramSettings)) {
            const { token, payload } = issueAdminToken(authConfig.passwordVersion, authConfig.email);
            await logAdminSecurityEvent('login_success', {
                ...clientMeta,
                email: authConfig.email,
                detail: '密码登录（未启用二次验证）'
            });
            fireAdminSecurityNotification('admin_login_success', {
                email: authConfig.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method: 'password_only',
                message: '后台登录成功（尚未启用 2FA）'
            });
            return res.json(await attachAdminPaths({
                success: true,
                token,
                expiresAt: payload.exp,
                issuedAt: payload.iat,
                permissions: payload.permissions,
                email: authConfig.email,
                requires2fa: false,
                setupRequired: true
            }));
        }

        const challenge = adminAuth.issueLoginChallenge({
            email: authConfig.email,
            passwordVersion: authConfig.passwordVersion,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint
        });

        return res.json({
            success: true,
            requires2fa: true,
            challengeToken: challenge.token,
            methods,
            defaultMethod: adminAuth.pickDefaultLogin2faMethod(methods, authConfig.login2faMode === 'either' ? '' : authConfig.login2faMode),
            login2faMode: authConfig.login2faMode,
            email: authConfig.email,
            expiresAt: challenge.payload.exp
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/login/send-tg-code', async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || '').trim();
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);
    if (!challenge) {
        return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
    }

    try {
        await ensureStoreReady();
        const code = adminAuth.generateTelegramLoginCode();
        adminAuth.storeTelegramLoginCode(challenge.cid, code);
        const clientMeta = adminAuth.getClientMeta(req);
        const sendResult = await sendTelegramLoginCode(store, code, {
            email: challenge.email,
            ip: clientMeta.ip || challenge.ip
        });
        if (!sendResult.ok) {
            return res.status(400).json({ success: false, message: sendResult.error || 'Telegram 验证码发送失败' });
        }
        return res.json({ success: true, message: '验证码已发送到管理员 Telegram' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/login/verify-2fa', async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || '').trim();
    const method = String(req.body?.method || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const clientMeta = adminAuth.getClientMeta(req);
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);

    if (!challenge) {
        return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
    }

    if (!code) {
        return res.status(400).json({ success: false, message: '请输入验证码' });
    }

    const rate = adminAuth.checkLoginRateLimit(`${clientMeta.ip}:2fa`);
    if (!rate.allowed) {
        return res.status(429).json({
            success: false,
            message: `验证尝试过多，请 ${rate.retryAfterSec} 秒后再试`
        });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
        if (!methods.includes(method)) {
            return res.status(400).json({ success: false, message: '不支持的验证方式' });
        }

        let verified = false;
        if (method === 'totp') {
            verified = adminAuth.verifyTotpCode(authConfig.totpSecret, code);
        } else if (method === 'telegram') {
            const tgResult = adminAuth.verifyTelegramLoginCode(challenge.cid, code);
            verified = tgResult.ok;
            if (!verified) {
                adminAuth.recordLoginFailure(rate.key, rate.entry);
                await logAdminSecurityEvent('2fa_failed', {
                    ...clientMeta,
                    email: challenge.email,
                    detail: `Telegram 验证码错误 (${tgResult.reason || 'invalid'})`
                });
                fireAdminSecurityNotification('admin_2fa_failed', {
                    email: challenge.email,
                    ip: clientMeta.ip,
                    fingerprint: clientMeta.fingerprint,
                    userAgent: clientMeta.userAgent,
                    method: 'telegram',
                    message: 'Telegram 验证码错误'
                });
                const message = tgResult.reason === 'expired'
                    ? '验证码已过期，请重新获取'
                    : 'Telegram 验证码错误';
                return res.status(401).json({ success: false, message });
            }
        }

        if (!verified) {
            adminAuth.recordLoginFailure(rate.key, rate.entry);
            await logAdminSecurityEvent('2fa_failed', {
                ...clientMeta,
                email: challenge.email,
                detail: `${method} 验证码错误`
            });
            fireAdminSecurityNotification('admin_2fa_failed', {
                email: challenge.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method,
                message: '二次验证失败'
            });
            return res.status(401).json({ success: false, message: '验证码错误' });
        }

        adminAuth.clearLoginAttempts(rate.key);
        const { token, payload } = issueAdminToken(authConfig.passwordVersion, authConfig.email);
        await logAdminSecurityEvent('login_success', {
            ...clientMeta,
            email: authConfig.email,
            detail: `二次验证成功 (${method})`
        });
        fireAdminSecurityNotification('admin_login_success', {
            email: authConfig.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            method,
            message: '后台登录成功'
        });

        return res.json(await attachAdminPaths({
            success: true,
            token,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            permissions: payload.permissions,
            email: authConfig.email
        }));
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/public/admin-paths', async (req, res) => {
    try {
        await ensureStoreReady();
        const paths = await store.getAdminPaths();
        return res.json({
            success: true,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
app.use('/api/admin', authenticateAdmin);
require('./orbitcard-card-http')(app, { store, cardService, requireSecondaryAuth, audit: entry => runtimeLog.push(entry) });
require('./orbitcard-manual-http')(app, { service: manualService, requireSecondaryAuth });
require('./orbitcard-diagnostics-http')(app, { store, requireSecondaryAuth, logs: runtimeLog });
app.get('/api/admin/runtime-logs', authenticateAdmin, (req, res) => {
    try {
        const wantTail = String(req.query.tail || '') === '1' || String(req.query.tail || '') === 'true';
        const after = Math.max(0, parseInt(String(req.query.after || '0'), 10) || 0);
        let limit = parseInt(String(req.query.limit || '500'), 10) || 500;
        limit = Math.min(2000, Math.max(1, limit));

        const entries = wantTail ? runtimeLog.tail(limit) : runtimeLog.after(after, limit);
        const nextAfter = entries.length ? entries[entries.length - 1].id : after;
        res.json({ success: true, entries, nextAfter });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/runtime-logs/clear', authenticateAdmin, (req, res) => {
    try {
        runtimeLog.clear();
        runtimeLog.push({ jobKey: '', level: 'system', source: 'server', text: '运行日志显示缓存已清空，磁盘历史保留' });
        res.json({ success: true, message: '显示缓存已清空，持久化日志保留' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/session', (req, res) => {
    const age = Date.now() - Number(req.admin.iat || 0);
    const shouldRefresh = age >= ADMIN_REFRESH_AFTER_MS;
    let refreshedToken = null;
    let payload = req.admin;

    if (shouldRefresh) {
        const refreshed = issueAdminToken(req.admin.pv, req.admin.email);
        refreshedToken = refreshed.token;
        payload = refreshed.payload;
    }

    return res.json({
        success: true,
        refreshed: shouldRefresh,
        token: refreshedToken,
        expiresAt: payload.exp,
        issuedAt: payload.iat,
        permissions: payload.permissions,
        email: payload.email || ''
    });
});
app.get('/api/admin/security/status', async (req, res) => {
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const paths = await store.getAdminPaths();
        res.json({
            success: true,
            email: authConfig.email,
            totpEnabled: authConfig.totpEnabled,
            login2faMode: authConfig.login2faMode,
            availableMethods: adminAuth.getAvailable2faMethods(authConfig, telegramSettings),
            methods: adminAuth.resolveLogin2faMethods(authConfig, telegramSettings),
            notifyAdminLogin: authConfig.notifyAdminLogin,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/login-logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Number(req.query.limit) || 100;
        const offset = Number(req.query.offset) || 0;
        res.json({ success: true, ...(await store.listAdminLoginLogs(limit, offset)) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/secondary/session', (req, res) => {
    const token = String(req.headers['x-admin-secondary-token'] || '').trim();
    const payload = adminAuth.verifySecondaryToken(token);
    if (!payload) {
        return res.json({ success: true, verified: false });
    }
    return res.json({
        success: true,
        verified: true,
        expiresAt: payload.exp
    });
});
app.post('/api/admin/verify-secondary', async (req, res) => {
    const password = String(req.body?.password || '');
    const clientMeta = adminAuth.getClientMeta(req);
    if (!password) {
        return res.status(400).json({ success: false, message: '请输入二级密码' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(password, authConfig.secondaryPasswordHash)) {
            await logAdminSecurityEvent('secondary_failed', {
                ...clientMeta,
                email: req.admin?.email || authConfig.email,
                detail: '二级密码错误'
            });
            return res.status(401).json({ success: false, message: '二级密码错误' });
        }

        const { token, payload } = adminAuth.issueSecondaryToken(
            authConfig.secondaryPasswordVersion,
            clientMeta.ip
        );
        await logAdminSecurityEvent('secondary_success', {
            ...clientMeta,
            email: req.admin?.email || authConfig.email,
            detail: '敏感模块解锁'
        });
        fireAdminSecurityNotification('admin_secondary_success', {
            email: req.admin?.email || authConfig.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            message: 'CDK 管理已解锁'
        });
        return res.json({
            success: true,
            secondaryToken: token,
            expiresAt: payload.exp
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/security/2fa-mode', async (req, res) => {
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    try {
        await ensureStoreReady();
        const saved = await store.saveAdmin2faLoginMode(mode);
        res.json({ success: true, login2faMode: saved, message: '登录验证方式已保存' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/security/paths', async (req, res) => {
    try {
        await ensureStoreReady();
        const saved = await store.saveAdminPaths({
            loginPath: req.body?.loginPath,
            panelPath: req.body?.panelPath
        });
        invalidateAdminPathsCache();
        cachedAdminPaths = saved;
        return res.json({
            success: true,
            loginPath: saved.loginPath,
            panelPath: saved.panelPath,
            loginUrl: buildAdminLoginUrl(saved),
            panelUrl: buildAdminPanelUrl(saved),
            message: '入口路径已更新，请使用新地址访问并收藏'
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/2fa/setup', async (req, res) => {
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        let secret = String(authConfig.totpSecret || '').trim();
        if (!secret || authConfig.totpEnabled) {
            secret = adminAuth.generateTotpSecret();
            await store.saveAdminTotpConfig({ secret, enabled: false });
        }
        const otpauthUrl = adminAuth.getTotpUri(authConfig.email, secret);
        res.json({
            success: true,
            secret,
            otpauthUrl,
            message: '请使用 Google Authenticator 扫码后输入验证码确认启用'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/2fa/confirm', async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) {
        return res.status(400).json({ success: false, message: '请输入 Authenticator 验证码' });
    }
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!authConfig.totpSecret) {
            return res.status(400).json({ success: false, message: '请先发起 2FA 绑定' });
        }
        if (!adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
            return res.status(400).json({ success: false, message: '验证码错误，请重试' });
        }
        await store.saveAdminTotpConfig({ secret: authConfig.totpSecret, enabled: true });
        res.json({ success: true, message: 'Google Authenticator 已启用' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/2fa/disable', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const code = String(req.body?.code || '').trim();
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '登录密码错误' });
        }
        if (authConfig.totpEnabled && !adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
            return res.status(400).json({ success: false, message: 'Authenticator 验证码错误' });
        }
        await store.saveAdminTotpConfig({ secret: '', enabled: false });
        res.json({ success: true, message: 'Google Authenticator 已关闭' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/change-secondary-password', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '').trim();
    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入当前二级密码' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新二级密码至少 6 位' });
    }
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.secondaryPasswordHash)) {
            return res.status(400).json({ success: false, message: '当前二级密码错误' });
        }
        await store.updateAdminSecondaryPassword(newPassword);
        res.json({ success: true, message: '二级密码已更新，敏感模块需重新验证' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/task-logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        const tasks = await store.listAdminTaskLogs(limit);
        res.json({ success: true, tasks });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/telegram', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveTelegramConfig({
            bot_token: body.bot_token,
            admin_chat_id: body.admin_chat_id,
            group_chat_id: body.group_chat_id,
            notify_admin: Boolean(body.notify_admin),
            notify_group: Boolean(body.notify_group),
            on_success: Boolean(body.on_success),
            on_failure: Boolean(body.on_failure)
        });
        res.json({ success: true, message: 'Telegram 通知配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/task-logs/:jobKey/audit', (req, res) => {
    try {
        const file = runtimeLog.taskFile(req.params.jobKey);
        if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: '此任务没有持久化日志；升级前的历史无法补录' });
        res.set('Cache-Control', 'no-store');
        return res.download(file, `task-${req.params.jobKey}.jsonl`);
    } catch (_) {
        return res.status(400).json({ success: false, message: '无效的任务日志标识' });
    }
});
app.post('/api/admin/telegram/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await sendTelegramTest(store, req.body || {});
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: result.message });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/gpt-api', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getGptApiConfig();
        res.json({
            success: true,
            config: {
                provider: cfg.provider,
                orbitcard_max_fee: cfg.orbitcard_max_fee,
                orbitcard_product_code: cfg.orbitcard_product_code,
                orbitcard_safety_margin: cfg.orbitcard_safety_margin,
                orbitcard_max_initial_amount: cfg.orbitcard_max_initial_amount,
                orbitcard_payment_regions: cfg.orbitcard_payment_regions,
                orbitcard_secret_configured: Boolean(String(process.env.ORBITCARD_API_SECRET || '').trim()),
                enabled: cfg.enabled,
                base_url: cfg.base_url,
                api_key_configured: Boolean(cfg.api_key)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/gpt-api', async (req, res) => {
    try {
        await ensureStoreReady();
        await store.saveGptApiConfig(req.body || {});
        res.json({ success: true, message: 'Orbitcard HMAC 代充配置已保存' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/gpt-api/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const saved = await store.getGptApiConfig();
        const merged = {
            ...saved,
            base_url: String(body.base_url || '').trim() || saved.base_url
        };
        let target;
        try { target = gptApi.normalizeBaseUrl(merged.base_url); }
        catch (error) { return res.status(400).json({ success: false, message: error.message }); }
        const result = await gptApi.testConnection(merged);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error || '连接失败', target, checks: result.checks || [] });
        }
        res.json({ success: true, message: result.message, plans: result.plans, balance: result.balance,
            balance_error: result.balanceError || null, target, checks: result.checks || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/admin/gpt-api/status', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getGptApiConfig();
        if (!cfg.api_key) {
            return res.status(400).json({ success: false, message: '尚未配置第三方代充 API Key' });
        }
        const [connection, recentOrders] = await Promise.all([
            gptApi.testConnection(cfg),
            store.listRecentGptApiOrders(10)
        ]);
        if (!connection.success) {
            return res.status(400).json({ success: false, message: connection.error || '套餐查询失败',
                target: gptApi.normalizeBaseUrl(cfg.base_url), checks: connection.checks || [] });
        }
        const orders = recentOrders.map((order) => ({
            job_key: order.job_key,
            cdk_code: order.cdk_code,
            status: order.status,
            message: order.message,
            updated_at: order.updated_at,
            order_id: order.gpt_api_order_id,
            client_order_no: order.orbitcard_client_order_no,
            task_id: order.gpt_api_task_id,
            topup_code: order.gpt_api_topup_code || null,
            orbitcard_order: (() => {
                try { return require('./orbitcard-client').summary(JSON.parse(order.gpt_api_raw || '{}')); } catch (_) { return {}; }
            })()
        }));
        res.json({
            success: true,
            gpt_plans: connection.gptPlans,
            credit_plans: connection.creditPlans,
            balance: connection.balance,
            balance_error: connection.balanceError,
            target: gptApi.normalizeBaseUrl(cfg.base_url),
            checks: connection.checks || [],
            recent_orders: orders
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/config', async (req, res) => {
    try {
        await ensureStoreReady();
        const nextConfig = { ...(req.body || {}) };
        if (nextConfig.maintenance_mode) {
            nextConfig.maintenance_mode_drain = getTotalActiveJobs() > 0;
        } else {
            nextConfig.maintenance_mode_drain = false;
        }
        await store.saveConfig(nextConfig);
        res.json({ success: true, message: '接单配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/change-password', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '').trim();

    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入原密码' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();

        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '原密码错误' });
        }

        if (verifyPassword(newPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '新密码不能与原密码相同' });
        }

        await store.updateAdminPassword(newPassword);
        await logAdminSecurityEvent('password_changed', {
            ...adminAuth.getClientMeta(req),
            email: req.admin?.email || authConfig.email,
            detail: '登录密码已修改'
        });
        return res.json({ success: true, message: '密码修改成功，请重新登录' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/change-email', async (req, res) => {
    const email = adminAuth.normalizeEmail(req.body?.email);
    const currentPassword = String(req.body?.currentPassword || '');

    if (!email) {
        return res.status(400).json({ success: false, message: '请输入新的管理员邮箱' });
    }
    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入当前登录密码' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '当前登录密码错误' });
        }
        if (email === authConfig.email) {
            return res.status(400).json({ success: false, message: '新邮箱不能与当前邮箱相同' });
        }

        const updated = await store.updateAdminEmail(email);
        await logAdminSecurityEvent('admin_email_changed', {
            ...adminAuth.getClientMeta(req),
            email: updated.email,
            detail: `管理员登录邮箱已由 ${authConfig.email} 修改为 ${updated.email}`
        });
        return res.json({
            success: true,
            email: updated.email,
            message: '管理员登录邮箱已修改，请使用新邮箱重新登录'
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});
function cdkPlanFilter(req, res) {
    const planType = req.query.plan_type || '';
    if (typeof planType !== 'string' || (planType && !PLAN_TYPES.includes(planType))) {
        res.status(400).json({ success: false, message: '无效的 CDK 套餐筛选条件' });
        return null;
    }
    return planType;
}

async function liveCdkPlans() {
    const result = await gptApi.fetchPlans(await store.getGptApiConfig());
    if (!result.success || !Array.isArray(result.plans)) throw new Error(result.error || 'Orbitcard 套餐目录读取失败');
    return PLAN_TYPES.map(type => {
        const plan = result.plans.find(item => item.type === gptApi.PLAN_MAP[type]);
        return plan ? { type, name: String(plan.name || type).slice(0, 128) } : null;
    }).filter(Boolean);
}

async function verifyLiveCdkPlan(value) {
    const type = normalizePlanType(value, { allowLegacy: false });
    if (!(await liveCdkPlans()).some(plan => plan.type === type)) {
        throw new Error('Orbitcard 当前未开放所选套餐，无法生成或导入 CDK');
    }
    return type;
}

app.get('/api/admin/cdks/plans', requireSecondaryAuth, async (req, res) => {
    try { await ensureStoreReady(); res.set('Cache-Control', 'no-store'); res.json({ success: true, plans: await liveCdkPlans() }); }
    catch (error) { res.status(503).json({ success: false, message: error.message }); }
});

function csvCell(value) {
    const text = String(value ?? '');
    const safe = /^[\s\x00-\x1f]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}

function cdkCsvLine(code) {
    const state = code.orbitcard_support_locked ? '人工售后锁定' : code.orbitcard_balance_blocked ? '余额不足锁定'
        : code.orbitcard_pending_confirmation ? '结果待确认' : ({ unused: '未使用', redeemed: '已核销', processing: '处理中' }[code.status] || code.status);
    const created = code.created_at instanceof Date ? code.created_at.toISOString() : code.created_at;
    return [code.code, code.plan_label, state, code.shipped ? '已出库' : '未出库', created].map(csvCell).join(',') + '\r\n';
}

function cdkSelection(req, res, exporting = false) {
    const status = req.query.status ?? '', shipped = req.query.shipped ?? '';
    const format = req.query.format ?? 'detail', quantity = req.query.quantity ?? '';
    const markShipped = req.query.mark_shipped ?? 'true';
    if (!['', 'unused', 'processing', 'redeemed'].includes(status)
        || !['', 'true', 'false'].includes(shipped)
        || (exporting && (!['detail', 'secret'].includes(format)
            || !['true', 'false'].includes(markShipped)
            || typeof quantity !== 'string'
            || (quantity !== '' && (!/^[1-9]\d*$/.test(quantity) || Number(quantity) > 100000))))) {
        res.status(400).json({ success: false, message: '无效的卡密筛选或导出配置，数量须为 1–100000 的整数或留空' });
        return null;
    }
    return { status, shipped, format, limit: exporting && quantity ? Number(quantity) : Infinity, markShipped: markShipped === 'true' };
}

// Filter mapped states so export and list use the same redemption/occupation rules.
// Advance using the source page, including pages containing no matching cards.
async function* selectedCdkPages(planType, selection) {
    let beforeId = null, remaining = selection.limit;
    while (remaining > 0) {
        const page = await store.listCdksExportPage(planType, beforeId);
        if (!page.length) return;
        const matches = page.filter(code => (!selection.status || code.status === selection.status)
            && (!selection.shipped || code.shipped === (selection.shipped === 'true'))).slice(0, remaining);
        if (matches.length) { remaining -= matches.length; yield matches; }
        if (page.length < 500) return;
        beforeId = page.at(-1).id;
    }
}

app.get('/api/admin/cdks', requireSecondaryAuth, async (req, res) => {
    const planType = cdkPlanFilter(req, res);
    if (planType === null) return;
    const selection = cdkSelection(req, res);
    if (!selection) return;
    try {
        await ensureStoreReady();
        res.set('Cache-Control', 'no-store');
        if (!selection.status && !selection.shipped) return res.json(await store.listCdks(planType));
        const codes = [];
        for await (const page of selectedCdkPages(planType, { ...selection, limit: 2000 })) codes.push(...page);
        res.json(codes);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/cdks/export', requireSecondaryAuth, async (req, res) => {
    const planType = cdkPlanFilter(req, res);
    if (planType === null) return;
    const selection = cdkSelection(req, res, true);
    if (!selection) return;
    try {
        await ensureStoreReady();
        const exportedIds = [];
        const pages = selectedCdkPages(planType, selection);
        let next = await pages.next();
        if (next.done) return res.status(404).json({ success: false, message: '没有符合当前配置的卡密，请调整筛选条件' });
        const name = `cdks-${planType || 'all'}-${selection.format}-${new Date().toISOString().slice(0, 10)}.csv`;
        res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name}"` });
        res.write('\uFEFF' + (selection.format === 'secret' ? 'secret' : ['卡密', '套餐', '状态', '出库', '创建时间'].map(csvCell).join(',')) + '\r\n');
        while (!next.done && !res.destroyed) {
            const page = next.value;
            exportedIds.push(...page.map(code => code.id));
            const chunk = page.map(code => selection.format === 'secret' ? csvCell(code.code) + '\r\n'
                : cdkCsvLine({ ...code, shipped: selection.markShipped || code.shipped })).join('');
            if (!res.write(chunk)) {
                await new Promise(resolve => {
                    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                    res.once('drain', done); res.once('close', done);
                });
            }
            if (res.destroyed) break;
            next = await pages.next();
        }
        if (!res.destroyed) {
            if (selection.markShipped) await store.markCdksShipped(exportedIds);
            res.end();
        }
    } catch (error) {
        if (res.headersSent) res.destroy(error);
        else res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/cdks/generate', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const count = req.body?.count;
        const planType = await verifyLiveCdkPlan(req.body?.plan_type || 'plus');
        const newCdks = createCdks(count, planType);
        const result = await store.insertCdks(newCdks, { type: '自助', plan_type: planType });
        res.json({
            success: true,
            message: `成功生成 ${result.insertedCount} 个自助 CDK`,
            cdks: newCdks,
            insertedCount: result.insertedCount,
            plan_type: planType
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/cdks/import', requireSecondaryAuth, async (req, res) => {
    const cdks = Array.isArray(req.body?.cdks) ? req.body.cdks : [];
    if (cdks.length === 0) {
        return res.status(400).json({ success: false, message: '请提供要导入的卡密' });
    }

    try {
        await ensureStoreReady();
        const planType = await verifyLiveCdkPlan(req.body?.plan_type || 'plus');
        const summary = await store.insertCdks(cdks, { plan_type: planType });
        res.json({
            success: true,
            message: `导入完成，新增 ${summary.insertedCount} 个，重复 ${summary.duplicateCount} 个`,
            ...summary
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.post('/api/admin/cdks/:cdk/status', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await store.updateCdkStatus({ cdk: req.params.cdk, status: req.body?.status,
            shipped: req.body?.shipped, expectedStatus: req.body?.expected_status, expectedShipped: req.body?.expected_shipped,
            reason: req.body?.reason, adminEmail: req.admin.email });
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, ...result, message: result.redemptionChanged
            ? '卡密状态已保存并核销，商城通知已入队；最多发送 3 次（含首次），失败记录保留'
            : result.changed ? '卡密状态已保存' : '卡密状态未变化，无需重复修改' });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, message: error.message });
    }
});
app.delete('/api/admin/cdks/:cdk', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        await store.deleteCdk(req.params.cdk);
        res.json({ success: true, message: 'CDK 已删除' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
return { authenticateAdmin };
};
