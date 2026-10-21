'use strict';

const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const cardsApi = require('./orbitcard-cards-client');
const { parseSession } = require('./session-input');
const { validOrder } = require('./orbitcard-cdk');
const { cardScope, CardPreparationError } = require('./orbitcard-card-policy');

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const CDK_PLAN = Object.freeze({ 'gpt-plus': 'plus', 'gpt-pro-5x': 'pro100',
    'gpt-pro-20x': 'pro200', 'gpt-pro-25x': 'pro500' });
const SUPPORTED_PLANS = Object.freeze(Object.keys(CDK_PLAN));
const CDK_CODE = /^[A-Za-z0-9_-]{4,32}$/;

class ManualOrderError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

module.exports = function createManualService({ store, activeJobs, audit, provider = api, cards = cardsApi }) {
    const inFlight = new Set(), challenges = new Map();
    let recovering = false;
    const record = (order, event, text, data = {}) => audit({ jobKey: order?.client_order_no || '', source: 'orbitcard', event, text, data });

    async function config() {
        const cfg = await store.getGptApiConfig();
        if (!String(cfg?.api_key || process.env.ORBITCARD_API_KEY || '').trim()
            || !String(process.env.ORBITCARD_API_SECRET || '').trim()) {
            throw new ManualOrderError('请先在环境变量中配置 Orbitcard API Key 与 Secret', 503);
        }
        return cfg;
    }

    async function plans(cfg) {
        const result = await provider.fetchPlans(cfg);
        if (!result.success) throw new ManualOrderError(result.error || '卡台套餐读取失败，请稍后重试', 503);
        const seen = new Set();
        return (result.plans || []).filter(item => {
            if (!item || typeof item.type !== 'string' || !SUPPORTED_PLANS.includes(item.type) || seen.has(item.type)) return false;
            seen.add(item.type); return true;
        }).map(item => ({ type: item.type, name: String(item.name || item.type).slice(0, 128) }));
    }

    function publicOrder(order) {
        if (!order) return null;
        let snapshot = null;
        try { snapshot = order.snapshot ? JSON.parse(order.snapshot) : null; } catch (_) { /* historical malformed snapshot */ }
        return { request_id: order.request_id, client_order_no: order.client_order_no,
            task_no: order.task_no || null, plan_type: order.plan_type, plan_name: order.plan_name,
            target_email: order.target_email, card_id: Number(order.card_id), state: order.state,
            mode: order.mode, cdk_code: order.cdk_code || null,
            message: order.message || '', order: snapshot, created_at: order.created_at, updated_at: order.updated_at,
            captcha: challenges.get(order.request_id) || null };
    }

    async function catalog() {
        const cfg = await config();
        let availablePlans, listedCards, savedCards, liveCards;
        try {
            [availablePlans, listedCards, savedCards] = await Promise.all([
                plans(cfg), cards.listCards(cfg), store.cardMethods(cfg.base_url).listCards()
            ]);
            liveCards = await cards.cardDetailsInBatches(cfg, listedCards.map(card => card.card_id));
        } catch (error) {
            if (error instanceof CardPreparationError) throw new ManualOrderError(error.message, 503);
            throw error;
        }
        const saved = new Map(savedCards.map(row => [Number(row.card_id), row]));
        return { plans: availablePlans, cards: liveCards.map(card => {
            const row = saved.get(card.card_id);
            return { card_id: card.card_id, last4: card.last4, provider_status: card.provider_status,
                balance: card.balance_amount, currency: card.currency,
                history_confirmed: Boolean(row?.history_confirmed), busy: Boolean(row?.active_job),
                usage: row ? Object.fromEntries(['plus','pro100','pro200','pro500'].map(plan => [plan, Number(row[`successful_${plan}`])])) : null };
        }) };
    }

    async function list() { return (await store.listManualOrders()).map(publicOrder); }
    async function get(requestId) { return publicOrder(await store.getManualOrder(requestId)); }

    function matches(order, { planType, targetEmail, cardId, cfg }) {
        const hash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
        return order.plan_type === planType && order.target_email === targetEmail
            && Number(order.card_id) === cardId && order.api_key_hash === hash
            && order.scope === cardScope(cfg.base_url);
    }

    async function create({ requestId, planType, cardId, mode, cdkCode, session: rawSession, authorized, adminEmail }) {
        if (!REQUEST_ID.test(String(requestId || ''))) throw new ManualOrderError('请使用有效的请求编号');
        if (typeof planType !== 'string' || !PLAN_ID.test(planType)) throw new ManualOrderError('请选择有效的卡台套餐');
        if (!['test', 'fulfillment'].includes(mode)) throw new ManualOrderError('请选择测试开通或人工交付模式');
        const code = String(cdkCode || '').trim();
        if (mode === 'fulfillment' && !CDK_CODE.test(code)) throw new ManualOrderError('人工交付必须填写有效 CDK');
        if (mode === 'test' && code) throw new ManualOrderError('测试开通不能填写 CDK');
        const id = cards.positiveId(cardId);
        if (!id) throw new ManualOrderError('请选择有效的支付卡');
        if (authorized !== true) throw new ManualOrderError('请先确认已取得目标账号的订阅支付授权');
        let session;
        try { session = parseSession(rawSession); }
        catch (error) { throw new ManualOrderError(error.message); }
        const cfg = await config(), email = session.user.email.trim().toLowerCase();
        const keyHash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
        let existing = await store.getManualOrder(requestId);
        if (existing && (!matches(existing, { planType, targetEmail: email, cardId: id, cfg })
            || existing.mode !== mode || (existing.cdk_code || '') !== code)) {
            throw new ManualOrderError('此请求编号已用于另一笔管理员订单', 409);
        }
        if (existing && existing.state !== 'prepared') return publicOrder(existing);
        const enabled = await plans(cfg);
        const selected = enabled.find(item => item.type === planType);
        if (!selected) throw new ManualOrderError('卡台当前未对该 API Key 开放此套餐', 409);
        if (activeJobs.size >= await store.getMaxConcurrentActivations()) {
            throw new ManualOrderError('当前充值任务已满，请稍后重试', 429);
        }
        const slot = `manual-accept-${crypto.randomUUID()}`;
        activeJobs.add(slot);
        try {
            if (!existing) {
                try {
                    const created = await store.withCardAllocationLock(cfg.base_url, async locked => {
                        const listed = await cards.listCards(cfg);
                        if (!listed.some(card => card.card_id === id)) throw new ManualOrderError('所选卡不在当前卡台账户中', 409);
                        const detailed = await cards.cardDetailsInBatches(cfg, listed.map(card => card.card_id));
                        const detail = detailed.find(card => card.card_id === id);
                        if (!detail || detail.provider_status !== 'ACTIVE' || detail.currency !== 'USD'
                            || detail.balance_amount === null || Number(detail.balance_amount) <= 0) {
                            throw new ManualOrderError('所选卡不可用或没有可用 USD 余额，请先检查卡台余额', 409);
                        }
                        await locked.syncCards([detail]);
                        return store.createManualOrder({ requestId, planType, planName: selected.name,
                            targetEmail: email, cardId: id, baseUrl: cfg.base_url, apiKeyHash: keyHash,
                            adminEmail: String(adminEmail || '').slice(0, 128), mode, cdkCode: code || null,
                            acceptedCdkPlans: [planType, CDK_PLAN[planType]].filter(Boolean) });
                    });
                    existing = created.order;
                } catch (error) {
                    if (error instanceof ManualOrderError) throw error;
                    if (error instanceof CardPreparationError || /请求编号|待确认管理员订单|支付卡|次数已达到上限|CDK|卡密/.test(error.message)) {
                        throw new ManualOrderError(error.message, 409);
                    }
                    throw error;
                }
            }
            if (!existing) throw new Error('管理员订单未能保存');
            if (!matches(existing, { planType, targetEmail: email, cardId: id, cfg })
                || existing.mode !== mode || (existing.cdk_code || '') !== code) {
                throw new ManualOrderError('此请求编号已用于另一笔管理员订单', 409);
            }
            if (await store.claimManualSubmission(requestId)) {
                activeJobs.delete(slot);
                activeJobs.add(existing.client_order_no);
                const job = submit(existing, cfg, session);
                job.catch(() => {}).finally(() => activeJobs.delete(existing.client_order_no));
                record(existing, 'manual_order_accepted', '管理员订单已保存并认领提交',
                    { plan_type: planType, card_id: id, target_email: email, mode, cdk_code: code || undefined });
            }
            return publicOrder(await store.getManualOrder(requestId));
        } finally { activeJobs.delete(slot); }
    }

    async function submit(order, cfg, session) {
        const identity = order.client_order_no;
        try {
            const body = { client_order_no: identity, plan_type: order.plan_type,
                card_id: Number(order.card_id), session_json: session, authorized: true };
            if (cfg.orbitcard_max_fee) body.max_service_fee = cfg.orbitcard_max_fee;
            const result = await provider.request({ ...cfg, auditJobKey: identity }, 'createSubscription', body, identity);
            const snapshot = provider.summary(result.data);
            if (!result.success && result.requestError?.submission_outcome === 'rejected') {
                await store.settleManualOrder(order.request_id, { state: 'failed', snapshot,
                    message: 'Orbitcard 明确拒绝提交；支付卡已释放，请核对 Session 与配置' });
                record(order, 'manual_order_rejected', '卡台明确拒绝管理员订单');
                return;
            }
            const valid = validOrder(result.data, { clientOrderNo: identity, planType: order.plan_type,
                email: order.target_email, cardId: Number(order.card_id) });
            await store.settleManualOrder(order.request_id, { state: 'pending',
                taskNo: valid ? result.data.task_no || result.data.orderId : null, snapshot,
                message: '已提交或结果待确认；只查询原订单，不重复创建' });
            record(order, 'manual_order_submitted', '管理员订单已提交或状态待确认',
                { plan_type: order.plan_type, card_id: Number(order.card_id), client_order_no: identity });
            await refresh(order.request_id, cfg);
        } catch (_) {
            await store.settleManualOrder(order.request_id, { state: 'manual',
                message: '提交结果尚未确认；请查询原订单，勿重新发起付款' }).catch(() => {});
            record(order, 'manual_order_unknown', '管理员订单提交结果待核对');
        }
    }

    async function refresh(requestId, knownCfg = null) {
        if (inFlight.has(requestId)) return get(requestId);
        inFlight.add(requestId);
        try {
            const order = await store.getManualOrder(requestId);
            if (!order) throw new ManualOrderError('管理员订单不存在', 404);
            if (['success', 'failed', 'prepared'].includes(order.state)) return publicOrder(order);
            const cfg = knownCfg || await config();
            const hash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
            if (hash !== order.api_key_hash) throw new ManualOrderError('API Key 与原订单不一致，请恢复原配置后查询', 409);
            const result = await provider.request({ ...cfg, auditJobKey: order.client_order_no }, 'getSubscription',
                order.task_no ? { task_no: order.task_no } : { client_order_no: order.client_order_no });
            if (!result.success || !validOrder(result.data, { orderId: order.task_no, clientOrderNo: order.client_order_no,
                planType: order.plan_type, email: order.target_email, cardId: Number(order.card_id) })) {
                record(order, 'manual_order_query_unconfirmed', '原管理员订单尚未返回可核对的归属结果');
                return publicOrder(await store.settleManualOrder(requestId, { state: 'manual',
                    message: '原订单查询暂不可确认；保留支付卡占用，勿重新付款' }));
            }
            const state = provider.outcome(result.data, true);
            const next = state === 'success' ? 'success' : state === 'failed' ? 'failed' : 'pending';
            const captcha = provider.captcha(result.data);
            if (captcha && next === 'pending') challenges.set(requestId, captcha);
            else challenges.delete(requestId);
            const updated = await store.settleManualOrder(requestId, {
                state: next, taskNo: result.data.task_no || result.data.orderId,
                snapshot: provider.summary(result.data),
                message: next === 'success' ? 'Orbitcard 已确认开通成功' : next === 'failed'
                    ? 'Orbitcard 已确认开通失败；支付卡已释放' : captcha
                        ? '需要完成人机验证，然后继续查询原订单' : 'Orbitcard 仍在处理；继续查询原订单'
            });
            record(order, 'manual_order_query', '管理员原订单查询完成', { state: next, task_no: updated.task_no });
            return publicOrder(updated);
        } finally { inFlight.delete(requestId); }
    }

    async function recover() {
        if (recovering) return;
        recovering = true;
        try {
            for (const order of await store.listRecoverableManualOrders()) {
                if (activeJobs.has(order.client_order_no) || inFlight.has(order.request_id)) continue;
                if (order.state === 'prepared') {
                    const released = await store.abandonPreparedManualOrder(order.request_id).catch(() => null);
                    if (released) record(released, 'manual_order_prepared_abandoned', '管理员订单提交前中断，已释放 CDK 与卡片');
                    continue;
                }
                await refresh(order.request_id).catch(() => {});
            }
        } finally { recovering = false; }
    }

    return { catalog, list, get, create, refresh, recover, ManualOrderError };
};

module.exports.ManualOrderError = ManualOrderError;
