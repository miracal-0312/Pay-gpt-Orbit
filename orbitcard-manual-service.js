'use strict';

const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const { parseSession } = require('./session-input');
const { cardScope, CardPreparationError } = require('./orbitcard-card-policy');
const { PROVIDER_TO_PLAN: CDK_PLAN } = require('./plan-registry');
const { manualLockKeys } = require('./payment-execution-lock');

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SUPPORTED_PLANS = Object.freeze(Object.keys(CDK_PLAN));
const CDK_CODE = /^[A-Za-z0-9_-]{4,32}$/;

class ManualOrderError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

module.exports = function createManualService({ store, activeJobs, audit, cardService, provider = api, now = Date.now }) {
    const subscription = require('./orbitcard-subscription-service')(provider, audit);
    const inFlight = new Set(), challenges = new Map(), nextQueryAt = new Map();
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
            target_email: order.target_email, card_id: Number(order.card_id) || null, state: order.state,
            mode: order.mode, cdk_code: order.cdk_code || null,
            message: order.message || '', order: snapshot, created_at: order.created_at, updated_at: order.updated_at,
            captcha: challenges.get(order.request_id) || null };
    }

    async function catalog() {
        const cfg = await config();
        // Card details are read only when a payment is prepared. An unrelated
        // missing card must not prevent the administrator from choosing a plan.
        return { plans: await plans(cfg) };
    }

    async function list() { return (await store.listManualOrders()).map(publicOrder); }
    async function get(requestId) { return publicOrder(await store.getManualOrder(requestId)); }

    function matches(order, { planType, targetEmail, cfg }) {
        const hash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
        return order.plan_type === planType && order.target_email === targetEmail
            && order.api_key_hash === hash
            && order.scope === cardScope(cfg.base_url);
    }

    async function create(input) {
        if (!REQUEST_ID.test(String(input.requestId || ''))) throw new ManualOrderError('请使用有效的请求编号');
        const cdk = input.mode === 'fulfillment' ? String(input.cdkCode || '').trim() : null;
        if (cdk !== null && !CDK_CODE.test(cdk)) throw new ManualOrderError('人工交付必须填写有效 CDK');
        const guard = await store.acquirePaymentLock(manualLockKeys(input.requestId, cdk));
        if (!guard) throw new ManualOrderError('此管理员订单或 CDK 正在处理，请查询原订单', 409);
        let background = null;
        try {
            await guard.assertOwned();
            record({ client_order_no: `manual-${input.requestId}` }, 'execution_lock_acquired', '已取得管理员订单跨进程执行权');
            return await createOwned(input, guard, pending => { background = pending; });
        } finally {
            if (background) background.catch(() => {}).finally(() => guard.release()).catch(() => {});
            else await guard.release();
        }
    }

    async function createOwned({ requestId, planType, mode, cdkCode, session: rawSession, authorized, adminEmail }, executionGuard, handoff) {
        if (!REQUEST_ID.test(String(requestId || ''))) throw new ManualOrderError('请使用有效的请求编号');
        if (typeof planType !== 'string' || !PLAN_ID.test(planType)) throw new ManualOrderError('请选择有效的卡台套餐');
        if (!['test', 'fulfillment'].includes(mode)) throw new ManualOrderError('请选择测试开通或人工交付模式');
        const code = String(cdkCode || '').trim();
        if (mode === 'fulfillment' && !CDK_CODE.test(code)) throw new ManualOrderError('人工交付必须填写有效 CDK');
        if (mode === 'test' && code) throw new ManualOrderError('测试开通不能填写 CDK');
        if (authorized !== true) throw new ManualOrderError('请先确认已取得目标账号的订阅支付授权');
        let session;
        try { session = parseSession(rawSession); }
        catch (error) { throw new ManualOrderError(error.message); }
        const cfg = { ...await config(), auditJobKey: `manual-${requestId}`, executionGuard }, email = session.user.email.trim().toLowerCase();
        const keyHash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
        let existing = await store.getManualOrder(requestId);
        if (existing && (!matches(existing, { planType, targetEmail: email, cfg })
            || existing.mode !== mode || (existing.cdk_code || '') !== code)) {
            throw new ManualOrderError('此请求编号已用于另一笔管理员订单', 409);
        }
        if (existing && !['preparing','prepared'].includes(existing.state)) return publicOrder(existing);
        const enabled = await plans(cfg);
        const selected = enabled.find(item => item.type === planType);
        if (!selected) throw new ManualOrderError('卡台当前未对该 API Key 开放此套餐', 409);
        record({ client_order_no: cfg.auditJobKey }, 'payment_plan_selected', '管理员已选择卡台开放套餐', { plan_type: planType, mode });
        subscription.validate({ cfg, identity: `manual-${requestId}`, planType, session });
        try { await subscription.requireRegion(cfg, planType); }
        catch (error) { throw new ManualOrderError(error.message, 409); }
        const maxConcurrent = await store.getMaxConcurrentActivations();
        if (activeJobs.size >= maxConcurrent) {
            throw new ManualOrderError('当前充值任务已满，请稍后重试', 429);
        }
        const slot = `manual-accept-${crypto.randomUUID()}`;
        activeJobs.add(slot);
        try {
            if (!existing) {
                try {
                    existing = await store.prepareManualOrder({ requestId, planType,
                        planName: selected.name, targetEmail: email, baseUrl: cfg.base_url, apiKeyHash: keyHash,
                        adminEmail: String(adminEmail || '').slice(0, 128), mode, cdkCode: code || null,
                        acceptedCdkPlans: [planType, CDK_PLAN[planType]].filter(Boolean) });
                } catch (error) {
                    if (/请求编号|待确认管理员订单|CDK|卡密/.test(error.message)) throw new ManualOrderError(error.message, 409);
                    throw error;
                }
            }
            if (!existing) throw new Error('管理员订单未能保存');
            if (!matches(existing, { planType, targetEmail: email, cfg })
                || existing.mode !== mode || (existing.cdk_code || '') !== code) {
                throw new ManualOrderError('此请求编号已用于另一笔管理员订单', 409);
            }
            if (existing.state === 'preparing') {
                record(existing, 'manual_preparation_started', '开始实时选卡并按需准备资金', { plan_type: planType });
                try {
                    if (!cardService || typeof cardService.allocate !== 'function') throw new Error('自动选卡服务尚未初始化');
                    const cardId = await cardService.allocate(cfg, existing.client_order_no, planType,
                        { manualRequestId: requestId });
                    await executionGuard.assertOwned();
                    existing = await store.markManualPrepared(requestId, existing.client_order_no, cardId);
                    record(existing, 'manual_card_ready', '管理员订单支付卡已准备', { card_id: cardId, plan_type: planType });
                } catch (error) {
                    // Release a preparation with no remote write or reserved card;
                    // otherwise preserve the original issue/funding intent for retry.
                    try {
                        await executionGuard.assertOwned();
                        await store.failManualPreparation(requestId, existing.client_order_no, `支付准备失败：${error.message}`);
                    } catch (_) { /* another owner or an unresolved monetary intent must remain reserved */ }
                    record(existing, 'manual_preparation_failed', '管理员订单支付准备未完成，请查询原准备记录', { error_type: error instanceof CardPreparationError ? 'card_preparation' : 'local_error' });
                    if (error instanceof ManualOrderError) throw error;
                    if (error instanceof CardPreparationError || /请求编号|待确认管理员订单|支付卡|CDK|卡密/.test(error.message)) {
                        throw new ManualOrderError(error.message, 409);
                    }
                    throw error;
                }
            }
            await executionGuard.assertOwned();
            if (await store.claimManualSubmission(requestId)) {
                activeJobs.delete(slot);
                activeJobs.add(existing.client_order_no);
                const job = submit(existing, cfg, session);
                handoff(job);
                job.catch(() => {}).finally(() => activeJobs.delete(existing.client_order_no));
                record(existing, 'manual_order_accepted', '管理员订单已保存并认领提交',
                    { plan_type: planType, card_id: Number(existing.card_id), target_email: email, mode, cdk_code: code || undefined });
            }
            return publicOrder(await store.getManualOrder(requestId));
        } finally { activeJobs.delete(slot); }
    }

    async function submit(order, cfg, session) {
        const identity = order.client_order_no;
        try {
            const prepared = subscription.prepare({ cfg, identity, planType: order.plan_type, cardId: order.card_id, session });
            const result = await subscription.submit({ ...cfg, auditJobKey: identity }, prepared);
            await cfg.executionGuard?.assertOwned();
            const snapshot = result.snapshot;
            if (result.rejected) {
                await store.settleManualOrder(order.request_id, { state: 'failed', snapshot,
                    message: 'Orbitcard 明确拒绝提交；支付卡已释放，请核对 Session 与配置' });
                record(order, 'manual_order_rejected', '卡台明确拒绝管理员订单');
                return;
            }
            if (result.retryAfterMs) nextQueryAt.set(order.request_id, now() + result.retryAfterMs);
            await store.settleManualOrder(order.request_id, { state: 'pending',
                taskNo: result.orderId || null, snapshot,
                message: '已提交或结果待确认；只查询原订单，不重复创建' });
            record(order, 'manual_order_submitted', '管理员订单已提交或状态待确认',
                { plan_type: order.plan_type, card_id: Number(order.card_id), client_order_no: identity });
            await refreshOwned(order.request_id, cfg);
        } catch (_) {
            if (cfg.executionGuard) {
                try { await cfg.executionGuard.assertOwned(); }
                catch (_) { record(order, 'execution_lock_lost', '管理员订单执行权已失效，保留原单等待恢复核对'); return; }
            }
            await store.settleManualOrder(order.request_id, { state: 'manual',
                message: '提交结果尚未确认；请查询原订单，勿重新发起付款' }).catch(() => {});
            record(order, 'manual_order_unknown', '管理员订单提交结果待核对');
        }
    }

    async function refresh(requestId, knownCfg = null) {
        const order = await store.getManualOrder(requestId);
        if (!order) throw new ManualOrderError('管理员订单不存在', 404);
        const guard = await store.acquirePaymentLock(manualLockKeys(requestId, order.cdk_code));
        if (!guard) return get(requestId);
        try { await guard.assertOwned(); return await refreshOwned(requestId, knownCfg, guard); }
        finally { await guard.release(); }
    }

    async function refreshOwned(requestId, knownCfg = null, guard = null) {
        if (inFlight.has(requestId)) return get(requestId);
        inFlight.add(requestId);
        try {
            const order = await store.getManualOrder(requestId);
            if (!order) throw new ManualOrderError('管理员订单不存在', 404);
            if (!['submitting', 'pending', 'manual'].includes(order.state)) return publicOrder(order);
            const cfg = { ...(knownCfg || await config()), executionGuard: guard || knownCfg?.executionGuard };
            const hash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
            if (hash !== order.api_key_hash) throw new ManualOrderError('API Key 与原订单不一致，请恢复原配置后查询', 409);
            if (cardScope(cfg.base_url) !== order.scope) throw new ManualOrderError('平台地址与原订单不一致，请恢复原配置后查询', 409);
            if ((nextQueryAt.get(requestId) || 0) > now()) return publicOrder(order);
            for (const [key, until] of nextQueryAt) if (until <= now()) nextQueryAt.delete(key);
            const result = await subscription.query({ ...cfg, auditJobKey: order.client_order_no }, {
                orderId: order.task_no, clientOrderNo: order.client_order_no,
                planType: order.plan_type, email: order.target_email, cardId: Number(order.card_id) });
            await cfg.executionGuard?.assertOwned();
            nextQueryAt.set(requestId, now() + Math.max(5000, result.retryAfterMs || 0));
            if (!result.success) {
                challenges.delete(requestId);
                record(order, 'manual_order_query_unconfirmed', '原管理员订单尚未返回可核对的归属结果');
                return publicOrder(await store.settleManualOrder(requestId, { state: 'manual',
                    message: '原订单查询暂不可确认；保留支付卡占用，勿重新付款' }));
            }
            const state = result.state;
            const next = state === 'success' ? 'success' : state === 'failed' ? 'failed' : 'pending';
            if (next !== 'pending') nextQueryAt.delete(requestId);
            const captcha = result.captcha;
            if (captcha && next === 'pending') challenges.set(requestId, captcha);
            else challenges.delete(requestId);
            const updated = await store.settleManualOrder(requestId, {
                state: next, taskNo: result.orderId,
                snapshot: result.snapshot,
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
                    const guard = await store.acquirePaymentLock(manualLockKeys(order.request_id, order.cdk_code));
                    if (!guard) continue;
                    try {
                        await guard.assertOwned();
                        const released = await store.abandonPreparedManualOrder(order.request_id).catch(() => null);
                        if (released) record(released, 'manual_order_prepared_abandoned', '管理员订单提交前中断，已释放 CDK 与卡片');
                    } finally { await guard.release(); }
                    continue;
                }
                await refresh(order.request_id).catch(() => {});
            }
        } finally { recovering = false; }
    }

    return { catalog, list, get, create, refresh, recover, ManualOrderError };
};

module.exports.ManualOrderError = ManualOrderError;
