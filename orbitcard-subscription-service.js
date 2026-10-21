'use strict';

const { validOrder } = require('./orbitcard-cdk');
const { PROVIDER_PLANS, paymentPlan } = require('./plan-registry');
const { CardPreparationError } = require('./orbitcard-card-policy');
const { parseSession } = require('./session-input');
const { paymentRegion } = require('./orbitcard-config');

// Shared by self-service, administrator orders and recovery. Persistence and
// atomic submission claims belong to the caller; this service never retries a POST.
module.exports = function createSubscriptionService(provider, audit = () => {}) {
    const record = (cfg, event, text, data) => audit({ jobKey: cfg.auditJobKey || '', source: 'orbitcard', event, text, data });
    async function requirePlan(cfg, planType) {
        const plan = PROVIDER_PLANS[paymentPlan(planType)];
        const result = await provider.fetchPlans(cfg);
        if (!result.success) throw new CardPreparationError(result.error || 'Orbitcard 套餐查询失败，请稍后重试');
        if (!(result.plans || []).some(item => item.type === plan)) throw new CardPreparationError('Orbitcard 当前未开放此套餐');
        record(cfg, 'payment_plan_selected', '已核对当前支付套餐在卡台开放', { plan_type: plan });
        return plan;
    }
    async function requireRegion(cfg, planType) {
        const region = paymentRegion(cfg, planType);
        if (!region) {
            record(cfg, 'payment_region_selected', '使用卡台默认地区；下单省略地区参数', { plan_type: PROVIDER_PLANS[paymentPlan(planType)], payment_region: null });
            return;
        }
        const plan = PROVIDER_PLANS[paymentPlan(planType)];
        const result = await provider.request(cfg, 'getSubscriptionPaymentRegions', { plan_type: plan });
        if (!result.success) throw new CardPreparationError('默认充值地区查询失败，请稍后重试；尚未开卡、补款或提交订阅');
        if (result.data?.plan_type !== plan || !Array.isArray(result.data?.payment_regions)) {
            throw new CardPreparationError('默认充值地区返回格式或套餐不匹配，已停止支付准备');
        }
        if (!result.data.payment_regions.some(item => item?.code === region)) {
            throw new CardPreparationError(`套餐默认充值地区 ${region} 当前不可用，请管理员重新选择地区或改为平台默认`);
        }
        record(cfg, 'payment_region_selected', '已确认指定支付地区可用', { plan_type: plan, payment_region: region });
    }
    function validate({ cfg, identity, planType, session }) {
        const plan = PROVIDER_PLANS[paymentPlan(planType)];
        if (typeof identity !== 'string' || !identity || identity.length > 128 || /[\s\x00-\x1f]/.test(identity)) {
            throw new CardPreparationError('订阅订单编号无效');
        }
        parseSession(session);
        record(cfg, 'session_validated', 'Session 本地格式校验通过；凭据尚需卡台验证', { plan_type: plan, authentication: 'not_verified' });
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
        record(cfg, 'subscription_parameters_ready', '订阅请求参数已准备，Session 仅随创建订阅请求发送', {
            client_order_no: identity, plan_type: plan, card_id: Number(cardId), payment_region: region || null, session_attached: true
        });
        return { body, expected: { clientOrderNo: identity, planType: plan, cardId: Number(cardId), email: session.user.email } };
    }
    async function submit(cfg, prepared) {
        record(cfg, 'subscription_submission_started', '开始向卡台提交订阅及 Session；此步骤可能真实扣款', {
            client_order_no: prepared.expected.clientOrderNo, plan_type: prepared.expected.planType, card_id: prepared.expected.cardId,
            payment_region: prepared.body.payment_region || null
        });
        const result = await provider.request(cfg, 'createSubscription', prepared.body, prepared.expected.clientOrderNo);
        const matches = validOrder(result.data, prepared.expected);
        record(cfg, 'subscription_submission_returned', '创建订阅请求已返回；最终结果须查询原订单确认', {
            http_status: result.status ?? null, platform_code: result.code ?? null, success: result.success === true,
            ownership_matched: matches, submission_outcome: !result.success && result.requestError?.submission_outcome === 'rejected' ? 'rejected' : 'requires_original_order_query'
        });
        return { rejected: !result.success && result.requestError?.submission_outcome === 'rejected',
            orderId: matches ? result.data.task_no || result.data.orderId : undefined,
            snapshot: provider.summary(result.data), retryAfterMs: result.retryAfterMs || 0 };
    }
    async function query(cfg, expected) {
        const result = await provider.request(cfg, 'getSubscription', expected.orderId
            ? { task_no: expected.orderId } : { client_order_no: expected.clientOrderNo });
        if (!result.success) {
            record(cfg, 'subscription_query_unconfirmed', '原订单查询暂不可确认，保留原订单及支付卡', {
                client_order_no: expected.clientOrderNo, http_status: result.status ?? null, platform_code: result.code ?? null
            });
            return { success: false, error: result.error, retryAfterMs: result.retryAfterMs || 5000,
                stopTracking: [401,403,404].includes(result.status) || result.code === 59009 };
        }
        if (!validOrder(result.data, expected)) {
            record(cfg, 'subscription_ownership_mismatch', '订单归属不匹配，不能据此确认成功或重新付款', { client_order_no: expected.clientOrderNo });
            return { success: false, ownershipMismatch: true,
                error: '订单归属校验失败，保留原订单和支付卡', retryAfterMs: 30000, stopTracking: true };
        }
        const state = provider.outcome(result.data, true);
        record(cfg, 'subscription_result_checked', '已校验原订单归属并读取订阅结果', {
            client_order_no: expected.clientOrderNo, card_id: expected.cardId, state, order: provider.summary(result.data)
        });
        return { success: true, state, orderId: result.data.task_no || result.data.orderId,
            snapshot: provider.summary(result.data), stage: result.data.stage,
            captcha: state === 'pending' ? provider.captcha(result.data) : null,
            retryAfterMs: result.retryAfterMs || 0 };
    }
    return { requirePlan, requireRegion, validate, prepare, submit, query };
};
