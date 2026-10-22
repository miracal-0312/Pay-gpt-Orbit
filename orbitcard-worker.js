'use strict';

const api = require('./orbitcard-client');
const { clientOrderNo: makeClientOrderNo } = require('./orbitcard-cdk');
const subscription = require('./orbitcard-subscription-service')(api, entry => require('./runtime-log').push(entry));

async function run({ cfg, planType, session, cdk, setProgress, onSubmission, broadcast, sleep,
    maxPolls = 180, intervalMs = 5000, onConfirmedFailure, onRejectedSubmission,
    clientOrderNo, attemptKey = 'legacy', selectCard }) {
    const plan = api.PLAN_MAP[planType];
    if (!plan) throw new Error(`Orbitcard 尚不支持当前 CDK 套餐: ${planType}`);
    const identity = clientOrderNo || makeClientOrderNo(cdk, attemptKey);
    subscription.validate({ cfg, identity, planType, session });
    if (!String(process.env.ORBITCARD_API_SECRET || '').trim()) throw new Error('服务端尚未配置 ORBITCARD_API_SECRET');
    await subscription.requirePlan(cfg, planType);
    await subscription.requireRegion(cfg, planType);
    if (typeof selectCard !== 'function') throw new Error('自动选卡服务尚未初始化');
    const cardId = Number(await selectCard());
    if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new Error('自动选卡未返回有效平台卡 ID');
    // Fixed within an attempt; a confirmed failed attempt can use a new identity.
    const prepared = subscription.prepare({ cfg, identity, planType, cardId, session });
    // Persist the binding before any remote write, so a crash can only trigger a query.
    await setProgress('running', 20, '正在提交 Orbitcard 订阅订单...', {
        orbitcardState: 'submitting', expectedState: 'prepared', expectedClientOrderNo: identity
    });
    await onSubmission();
    const created = await subscription.submit(cfg, prepared);
    // A create error may include a different or partial task snapshot. Query by our
    // durable client identity until the task number is proven to belong to this order.
    let orderId = created.orderId;
    let last = created.snapshot;
    // Nonzero create codes may still carry an accepted order. Never infer failure from HTTP/code.
    if (created.rejected) {
        if (onRejectedSubmission) return onRejectedSubmission({ clientOrderNo: identity, cardId, orderId,
            raw: JSON.stringify(last) });
        await setProgress('failed', 0, 'Orbitcard 已确认拒绝提交，CDK 已释放，请检查配置和 Session 后重试', {
            orbitcardState: 'rejected', gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last)
        });
        return true;
    }
    await setProgress('running', 35, 'Orbitcard 订单已提交，正在确认结果...', {
        orbitcardState: 'pending', gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last)
    });
    const deadline = Date.now() + 15 * 60 * 1000;
    let delay = Math.max(5000, intervalMs, created.retryAfterMs || 0);
    for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll++) {
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        if (Date.now() >= deadline) break;
        const result = await subscription.query(cfg, { ...prepared.expected, orderId });
        if (!result.success) {
            broadcast(null);
            delay = Math.max(5000, Math.min(delay * 2, 30000), result.retryAfterMs || 0);
            if (result.ownershipMismatch) require('./runtime-log').push({ jobKey: cfg.auditJobKey || '', source: 'orbitcard',
                event: 'ownership_mismatch', text: '订单归属校验失败，保留 CDK 和原订单' });
            if (result.stopTracking) break;
            continue;
        }
        orderId = result.orderId;
        last = result.snapshot;
        const status = result.state;
        broadcast(result.captcha);
        if (status !== 'pending') {
            if (status === 'failed' && onConfirmedFailure) {
                return onConfirmedFailure({ clientOrderNo: identity, cardId, orderId,
                    raw: JSON.stringify(last) });
            }
            await setProgress(status, status === 'success' ? 100 : 99,
                status === 'success' ? 'Orbitcard 订阅成功，CDK 已核销' : 'Orbitcard 已确认订阅失败，CDK 已释放，可更新 Session 后重试',
                { orbitcardState: status, gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last) });
            return status === 'failed';
        }
        await setProgress('running', Math.min(95, 40 + poll),
            result.stage === 'awaiting_captcha' ? '请完成人机验证，系统将继续查询原订单' : 'Orbitcard 正在处理订阅...',
            { orbitcardState: 'pending', gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last) });
        delay = Math.max(5000, intervalMs, result.retryAfterMs || 0);
    }
    broadcast(null);
    await setProgress('manual', 99, 'Orbitcard 结果待确认，已保留订单和 CDK，请联系管理员查询原订单，勿重复支付',
        { orbitcardState: 'manual', gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last) });
    return false;
}

module.exports = { run };
