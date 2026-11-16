'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const { normalizeBaseUrl } = require('../config/orbitcard-config');
const { validateRequest } = require('./orbitcard-api-contract');
const audit = require('../logging/runtime-log');
const { classifyApiError } = require('./orbitcard-error-policy');
const { sanitize } = require('../logging/log-safety');

const accountCooldowns = new Map();
const MAX_ACTIVE_REQUESTS = 32;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let activeRequests = 0;

async function request(cfg, operation, body = {}, idempotencyKey = '') {
    let spec;
    try { spec = validateRequest(operation, body, idempotencyKey); }
    catch (error) { return { success: false, error: error.message }; }
    if (spec.write) await cfg.executionGuard?.assertOwned();
    const key = String(process.env.ORBITCARD_API_KEY || '').trim();
    const secret = String(process.env.ORBITCARD_API_SECRET || '').trim();
    if (!key || !secret) return { success: false, error: '请在服务器环境变量中配置配对的 ORBITCARD_API_KEY 和 ORBITCARD_API_SECRET' };
    let url;
    try {
        url = new URL(normalizeBaseUrl(cfg.base_url));
    } catch (_) { return { success: false, error: 'Orbitcard Base URL 必须为 HTTPS 域名根地址' }; }
    const path = spec.path;
    const accountIdentity = crypto.createHash('sha256').update(`${url.origin}\n${key}`).digest('hex');
    const startedAt = Date.now();
    const record = (event, details = {}) => audit.push({
        jobKey: cfg.auditJobKey || '', source: 'orbitcard', event,
        text: `${operation} ${event}`,
        data: { operation, method: 'POST', path, plan_type: body.plan_type, card_id: body.card_id,
            card_ids: Array.isArray(body.card_ids) ? body.card_ids.filter(Number.isSafeInteger).slice(0, 20) : undefined,
            client_order_no: body.client_order_no, task_no: body.task_no,
            payment_region: body.payment_region, max_service_fee: body.max_service_fee,
            product_code: body.product_code, amount: body.amount, quantity: body.quantity,
            idempotency_key: idempotencyKey || undefined,
            elapsed_ms: Date.now() - startedAt, ...details }
    });
    for (const [identity, until] of accountCooldowns) if (until <= startedAt) accountCooldowns.delete(identity);
    const remainingCooldown=(accountCooldowns.get(accountIdentity) || 0)-Date.now();
    if(remainingCooldown>0) {
        record('request_deferred',{retry_after_ms:remainingCooldown});
        return {success:false,status:429,retryAfterMs:remainingCooldown,error:'Orbitcard 当前请求受限，请等待平台规定的重试间隔'};
    }
    // Reject excess work instead of building an unbounded queue behind a slow upstream.
    if (activeRequests >= MAX_ACTIVE_REQUESTS) return { success: false, status: 503, retryAfterMs: 5000,
        error: 'Orbitcard 请求繁忙，本次请求尚未发送，请稍后查询原订单' };
    record('request_started');
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(24).toString('base64url');
    const canonical = ['ORBITCARD-HMAC-SHA256-V1', key, timestamp, nonce, 'POST', url.host, path, '',
        crypto.createHash('sha256').update(raw).digest('hex'), idempotencyKey].join('\n');
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': key, 'X-Timestamp': timestamp,
        'X-Nonce': nonce, 'X-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex') };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    activeRequests++;
    try {
        const timeout = spec.timeout;
        const response = await axios.request({ method: 'POST', url: `${url.origin}${path}`, data: raw,
            headers, timeout, signal: AbortSignal.timeout(timeout), maxRedirects: 0,
            maxContentLength: 2 * 1024 * 1024, maxBodyLength: 256 * 1024,
            validateStatus: () => true });
        const envelope = response.data;
        const rawRequestError = envelope?.request_error || envelope?.data?.request_error;
        const success = response.status >= 200 && response.status < 300 && envelope?.code === 0 && !rawRequestError;
        const retryHeader = response.headers?.['retry-after'];
        const headerSeconds = retryHeader && !Number.isFinite(Number(retryHeader))
            ? Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000) : Number(retryHeader || 0);
        const retryHints = [headerSeconds, envelope?.request_error?.retry_after_seconds,
            envelope?.data?.request_error?.retry_after_seconds, envelope?.data?.retry_after_seconds];
        const seconds = Math.max(0, ...retryHints.map(Number).filter(Number.isFinite));
        const retryAfterMs = Math.min(MAX_COOLDOWN_MS, seconds * 1000);
        if(response.status===429) {
            if (!accountCooldowns.has(accountIdentity) && accountCooldowns.size >= 128) accountCooldowns.delete(accountCooldowns.keys().next().value);
            accountCooldowns.set(accountIdentity,Date.now()+Math.max(5000,retryAfterMs));
        }
        const requestError = safeRequestError(rawRequestError);
        const platformCode = diagnosticCode(envelope?.code);
        const disposition = success ? undefined : classifyApiError({ operation, status: response.status,
            code: platformCode, requestError, retryAfterMs });
        record('request_finished', { http_status: response.status, platform_code: platformCode,
            card_response: ['getCardList', 'cardDetail'].includes(operation) ? cardResponseShape(envelope?.data) : undefined,
            success, order: summary(envelope?.data), request_error: requestError,
            error_action: disposition?.action, retry_after_ms: retryAfterMs });
        return { success, status: response.status, code: platformCode, data: envelope?.data,
            requestError, retryAfterMs, disposition,
            error: success ? undefined : disposition.message };
    } catch (_) {
        // Axios errors contain the signed request and the customer's entire Session.
        record('request_failed', { outcome: 'unknown', error: 'network_or_audit_failure' });
        const disposition = classifyApiError({ operation });
        return { success: false, requestError: { code: 'relay_transport_unknown', source: 'relay', submission_outcome: 'unknown' },
            disposition, error: disposition.message };
    } finally { activeRequests--; }
}

// Error metadata is a small protocol vocabulary, never free-form upstream text.
// In particular a URL, JWT, serialized Session or long number cannot become a
// diagnostic code merely by appearing in an error-code field.
function diagnosticCode(value) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= 9999999999) return value;
    if (typeof value !== 'string') return undefined;
    if (/^\d{1,10}$/.test(value)) return value;
    return value.length <= 128 && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value) ? value : undefined;
}

function safeRequestError(error) {
    if (!error) return undefined;
    const result = { code: diagnosticCode(error.code) || 'relay_unclassified_error' };
    if (['relay', 'upstream', 'local'].includes(error.source)) result.source = error.source;
    if (['rejected', 'unknown'].includes(error.submission_outcome)) result.submission_outcome = error.submission_outcome;
    const upstreamCode = diagnosticCode(error.upstream_code);
    if (upstreamCode !== undefined) result.upstream_code = upstreamCode;
    if (Number.isInteger(error.upstream_http_status) && error.upstream_http_status >= 100 && error.upstream_http_status <= 599) {
        result.upstream_http_status = error.upstream_http_status;
    }
    if (Number.isFinite(error.retry_after_seconds) && error.retry_after_seconds >= 0) result.retry_after_seconds = error.retry_after_seconds;
    return result;
}

// Structure only: no card numbers, CVV, credentials or raw provider messages.
function cardResponseShape(data) {
    const container = Array.isArray(data) ? 'array' : ['list', 'items', 'cards'].find(key => Array.isArray(data?.[key]));
    const rows = container === 'array' ? data : container ? data[container] : [];
    return { container: container || (data && typeof data === 'object' ? 'object' : typeof data),
        returned_count: container ? rows.length : null,
        wrapped_count: rows.filter(row => row?.data && typeof row.data === 'object').length,
        failed_count: rows.filter(row => row?.success === false).length };
}

async function fetchPlans(cfg) {
    const res = await request(cfg, 'getSubscriptionPlans');
    if (!res.success) return res;
    const plans = res.data?.enabled === true && Array.isArray(res.data.plans)
        ? res.data.plans.map(p => ({ type: p.type, name: p.name, key: p.type, enabled: true })) : [];
    return { ...res, plans };
}

function terminalUpstreamSnapshot(data) {
    // query_source describes this read; result_source describes the saved
    // result. The provider may serve a completed upstream order as a snapshot.
    // Require all terminal indicators, not merely its local task_status.
    return data?.query_source === 'snapshot' && data.result_source === 'upstream' && !data.request_error
        && (data.status === 'failed' && data.upstream_status === 'failed' && data.subscription_succeeded === false
            || data.status === 'succeeded' && data.upstream_status === 'succeeded' && data.subscription_succeeded === true);
}

function outcome(data, detail = false) {
    // Callers must validate the original order identity before settlement.
    // Unverified snapshots and contradictory indicators remain unresolved.
    if (data?.request_error || (data?.result_source && data.result_source !== 'upstream')
        || (data?.subscription_succeeded != null && typeof data.subscription_succeeded !== 'boolean')) return 'pending';
    if (detail && data?.query_source && data.query_source !== 'upstream' && !terminalUpstreamSnapshot(data)) return 'pending';
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
        'order_no','amount','fee_amount','total_debit_amount', 'failureCode', 'failureMessage',
        'platform_code', 'http_status', 'submission_outcome', 'error_action'];
    // Correlation keys must survive byte-for-byte; generic PAN redaction would
    // corrupt a legitimate numeric order number. Reject malformed identities
    // instead of silently changing the identity used by recovery.
    const identityKeys = new Set(['task_no', 'orderId', 'client_order_no', 'order_no']);
    const result = Object.fromEntries(keys.filter(k => data?.[k] === null || ['string', 'number', 'boolean'].includes(typeof data?.[k]))
        .filter(k => !identityKeys.has(k) || typeof data[k] === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(data[k]))
        .map(k => [k, typeof data[k] === 'string' ? identityKeys.has(k) ? data[k]
            : sanitize(data[k]).replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED_URL]').slice(0, 256) : data[k]]));
    if (Number.isFinite(data?.payment?.amount) && typeof data.payment.currency === 'string') {
        result.payment = { amount: data.payment.amount, currency: data.payment.currency.slice(0, 8) };
    }
    const requestError = safeRequestError(data?.request_error);
    if (requestError) result.request_error = requestError;
    return result;
}

function captcha(data) {
    const cap = data?.captcha;
    if (data?.stage !== 'awaiting_captcha' || cap?.status !== 'pending' || Date.parse(cap.expires_at) <= Date.now() || !Number.isFinite(Date.parse(cap?.expires_at))) return null;
    try { if (new URL(cap.url).protocol !== 'https:') return null; } catch (_) { return null; }
    return { id: cap.id, url: cap.url, expires_at: cap.expires_at };
}

async function testConnection(cfg) {
    async function check(operation, action) {
        const started = Date.now();
        const result = await action();
        return { result, log: { operation, path: `/api/open/v1/${operation}`,
            checked_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
            success: result.success === true, http_status: result.status ?? null,
            platform_code: result.code ?? null, error: result.success ? null : result.error || '请求失败' } };
    }
    const [planCheck, balanceCheck] = await Promise.all([
        check('getSubscriptionPlans', () => fetchPlans(cfg)),
        check('getAccountBalance', () => request(cfg, 'getAccountBalance'))
    ]);
    const plans = planCheck.result, balance = balanceCheck.result;
    const checks = [planCheck.log, balanceCheck.log];
    if (!plans.success) return { success: false, error: `套餐查询失败: ${plans.error}`, checks };
    return { success: true, message: `Orbitcard HMAC 连接成功，可用套餐 ${plans.plans.length} 个`,
        plans: plans.plans,
        balance: balance.success ? balance.data : null,
        balanceError: balance.success ? null : balance.error, checks };
}

module.exports = { request, fetchPlans, testConnection, outcome, terminalUpstreamSnapshot, summary, captcha, safeRequestError };
