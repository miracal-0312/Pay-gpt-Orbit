'use strict';

const api = require('./orbitcard-client');
const { clientOrderNo: makeClientOrderNo, validOrder } = require('./orbitcard-cdk');

async function run({ cfg, planType, session, cdk, setProgress, onSubmission, broadcast, sleep,
    maxPolls = 180, intervalMs = 5000, onOutcome = () => {}, clientOrderNo, attemptKey = 'legacy' }) {
    const plan = api.PLAN_MAP[planType];
    if (!plan) throw new Error(`Orbitcard 尚不支持当前 CDK 套餐: ${planType}`);
    if (!session || typeof session !== 'object' || !(session.accessToken || session.access_token) || !session.user || !session.account) {
        throw new Error('Orbitcard 需要目标账号完整 Session JSON（含 user、account、accessToken）');
    }
    if (!process.env.ORBITCARD_API_SECRET) throw new Error('服务端尚未配置 ORBITCARD_API_SECRET');
    const cardId = Number(cfg.orbitcard_card_id);
    if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new Error('请先配置 Orbitcard 平台卡 ID');
    const plans = await api.fetchPlans(cfg);
    if (!plans.success || !plans.plans.some(p => p.type === plan)) throw new Error('Orbitcard 当前未开放此套餐或套餐查询失败');
    const regions = await api.request(cfg, 'getSubscriptionPaymentRegions', { plan_type: plan });
    if (!regions.success) throw new Error('Orbitcard 支付地区查询失败，请稍后重试');
    const options = regions.data?.payment_regions || [];
    const region = cfg.orbitcard_region || options.find(r => r.default)?.code || options[0]?.code;
    if (!region || !options.some(r => r.code === region)) throw new Error('Orbitcard 当前套餐不支持所选支付地区');
    if (cfg.orbitcard_max_fee && !/^\d+(?:\.\d+)?$/.test(cfg.orbitcard_max_fee)) throw new Error('最高服务费必须为非负十进制金额');
    // Fixed within an attempt; a confirmed failed attempt can use a new identity.
    const identity = clientOrderNo || makeClientOrderNo(cdk, attemptKey);
    const body = { client_order_no: identity, plan_type: plan, card_id: cardId, session_json: session,
        authorized: true, payment_region: region };
    if (cfg.orbitcard_max_fee) body.max_service_fee = cfg.orbitcard_max_fee;
    // Persist the binding before any remote write, so a crash can only trigger a query.
    await setProgress('running', 20, '正在提交 Orbitcard 订阅订单...', { orbitcardState: 'submitting' });
    await onSubmission();
    const created = await api.request(cfg, 'createSubscription', body, identity);
    let orderId = created.data?.task_no || created.data?.orderId;
    let last = api.summary(created.data);
    // Nonzero create codes may still carry an accepted order. Never infer failure from HTTP/code.
    if (!created.success && created.requestError?.submission_outcome === 'rejected') {
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
        const result = await api.request(cfg, 'getSubscription', orderId ? { task_no: orderId } : { client_order_no: identity });
        if (!result.success) {
            broadcast(null);
            delay = Math.max(5000, Math.min(delay * 2, 30000), result.retryAfterMs || 0);
            if (result.status === 404 || result.status === 401 || result.status === 403) break;
            continue;
        }
        const data = result.data;
        const receivedId = data?.orderId || data?.task_no;
        if (!validOrder(data, { orderId, clientOrderNo: identity, planType: plan, email: session.user.email })) break;
        orderId = receivedId;
        last = api.summary(data);
        const status = api.outcome(data, true);
        broadcast(status === 'pending' ? api.captcha(data) : null);
        if (status !== 'pending') {
            await setProgress(status, status === 'success' ? 100 : 99,
                status === 'success' ? 'Orbitcard 订阅成功，CDK 已核销' : 'Orbitcard 已确认订阅失败，CDK 已释放，可更新 Session 后重试',
                { orbitcardState: status, gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last) });
            onOutcome(status);
            return status === 'failed';
        }
        await setProgress('running', Math.min(95, 40 + poll),
            data.stage === 'awaiting_captcha' ? '请完成人机验证，系统将继续查询原订单' : 'Orbitcard 正在处理订阅...',
            { orbitcardState: 'pending', gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last) });
        delay = Math.max(5000, intervalMs);
    }
    broadcast(null);
    await setProgress('manual', 99, 'Orbitcard 结果待确认，已保留订单和 CDK，请联系管理员查询原订单，勿重复支付',
        { orbitcardState: 'manual', gptApiOrderId: orderId, gptApiRaw: JSON.stringify(last) });
    return false;
}

module.exports = { run };
