'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULTS = Object.freeze({ enabled: false, smtp_host: '', smtp_port: 465, smtp_secure: true,
    smtp_user: '', from_email: '', to_email: '', on_low_balance: true, on_success: true, on_failure: true,
    balance_threshold: '50.00', balance_cooldown_minutes: 360, enabled_since: 0 });
const BOOLEAN_FIELDS = ['enabled', 'smtp_secure', 'on_low_balance', 'on_success', 'on_failure'];
const PASSWORD_KEY = 'email_smtp_password';
const CONFIG_KEYS = [...Object.keys(DEFAULTS).map(key => `email_${key}`), PASSWORD_KEY];
const AAD = Buffer.from('Pay-gpt-Orbit:email_smtp_password:v1');

class EmailConfigError extends Error {
    constructor(message) { super(message); this.name = 'EmailConfigError'; this.code = 'EMAIL_CONFIG_INVALID'; }
}

function string(value, label, maximum, { trim = true } = {}) {
    if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
        throw new EmailConfigError(`${label}格式无效`);
    }
    return trim ? value.trim() : value;
}

function hostname(value) {
    const host = string(value, 'SMTP 服务器', 253).toLowerCase();
    if (!host) return '';
    if (net.isIP(host)) return host;
    if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new EmailConfigError('SMTP 服务器必须填写主机名或 IP，不能填写 URL、路径或端口');
    }
    return host;
}

function email(value, label) {
    const address = string(value, label, 254);
    if (!address) return '';
    const parts = address.split('@');
    if (parts.length !== 2 || parts[0].length > 64 || parts[0].startsWith('.') || parts[0].endsWith('.')
        || parts[0].includes('..') || !/^[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(parts[0])
        || !parts[1].split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
        throw new EmailConfigError(`${label}必须是一个有效邮箱地址，不支持姓名或多个地址`);
    }
    return `${parts[0]}@${parts[1].toLowerCase()}`;
}

function integer(value, label, minimum, maximum) {
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new EmailConfigError(`${label}超出允许范围`);
    return value;
}

function threshold(value) {
    if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value.trim())) {
        throw new EmailConfigError('余额预警阈值必须是最多两位小数的非负 USD 金额');
    }
    const [whole, cents = ''] = value.trim().split('.');
    return `${BigInt(whole)}.${cents.padEnd(2, '0')}`;
}

function normalize(input, existing = DEFAULTS) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EmailConfigError('邮件配置格式无效');
    const config = { ...existing };
    for (const field of BOOLEAN_FIELDS) if (Object.hasOwn(input, field)) {
        if (typeof input[field] !== 'boolean') throw new EmailConfigError('邮件开关必须使用布尔值');
        config[field] = input[field];
    }
    if (Object.hasOwn(input, 'smtp_host')) config.smtp_host = hostname(input.smtp_host);
    if (Object.hasOwn(input, 'smtp_port')) config.smtp_port = integer(input.smtp_port, 'SMTP 端口', 1, 65535);
    if (Object.hasOwn(input, 'smtp_user')) config.smtp_user = string(input.smtp_user, 'SMTP 登录账号', 254);
    if (Object.hasOwn(input, 'from_email')) config.from_email = email(input.from_email, '发件邮箱');
    if (Object.hasOwn(input, 'to_email')) config.to_email = email(input.to_email, '管理员收件邮箱');
    if (Object.hasOwn(input, 'balance_threshold')) config.balance_threshold = threshold(input.balance_threshold);
    if (Object.hasOwn(input, 'balance_cooldown_minutes')) {
        config.balance_cooldown_minutes = integer(input.balance_cooldown_minutes, '余额预警间隔（分钟）', 1, 10080);
    }
    return config;
}

function validateSmtpConfig(config) {
    const result = normalize(config);
    result.smtp_password = string(config.smtp_password ?? '', 'SMTP 密码或授权码', 1024, { trim: false });
    if (!result.smtp_host || !result.smtp_user || !result.smtp_password || !result.from_email || !result.to_email) {
        throw new EmailConfigError('请填写 SMTP 服务器、登录账号、密码或授权码、发件邮箱及管理员收件邮箱');
    }
    return result;
}

function encryptionKey(env) {
    const secret = String(env.ADMIN_TOKEN_SECRET || '');
    if (Buffer.byteLength(secret) < 32) throw new EmailConfigError('请先配置至少 32 字节的 ADMIN_TOKEN_SECRET，再保存邮件凭据');
    return crypto.hkdfSync('sha256', Buffer.from(secret), AAD, Buffer.from('AES-256-GCM'), 32);
}

function encryptPassword(password, env) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(env), iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return ['gcm1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptPassword(value, env) {
    if (!value) return '';
    try {
        if (typeof value !== 'string' || value.length > 6000 || !/^gcm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
        const [, ivText, tagText, contentText] = value.split('.');
        const iv = Buffer.from(ivText, 'base64url'), tag = Buffer.from(tagText, 'base64url'), content = Buffer.from(contentText, 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || content.length > 4096) throw new Error();
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(env), iv);
        decipher.setAAD(AAD); decipher.setAuthTag(tag);
        return string(Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8'), 'SMTP 密码或授权码', 1024, { trim: false });
    } catch (_) {
        throw new EmailConfigError('已保存的 SMTP 凭据无法解密，请重新填写密码或授权码并保存');
    }
}

module.exports = function createEmailConfig({ getConfigValues, saveConfigValues, env = process.env, now = Date.now }) {
    async function stored() {
        const map = await getConfigValues(CONFIG_KEYS), input = {};
        for (const key of Object.keys(DEFAULTS)) if (map[`email_${key}`] != null) input[key] = map[`email_${key}`];
        for (const key of BOOLEAN_FIELDS) if (Object.hasOwn(input, key)) {
            if (!['0', '1'].includes(input[key])) throw new EmailConfigError('已保存的邮件开关无效，请检查配置');
            input[key] = input[key] === '1';
        }
        const config = normalize(input);
        config.enabled_since = input.enabled_since == null ? 0 : integer(input.enabled_since, '邮件启用时间', 0, Number.MAX_SAFE_INTEGER);
        return { config, encrypted: map[PASSWORD_KEY] || '' };
    }
    function publicConfig(config, encrypted) {
        let invalid = false;
        try { decryptPassword(encrypted, env); } catch (_) { invalid = true; }
        return { ...config, smtp_password_saved: Boolean(encrypted), smtp_password_error: invalid };
    }
    async function getEmailConfig() {
        const { config, encrypted } = await stored();
        return { ...config, smtp_password: decryptPassword(encrypted, env) };
    }
    async function getPublicEmailConfig() {
        const { config, encrypted } = await stored();
        return publicConfig(config, encrypted);
    }
    async function saveEmailConfig(input = {}) {
        const { config: existing, encrypted: saved } = await stored();
        const config = normalize(input, existing);
        if (Object.hasOwn(input, 'clear_password') && typeof input.clear_password !== 'boolean') throw new EmailConfigError('清除密码选项必须使用布尔值');
        const password = Object.hasOwn(input, 'smtp_password')
            ? string(input.smtp_password, 'SMTP 密码或授权码', 1024, { trim: false }) : '';
        let encrypted = input.clear_password ? '' : saved;
        if (password) encrypted = encryptPassword(password, env);
        if (config.enabled) validateSmtpConfig({ ...config, smtp_password: decryptPassword(encrypted, env) });
        const targetChanged = config.to_email.toLowerCase() !== existing.to_email.toLowerCase();
        if (config.enabled && (!existing.enabled || targetChanged)) {
            // A new administrator should receive future observations, not a
            // replay of orders collected for the previous recipient.
            config.enabled_since = integer(now(), '邮件启用时间', 1, Number.MAX_SAFE_INTEGER);
        }
        const values = Object.fromEntries(Object.keys(DEFAULTS).map(key => [`email_${key}`,
            BOOLEAN_FIELDS.includes(key) ? (config[key] ? '1' : '0') : String(config[key])]));
        values[PASSWORD_KEY] = encrypted;
        await saveConfigValues(values);
        return publicConfig(config, encrypted);
    }
    return { getEmailConfig, getPublicEmailConfig, saveEmailConfig };
};
module.exports.EmailConfigError = EmailConfigError;
module.exports.validateSmtpConfig = validateSmtpConfig;
