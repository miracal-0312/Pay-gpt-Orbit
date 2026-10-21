'use strict';

const { validOrder } = require('./orbitcard-cdk');
const { PROVIDER_PLANS, paymentPlan } = require('./plan-registry');
const { CardPreparationError } = require('./orbitcard-card-policy');
const { parseSession } = require('./session-input');
const { paymentRegion } = require('./orbitcard-config');

// Shared by self-service, administrator orders and recovery. Persistence and
// atomic submission claims belong to the caller; this service never retries a POST.
module.exports = function createSubscriptionService(provider) {
    async function requirePlan(cfg, planType) {
        const plan = PROVIDER_PLANS[paymentPlan(planType)];
        const result = await provider.fetchPlans(cfg);
        if (!result.success) throw new CardPreparationError(result.error || 'Orbitcard 套餐查询失败，请稍后重试');
        if (!(result.plans || []).some(item => item.type === plan)) throw new CardPreparationError('Orbitcard 当前未开放此套餐');
        return plan;
    }
    async function requireRegion(cfg, planType) {
        const region = paymentRegion(cfg, planType);
        if (!region) return;
        const plan = PROVIDER_PLANS[paymentPlan(planType)];
        const result = await provider.request(cfg, 'getSubscriptionPaymentRegions', { plan_type: plan });
        if (!result.success) throw new CardPreparationError('默认充值地区查询失败，请稍后重试；尚未开卡、补款或提交订阅');
        if (result.data?.plan_type !== plan || !Array.isArray(result.data?.payment_regions)) {
            throw new CardPreparationError('默认充值地区返回格式或套餐不匹配，已停止支付准备');
        }
        if (!result.data.payment_regions.some(item => item?.code === region)) {
            throw new CardPreparationError(`套餐默认充值地区 ${region} 当前不可用，请管理员重新选择地区或改为平台默认`);
        }
    }
    function validate({ cfg, identity, planType, session }) {
        const plan = PROVIDER_PLANS[paymentPlan(planType)];
        if (typeof identity !== 'string' || !identity || identity.length > 128 || /[\s\x00-\x1f]/.test(identity)) {
            throw new CardPreparationError('订阅订单编号无效');
        }
        parseSession(session);
        paymentRegion(cfg, planType);
        if (cfg.orbitcard_max_fee && !/^\d+(?:\.\d+)?$/.test(cfg.orbitcard_max_fee)) throw new CardPreparationError('最高服务费必须为非负十进制金额');
        return plan;
    }
    function prepare({ cfg, identity, planType, cardId, session }) {
        const plan = validate({ cfg, identity, planType, session });
        session = parseSession(session);
        if (!Number.isSafeInteger(Number(cardId)) || Number(cardId) < 1) throw new CardPreparationError('支付卡 ID 无效');
        const body = { client_order_no: identity, plan_type: plan, card_id: Number(cardId), session_json: session, authorized: true };
        if (cfg.orbitcard_max_fee) body.max_service_fee = cfg.orbitcard_max_fee;
        const region = paymentRegion(cfg, planType);
        if (region) body.payment_region = region;
        return { body, expected: { clientOrderNo: identity, planType: plan, cardId: Number(cardId), email: session.user.email } };
    }
    async function submit(cfg, prepared) {
        const result = await provider.request(cfg, 'createSubscription', prepared.body, prepared.expected.clientOrderNo);
        const matches = validOrder(result.data, prepared.expected);
        return { rejected: !result.success && result.requestError?.submission_outcome === 'rejected',
            orderId: matches ? result.data.task_no || result.data.orderId : undefined,
            snapshot: provider.summary(result.data), retryAfterMs: result.retryAfterMs || 0 };
    }
    async function query(cfg, expected) {
        const result = await provider.request(cfg, 'getSubscription', expected.orderId
            ? { task_no: expected.orderId } : { client_order_no: expected.clientOrderNo });
        if (!result.success) return { success: false, error: result.error, retryAfterMs: result.retryAfterMs || 5000,
            stopTracking: [401,403,404].includes(result.status) || result.code === 59009 };
        if (!validOrder(result.data, expected)) return { success: false, ownershipMismatch: true,
            error: '订单归属校验失败，保留原订单和支付卡', retryAfterMs: 30000, stopTracking: true };
        const state = provider.outcome(result.data, true);
        return { success: true, state, orderId: result.data.task_no || result.data.orderId,
            snapshot: provider.summary(result.data), stage: result.data.stage,
            captcha: state === 'pending' ? provider.captcha(result.data) : null,
            retryAfterMs: result.retryAfterMs || 0 };
    }
    return { requirePlan, requireRegion, validate, prepare, submit, query };
};
