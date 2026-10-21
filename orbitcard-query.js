'use strict';
const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const { progressFor } = require('./orbitcard-cdk');
const subscription = require('./orbitcard-subscription-service')(api);
const inFlight = new Map();
const recent = new Map();

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
    for (const [key, value] of recent) if (value.until <= now) recent.delete(key);
    const pending = (async () => {
        const result = await subscription.query({ ...cfg, auditJobKey: task.job_key }, { orderId: task.gpt_api_order_id,
            clientOrderNo: task.orbitcard_client_order_no, planType: api.PLAN_MAP?.[task.orbitcard_plan_type], email: task.orbitcard_email, cardId: task.orbitcard_card_id });
        if (!result.success) return result;
        const next = progressFor(result.snapshot, result.state);
        if (next.state === 'failed' && onConfirmedFailure) {
            const recorded = await onConfirmedFailure(task, {
                clientOrderNo: task.orbitcard_client_order_no, cardId: Number(task.orbitcard_card_id),
                orderId: result.orderId, raw: JSON.stringify(result.snapshot)
            });
            require('./runtime-log').push({ jobKey: task.job_key, source: 'orbitcard', event: 'payment_attempt_failed',
                text: recorded.exhausted ? '三张卡支付均已明确失败，CDK 已锁定并转人工售后' : '原支付订单已明确失败，等待下一次尝试',
                data: { attempt: Number(task.orbitcard_retry_attempt_no || 1), card_id: Number(task.orbitcard_card_id),
                    order_id: result.orderId, applied: recorded.applied } });
            return { success: true, applied: recorded.applied, retrying: !recorded.exhausted };
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
        recent.set(task.job_key, { result, until: Date.now() + Math.max(5000, result.retryAfterMs || 0) });
        return result;
    } finally { inFlight.delete(task.job_key); }
}

module.exports = { refresh };
