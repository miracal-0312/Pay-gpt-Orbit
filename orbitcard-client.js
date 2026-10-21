'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const { DEFAULT_BASE_URL, normalizeBaseUrl } = require('./orbitcard-config');
const audit = require('./runtime-log');

const PLAN_MAP = Object.freeze({ plus: 'gpt-plus', pro100: 'gpt-pro-5x', pro200: 'gpt-pro-20x', pro500: 'gpt-pro-25x', pro_5x: 'gpt-pro-5x', pro_20x: 'gpt-pro-20x' });
const accountCooldowns = new Map();

async function request(cfg, operation, body = {}, idempotencyKey = '') {
    const key = String(cfg.api_key || '').trim();
    if (cfg.orbitcard_secret_error) return { success: false, error: '已保存的 Orbitcard API Secret 无法解密，请管理员重新填写' };
    // The UI-managed secret is decrypted server-side; legacy environment settings remain supported.
    const secret = cfg.api_secret || process.env.ORBITCARD_API_SECRET;
    if (!key || !secret) return { success: false, error: '请在后台配置配对的 API Key 和 API Secret' };
    let url;
    try {
        url = new URL(normalizeBaseUrl(cfg.base_url));
    } catch (_) { return { success: false, error: 'Orbitcard Base URL 必须为 HTTPS 域名根地址' }; }
    const path = `/api/open/v1/${operation}`;
    const accountIdentity = crypto.createHash('sha256').update(`${url.origin}\n${key}`).digest('hex');
    const startedAt = Date.now();
    const record = (event, details = {}) => audit.push({
        jobKey: cfg.auditJobKey || '', source: 'orbitcard', event,
        text: `${operation} ${event}`,
        data: { operation, plan_type: body.plan_type, card_id: body.card_id,
            client_order_no: body.client_order_no, task_no: body.task_no,
            payment_region: body.payment_region, max_service_fee: body.max_service_fee,
            product_code: body.product_code, amount: body.amount, quantity: body.quantity,
            idempotency_key: idempotencyKey || undefined,
            elapsed_ms: Date.now() - startedAt, ...details }
    });
    const remainingCooldown=(accountCooldowns.get(accountIdentity) || 0)-Date.now();
    if(remainingCooldown>0) {
        record('request_deferred',{retry_after_ms:remainingCooldown});
        return {success:false,status:429,retryAfterMs:remainingCooldown,error:'Orbitcard 当前请求受限，请等待平台规定的重试间隔'};
    }
    if(remainingCooldown<=0) accountCooldowns.delete(accountIdentity);
    record('request_started');
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(24).toString('base64url');
    const canonical = ['ORBITCARD-HMAC-SHA256-V1', key, timestamp, nonce, 'POST', url.host, path, '',
        crypto.createHash('sha256').update(raw).digest('hex'), idempotencyKey].join('\n');
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': key, 'X-Timestamp': timestamp,
        'X-Nonce': nonce, 'X-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex') };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    try {
        const response = await axios.request({ method: 'POST', url: `${url.origin}${path}`, data: raw,
            headers, timeout: ['createSubscription','createCard'].includes(operation) ? 45000 : 30000, maxRedirects: 0,
            validateStatus: () => true });
        const envelope = response.data;
        const success = response.status >= 200 && response.status < 300 && envelope?.code === 0;
        const retryHeader = response.headers?.['retry-after'];
        const headerSeconds = retryHeader && !Number.isFinite(Number(retryHeader))
            ? Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000) : Number(retryHeader || 0);
        const seconds = Math.max(headerSeconds || 0, Number(envelope?.request_error?.retry_after_seconds || envelope?.data?.request_error?.retry_after_seconds || 0), Number(envelope?.data?.retry_after_seconds || 0));
        const retryAfterMs=Number.isFinite(seconds)?Math.max(0,seconds*1000):0;
        if(response.status===429) accountCooldowns.set(accountIdentity,Date.now()+Math.max(5000,retryAfterMs));
        const requestError = envelope?.request_error || envelope?.data?.request_error;
        record('request_finished', { http_status: response.status, platform_code: envelope?.code,
            success, order: summary(envelope?.data), request_error: requestError ? {
                code: typeof requestError.code === 'string' ? requestError.code : undefined,
                submission_outcome: typeof requestError.submission_outcome === 'string' ? requestError.submission_outcome : undefined,
                source: typeof requestError.source === 'string' ? requestError.source : undefined
            } : undefined, retry_after_ms: retryAfterMs });
        return { success, status: response.status, code: envelope?.code, data: envelope?.data,
            requestError: envelope?.request_error || envelope?.data?.request_error,
            retryAfterMs,
            error: success ? undefined : [401,403].includes(response.status)
                ? `Orbitcard 认证或接口权限不足（HTTP ${response.status}），请管理员检查密钥、出口 IP 和 API 权限`
                : response.status===429 ? 'Orbitcard 请求频率受限，请按重试时间稍后查询'
                    : `Orbitcard 请求失败（HTTP ${response.status} / code ${envelope?.code ?? 'unknown'}）` };
    } catch (_) {
        // Axios errors contain the signed request and the customer's entire Session.
        record('request_failed', { outcome: 'unknown', error: 'network_or_audit_failure' });
        return { success: false, error: 'Orbitcard 网络请求失败，结果待确认' };
    }
}

async function fetchPlans(cfg) {
    const res = await request(cfg, 'getSubscriptionPlans');
    if (!res.success) return res;
    const plans = res.data?.enabled === true && Array.isArray(res.data.plans)
        ? res.data.plans.map(p => ({ type: p.type, name: p.name, key: p.type, enabled: true })) : [];
    return { ...res, plans, gptPlans: plans, creditPlans: [] };
}

function outcome(data, detail = false) {
    // A detail snapshot or contradictory indicators cannot authorize a CDK
    // settlement or a new payment attempt. Local task_status is never evidence.
    if (detail && data?.query_source && data.query_source !== 'upstream') return 'pending';
    const observed = [data?.upstream_status, detail ? data?.status : null]
        .filter(value => value !== null && value !== undefined && value !== '');
    const signal = data?.subscription_succeeded;
    if (observed.some(value => !['pending','processing','succeeded','failed'].includes(value))) return 'pending';
    if (observed.includes('pending') || observed.includes('processing')) return 'pending';
    if (observed.includes('succeeded') && observed.includes('failed')) return 'pending';
    if (observed.includes('succeeded') && signal !== false) return 'success';
    if (observed.includes('failed') && signal !== true) return 'failed';
    if (!observed.length && signal === true) return 'success';
    if (!observed.length && signal === false) return 'failed';
    return 'pending';
}

// Only this allowlist may be persisted; Session and captcha tickets stay transient.
function summary(data) {
    const keys = ['task_no', 'orderId', 'client_order_no', 'plan_type', 'payment_region', 'paymentRegion',
        'status', 'upstream_status', 'subscription_succeeded', 'subscriptionCancelled', 'service_fee', 'currency',
        'fee_status', 'billing_policy', 'stage', 'query_source', 'result_source', 'error_code', 'card_id',
        'order_no','amount','fee_amount','total_debit_amount'];
    const result = Object.fromEntries(keys.filter(k => data?.[k] === null || ['string', 'number', 'boolean'].includes(typeof data?.[k]))
        .map(k => [k, typeof data[k] === 'string' ? data[k].slice(0, 256) : data[k]]));
    if (Number.isFinite(data?.payment?.amount) && typeof data.payment.currency === 'string') {
        result.payment = { amount: data.payment.amount, currency: data.payment.currency.slice(0, 8) };
    }
    return result;
}

function captcha(data) {
    const cap = data?.captcha;
    if (data?.stage !== 'awaiting_captcha' || cap?.status !== 'pending' || Date.parse(cap.expires_at) <= Date.now() || !Number.isFinite(Date.parse(cap?.expires_at))) return null;
    try { if (new URL(cap.url).protocol !== 'https:') return null; } catch (_) { return null; }
    return { id: cap.id, url: cap.url, expires_at: cap.expires_at };
}

function maskApiKey(value) {
    const key = String(value || '').trim();
    return !key ? '' : key.length <= 8 ? '****' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

async function queryBalance(cfg) {
    return request(cfg, 'getAccountBalance');
}

async function testConnection(cfg) {
    const [plans, balance] = await Promise.all([fetchPlans(cfg), queryBalance(cfg)]);
    if (!plans.success) return { success: false, error: `套餐查询失败: ${plans.error}` };
    return { success: true, message: `Orbitcard HMAC 连接成功，可用套餐 ${plans.plans.length} 个`,
        plans: plans.plans, gptPlans: plans.gptPlans, creditPlans: [],
        balance: balance.success ? balance.data : null,
        balanceError: balance.success ? null : balance.error };
}

module.exports = { DEFAULT_BASE_URL, normalizeBaseUrl, maskApiKey, request, fetchPlans, queryBalance,
    testConnection, outcome, summary, captcha, PLAN_MAP };
