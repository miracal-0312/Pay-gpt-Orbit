'use strict';

const axios = require('axios');
const crypto = require('node:crypto');

const PLAN_MAP = Object.freeze({ plus: 'gpt-plus', pro100: 'gpt-pro-5x', pro200: 'gpt-pro-20x', pro500: 'gpt-pro-25x', pro_5x: 'gpt-pro-5x', pro_20x: 'gpt-pro-20x' });

async function request(cfg, operation, body = {}, idempotencyKey = '') {
    const key = String(cfg.api_key || '').trim();
    // Secret is intentionally never stored in app_config or returned to the browser.
    const secret = process.env.ORBITCARD_API_SECRET;
    if (!key || !secret) return { success: false, error: '请配置 API Key 和服务端 ORBITCARD_API_SECRET' };
    let url;
    try {
        url = new URL(cfg.base_url || 'https://orbitcard.cc');
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
            throw new Error();
        }
    } catch (_) { return { success: false, error: 'Orbitcard Base URL 必须为 HTTPS 域名根地址' }; }
    const path = `/api/open/v1/${operation}`;
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
            headers, timeout: operation === 'createSubscription' ? 45000 : 30000, maxRedirects: 0,
            validateStatus: () => true });
        const envelope = response.data;
        const success = response.status >= 200 && response.status < 300 && envelope?.code === 0;
        const retryHeader = response.headers?.['retry-after'];
        const headerSeconds = retryHeader && !Number.isFinite(Number(retryHeader))
            ? Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000) : Number(retryHeader || 0);
        const seconds = Math.max(headerSeconds || 0, Number(envelope?.request_error?.retry_after_seconds || envelope?.data?.request_error?.retry_after_seconds || 0));
        return { success, status: response.status, code: envelope?.code, data: envelope?.data,
            requestError: envelope?.request_error || envelope?.data?.request_error,
            retryAfterMs: Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0,
            error: success ? undefined : `Orbitcard 请求失败（HTTP ${response.status} / code ${envelope?.code ?? 'unknown'}）` };
    } catch (_) {
        // Axios errors contain the signed request and the customer's entire Session.
        return { success: false, error: 'Orbitcard 网络请求失败，结果待确认' };
    }
}

async function fetchPlans(cfg) {
    const res = await request(cfg, 'getSubscriptionPlans');
    if (!res.success) return res;
    const plans = res.data?.enabled === true && Array.isArray(res.data.plans)
        ? res.data.plans.map(p => ({ ...p, key: p.type, enabled: true })) : [];
    return { ...res, plans, gptPlans: plans, creditPlans: [] };
}

function outcome(data, detail = false) {
    const status = data?.upstream_status || (detail ? data?.status : '');
    if (status === 'succeeded' || data?.subscription_succeeded === true) return 'success';
    if (status === 'failed' || data?.subscription_succeeded === false) return 'failed';
    return 'pending';
}

// Only this allowlist may be persisted; Session and captcha tickets stay transient.
function summary(data) {
    const keys = ['task_no', 'orderId', 'client_order_no', 'plan_type', 'payment_region', 'paymentRegion',
        'status', 'upstream_status', 'subscription_succeeded', 'subscriptionCancelled', 'service_fee', 'currency',
        'fee_status', 'billing_policy', 'stage', 'query_source', 'result_source', 'error_code'];
    return Object.fromEntries(keys.filter(k => data?.[k] !== undefined).map(k => [k, data[k]]));
}

function captcha(data) {
    const cap = data?.captcha;
    if (data?.stage !== 'awaiting_captcha' || cap?.status !== 'pending' || Date.parse(cap.expires_at) <= Date.now() || !Number.isFinite(Date.parse(cap?.expires_at))) return null;
    try { if (new URL(cap.url).protocol !== 'https:') return null; } catch (_) { return null; }
    return { id: cap.id, url: cap.url, expires_at: cap.expires_at };
}

module.exports = { request, fetchPlans, outcome, summary, captcha, PLAN_MAP };
