'use strict';
const api = require('./orbitcard-client');
const { validOrder, progressFor } = require('./orbitcard-cdk');
const inFlight = new Map();
const recent = new Map();

async function refresh({ cfg, task, persist, onConfirmedFailure }) {
    if (!task.orbitcard_client_order_no) throw new Error('该任务未绑定 Orbitcard 订单');
    if (String(cfg.base_url || '').replace(/\/+$/, '') !== String(task.orbitcard_base_url || '').replace(/\/+$/, '')) {
        throw new Error('当前 API 地址与原订单平台不同，请恢复原平台配置后查单');
    }
    if (inFlight.has(task.job_key)) return inFlight.get(task.job_key);
    const now = Date.now();
    const cached = recent.get(task.job_key);
    if (cached?.until > now) return { ...cached.result, retryAfterMs: cached.until - now };
    for (const [key, value] of recent) if (value.until <= now) recent.delete(key);
    const pending = (async () => {
        const result = await api.request({ ...cfg, auditJobKey: task.job_key }, 'getSubscription', task.gpt_api_order_id
            ? { task_no: task.gpt_api_order_id } : { client_order_no: task.orbitcard_client_order_no });
        if (!result.success) return { success: false, error: result.error, retryAfterMs: result.retryAfterMs || 5000,
            stopTracking: [401,403,404].includes(result.status) || result.code === 59009 };
        if (!validOrder(result.data, { orderId: task.gpt_api_order_id,
            clientOrderNo: task.orbitcard_client_order_no, planType: api.PLAN_MAP[task.orbitcard_plan_type], email: task.orbitcard_email, cardId: task.orbitcard_card_id })) {
            return { success: false, error: '订单归属校验失败，CDK 保持占用', retryAfterMs: 30000, stopTracking: true };
        }
        const next = progressFor(result.data);
        if (next.state === 'failed' && onConfirmedFailure) {
            const recorded = await onConfirmedFailure(task, {
                clientOrderNo: task.orbitcard_client_order_no, cardId: Number(task.orbitcard_card_id),
                orderId: result.data.orderId || result.data.task_no, raw: JSON.stringify(api.summary(result.data))
            });
            require('./runtime-log').push({ jobKey: task.job_key, source: 'orbitcard', event: 'payment_attempt_failed',
                text: recorded.exhausted ? '三张卡支付均已明确失败，CDK 已锁定并转人工售后' : '原支付订单已明确失败，等待下一次尝试',
                data: { attempt: Number(task.orbitcard_retry_attempt_no || 1), card_id: Number(task.orbitcard_card_id),
                    order_id: result.data.orderId || result.data.task_no, applied: recorded.applied } });
            return { success: true, applied: recorded.applied, retrying: !recorded.exhausted };
        }
        const update = { status: next.status, progress: next.progress, message: next.message,
            orbitcardState: next.state, gptApiOrderId: result.data.orderId || result.data.task_no,
            gptApiRaw: JSON.stringify(api.summary(result.data)) };
        const saved = await persist(task.job_key, update);
        require('./runtime-log').push({ jobKey: task.job_key, source: 'orbitcard', event: 'reconciled',
            text: next.message, data: { status: next.status, applied: saved.applied, order: api.summary(result.data) } });
        return { success: true, applied: saved.applied, captcha: api.outcome(result.data, true) === 'pending' ? api.captcha(result.data) : null };
    })();
    inFlight.set(task.job_key, pending);
    try {
        const result = await pending;
        recent.set(task.job_key, { result, until: Date.now() + Math.max(5000, result.retryAfterMs || 0) });
        return result;
    } finally { inFlight.delete(task.job_key); }
}

module.exports = { refresh };
