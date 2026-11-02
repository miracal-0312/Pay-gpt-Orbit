'use strict';

const axios = require('axios');
let activeRequests = 0;
const MAX_ACTIVE_REQUESTS = 8;

const EVENT_LABELS = {
    success: '✅ 开通成功',
    failure: '❌ 开通失败',
    pending: '⏳ 订阅结果待确认',
    admin_login_success: '🔐 后台登录成功',
    admin_login_failed: '⛔ 后台登录失败',
    admin_2fa_failed: '⛔ 后台二次验证失败',
    admin_secondary_success: '🔒 敏感模块已解锁'
};

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatTelegramMessage(event, fields) {
    const title = EVENT_LABELS[event] || '📢 系统通知';
    const lines = [title, ''];
    for (const [key, label] of [['email', '账号'], ['ip', 'IP'], ['fingerprint', '指纹'], ['userAgent', '浏览器'],
        ['method', '验证方式'], ['cdk', 'CDK'], ['jobKey', '任务'], ['message', '详情']]) {
        if (!fields[key]) continue;
        const value = key === 'userAgent' ? String(fields[key]).slice(0, 120) : fields[key];
        lines.push(`${label}: ${escapeHtml(value)}`);
    }
    return lines.join('\n');
}

async function sendTelegramMessage(botToken, chatId, text) {
    const token = String(botToken || '').trim();
    const chat = String(chatId || '').trim();
    if (!token || !chat) {
        return { ok: false, error: '缺少 Bot Token 或 Chat ID' };
    }
    if (activeRequests >= MAX_ACTIVE_REQUESTS) return { ok: false, error: 'Telegram 通知繁忙，请稍后重试' };
    activeRequests++;
    try {
        const response = await axios.post(
            `https://api.telegram.org/bot${token}/sendMessage`,
            {
                chat_id: chat,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            },
            { timeout: 15000, signal: AbortSignal.timeout(15000), maxRedirects: 0,
                maxContentLength: 16384, maxBodyLength: 32768 }
        );
        return { ok: Boolean(response.data?.ok), error: response.data?.description || '' };
    } catch (error) {
        const detail = error.response?.data?.description || error.message;
        return { ok: false, error: detail };
    } finally { activeRequests--; }
}

function shouldNotifyEvent(settings, event) {
    if (!settings?.bot_token) {
        return false;
    }
    if (['admin_login_success', 'admin_login_failed', 'admin_2fa_failed', 'admin_secondary_success'].includes(event)) {
        return Boolean(settings.on_admin_login ?? settings.notify_admin);
    }
    if (event === 'success') {
        return Boolean(settings.on_success);
    }
    if (event === 'failure' || event === 'pending') {
        return Boolean(settings.on_failure);
    }
    return false;
}

function getTargetChatIds(settings) {
    const targets = [];
    if (settings.notify_admin && settings.admin_chat_id) {
        targets.push({ label: 'admin', chatId: settings.admin_chat_id });
    }
    if (settings.notify_group && settings.group_chat_id) {
        targets.push({ label: 'group', chatId: settings.group_chat_id });
    }
    return targets.filter((target, index) => targets.findIndex(item => String(item.chatId).trim() === String(target.chatId).trim()) === index);
}

async function dispatchTelegramNotification(settings, event, payload = {}) {
    if (!shouldNotifyEvent(settings, event)) {
        return { sent: 0, skipped: true };
    }

    const targets = getTargetChatIds(settings);
    if (targets.length === 0) {
        return { sent: 0, skipped: true, reason: 'no_targets' };
    }

    const text = formatTelegramMessage(event, payload);
    const results = await sendToTargets(settings, targets, text);

    const sent = results.filter((item) => item.ok).length;
    const errors = results.filter((item) => !item.ok).map((item) => `${item.label}: ${item.error}`);
    return { sent, errors, results };
}

function sendToTargets(settings, targets, text) {
    return Promise.all(targets.map(async target => ({
        ...target, ...await sendTelegramMessage(settings.bot_token, target.chatId, text)
    })));
}

async function notifyAdminSecurityEvent(store, event, payload = {}) {
    const settings = await store.getTelegramConfig();
    const authConfig = await store.getAdminAuthConfig();
    if (!authConfig.notifyAdminLogin) {
        return { sent: 0, skipped: true, reason: 'disabled' };
    }
    return dispatchTelegramNotification(settings, event, payload);
}

async function sendTelegramLoginCode(store, code, meta = {}) {
    const settings = await store.getTelegramConfig();
    if (!settings.bot_token || !settings.admin_chat_id) {
        return { ok: false, error: '未配置 Telegram Bot 或管理员 Chat ID' };
    }
    const lines = [
        '🔐 后台登录验证码',
        '',
        `验证码: <b>${escapeHtml(code)}</b>`,
        '5 分钟内有效，请勿泄露。',
    ];
    if (meta.ip) {
        lines.push(`IP: ${escapeHtml(meta.ip)}`);
    }
    if (meta.email) {
        lines.push(`账号: ${escapeHtml(meta.email)}`);
    }
    return sendTelegramMessage(settings.bot_token, settings.admin_chat_id, lines.join('\n'));
}

async function notifyTelegramEvent(store, event, payload = {}) {
    const settings = await store.getTelegramConfig();
    return dispatchTelegramNotification(settings, event, payload);
}

async function sendTelegramTest(store, payload = {}) {
    const settings = await store.getTelegramConfig();
    if (!settings.bot_token) {
        return { success: false, message: '请先填写 Bot Token' };
    }

    const targets = getTargetChatIds(settings);
    if (targets.length === 0) {
        return { success: false, message: '请至少开启「通知管理员」或「通知群组」并填写对应 Chat ID' };
    }

    const text = formatTelegramMessage('success', {
        email: payload.email || 'test@example.com',
        cdk: payload.cdk || 'TEST-CDK-DEMO',
        jobKey: payload.jobKey || 'test-job',
        message: '这是一条 Telegram 通知测试消息'
    });

    const results = await sendToTargets(settings, targets, text);

    const failed = results.filter((item) => !item.ok);
    if (failed.length > 0) {
        return {
            success: false,
            message: failed.map((item) => `${item.label}: ${item.error}`).join('；')
        };
    }

    return { success: true, message: `测试消息已发送到 ${results.length} 个目标` };
}

module.exports = {
    formatTelegramMessage,
    sendTelegramMessage,
    dispatchTelegramNotification,
    notifyTelegramEvent,
    notifyAdminSecurityEvent,
    sendTelegramLoginCode,
    sendTelegramTest
};
