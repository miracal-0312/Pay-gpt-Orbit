'use strict';
const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const { progressFor } = require('./orbitcard-cdk');
const { PROVIDER_PLANS, paymentPlan } = require('./plan-registry');
const subscription = require('./orbitcard-subscription-service')(api);
const inFlight = new Map();
const recent = new Map();
const MAX_RECENT_QUERIES = 1000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;
function pruneRecent() {
    const now = Date.now();
    for (const [key, value] of recent) if (value.until <= now) recent.delete(key);
}
// Expired CAPTCHA/query results should also be released when traffic stops.
const cleanupTimer = setInterval(pruneRecent, 30000);
cleanupTimer.unref();

async function refresh({ cfg, task, persist, onConfirmedFailure }) {
    if (!task.orbitcard_client_order_no) throw new Error('该任务未绑定 Orbitcard 订单');
    if (String(cfg.base_url || '').replace(/\/+$/, '') !== String(task.orbitcard_base_url || '').replace(/\/+$/, '')) {
        throw new Error('当前 API 地址与原订单平台不同，请恢复原平台配置后查单');
    }
    // Check before in-flight/cache reuse too; a new account cannot adopt an old order.
    if (task.orbitcard_api_key_hash && task.orbitcard_api_key_hash !== crypto.createHash('sha256')
        .update(String(cfg.api_key || '')).digest('hex')) {
        throw new Error('当前 API Key 与原订单不同，请恢复原凭据后查单');
    }
    if (inFlight.has(task.job_key)) return inFlight.get(task.job_key);
    const now = Date.now();
    const cached = recent.get(task.job_key);
    if (cached?.until > now) return { ...cached.result, retryAfterMs: cached.until - now };
    pruneRecent();
    const pending = (async () => {
        const result = await subscription.query({ ...cfg, auditJobKey: task.job_key }, { orderId: task.gpt_api_order_id,
            clientOrderNo: task.orbitcard_client_order_no, planType: PROVIDER_PLANS[paymentPlan(task.orbitcard_plan_type)], email: task.orbitcard_email, cardId: task.orbitcard_card_id });
        if (!result.success) return result;
        const next = progressFor(result.snapshot, result.state);
        if (next.state === 'failed' && onConfirmedFailure) {
            const recorded = await onConfirmedFailure(task, {
                clientOrderNo: task.orbitcard_client_order_no, cardId: Number(task.orbitcard_card_id),
                orderId: result.orderId, raw: JSON.stringify(result.snapshot)
            });
            require('./runtime-log').push({ jobKey: task.job_key, source: 'orbitcard', event: 'payment_attempt_failed',
                text: recorded.retry ? '订阅已明确失败，等待最新 Session 换卡重试' : '订阅已明确失败，换卡尝试已结束',
                data: { attempt: Number(task.orbitcard_retry_attempt_no || 1), card_id: Number(task.orbitcard_card_id),
                    order_id: result.orderId, applied: recorded.applied } });
            return { success: true, applied: recorded.applied };
        }
        const update = { status: next.status, progress: next.progress, message: next.message,
            orbitcardState: next.state, gptApiOrderId: result.orderId,
            gptApiRaw: JSON.stringify(result.snapshot) };
        const saved = await persist(task.job_key, update);
        require('./runtime-log').push({ jobKey: task.job_key, source: 'orbitcard', event: 'reconciled',
            text: next.message, data: { status: next.status, applied: saved.applied, order: result.snapshot } });
        return { success: true, applied: saved.applied, captcha: result.captcha, retryAfterMs: result.retryAfterMs };
    })();
    inFlight.set(task.job_key, pending);
    try {
        const result = await pending;
        if (!recent.has(task.job_key) && recent.size >= MAX_RECENT_QUERIES) recent.delete(recent.keys().next().value);
        const delay = Math.max(5000, Math.min(MAX_RETRY_MS, Number(result.retryAfterMs) || 0));
        recent.set(task.job_key, { result, until: Date.now() + delay });
        return result;
    } finally { inFlight.delete(task.job_key); }
}

module.exports = { refresh };
