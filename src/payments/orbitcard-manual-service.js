'use strict';

const crypto = require('node:crypto');
const api = require('../orbitcard/orbitcard-client');
const { parseSession } = require('./session-input');
const { cardScope, CardPreparationError, CardBusyError, FundingAwaitingError, FUNDING_POLL_MS, FUNDING_WAIT_MS } = require('../orbitcard/orbitcard-card-policy');
const { PaymentStoppedError } = require('./payment-automation');
const { PROVIDER_TO_PLAN: CDK_PLAN } = require('../config/plan-registry');
const { manualLockKeys } = require('./payment-execution-lock');
const { manualHistory, retryableFailure } = require('./payment-retry-policy');
const { classifyFailure } = require('../orbitcard/orbitcard-error-policy');
const { projectBusinessOrder } = require('./order-business-status');

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SUPPORTED_PLANS = Object.freeze(Object.keys(CDK_PLAN));
const CDK_CODE = /^[A-Za-z0-9_-]{4,32}$/;
const recoveryKeys = order => order.manual_local_released_at
    ? [`reconcile:${order.client_order_no.toLowerCase()}`] : manualLockKeys(order.request_id, order.cdk_code);

class ManualOrderError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

module.exports = function createManualService({ store, activeJobs, audit, cardService, waitingQueue = null, provider = api, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), fundingWaitMs = FUNDING_WAIT_MS }) {
    const subscription = require('../orbitcard/orbitcard-subscription-service')(provider, audit);
    const inFlight = new Set(), challenges = new Map(), nextQueryAt = new Map();
    const retrySessions = new Map();
    let retryTimer = null;
    function rememberSession(requestId, session) {
        // Bounded, transient credentials: never persist Session for a restart.
        for (const [id, entry] of retrySessions) if (entry.until <= now()) retrySessions.delete(id);
        if (!retrySessions.has(requestId) && retrySessions.size >= 64) retrySessions.delete(retrySessions.keys().next().value);
        retrySessions.set(requestId, { session, until: now() + 15 * 60 * 1000 });
        if (!retryTimer) {
            retryTimer = setInterval(async () => {
                for (const [id, entry] of retrySessions) {
                    if (entry.until <= now()) { retrySessions.delete(id); continue; }
                    if (inFlight.has(id)) continue;
                    try {
                        const order = await store.getManualOrder(id);
                        if (!order || ['success','failed','rejected','support_locked','manual','funding_review','funding_pending'].includes(order.state)) {
                            retrySessions.delete(id); continue;
                        }
                        if (!activeJobs.has(order.client_order_no)) await refresh(id);
                    } catch (_) { /* keep the original identity for the next read */ }
                }
                if (!retrySessions.size) { clearInterval(retryTimer); retryTimer = null; }
            }, 5000);
            retryTimer.unref();
        }
    }
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
        const business = projectBusinessOrder(order), closed = business.business_status === 'closed';
        let snapshot = null;
        try { snapshot = order.snapshot ? JSON.parse(order.snapshot) : null; } catch (_) { /* historical malformed snapshot */ }
        return { request_id: order.request_id, client_order_no: order.client_order_no,
            ...business,
            task_no: order.task_no || null, plan_type: order.plan_type, plan_name: order.plan_name,
            target_email: order.target_email, card_id: Number(order.card_id) || null, state: order.state,
            manual_result: order.manual_result || null, manual_result_reason: order.manual_result_reason || null,
            manual_result_by: order.manual_result_by || null, manual_result_at: order.manual_result_at || null,
            manual_local_released_at: order.manual_local_released_at || null,
            manual_local_released_by: order.manual_local_released_by || null,
            manual_local_release_reason: order.manual_local_release_reason || null,
            mode: order.mode, cdk_code: order.cdk_code || null, attempt: manualHistory(order).length + 1,
            attempts: manualHistory(order),
            message: order.message || '', ...(waitingQueue && !closed ? require('./payment-waiting-queue').queueFeedback(order.message) : {}),
            order: snapshot, created_at: order.created_at, updated_at: order.updated_at,
            captcha: closed ? null : challenges.get(order.request_id) || null };
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
        const cfg = { ...await config(), auditJobKey: `manual-${requestId}`, executionGuard,
            paymentGuard: { assertAllowed: () => store.assertPaymentAllowed(`manual-${requestId}`) } }, email = session.user.email.trim().toLowerCase();
        const keyHash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
        let existing = await store.getManualOrder(requestId);
        if (existing && (!matches(existing, { planType, targetEmail: email, cfg })
            || existing.mode !== mode || (existing.cdk_code || '') !== code)) {
            throw new ManualOrderError('此请求编号已用于另一笔管理员订单', 409);
        }
        if (existing && (existing.manual_result || existing.manual_local_released_at || !['preparing','prepared','retry_waiting'].includes(existing.state))) return publicOrder(existing);
        if (waitingQueue?.isFull() && !waitingQueue.has(existing?.client_order_no || `manual-${requestId}`)) {
            throw new (require('./payment-waiting-queue').PaymentQueueFullError)();
        }
        const enabled = await plans(cfg);
        const selected = enabled.find(item => item.type === planType);
        if (!selected) throw new ManualOrderError('卡台当前未对该 API Key 开放此套餐', 409);
        record({ client_order_no: cfg.auditJobKey }, 'payment_plan_selected', '管理员已选择卡台开放套餐', { plan_type: planType, mode });
        subscription.validate({ cfg, identity: `manual-${requestId}`, planType, session });
        try { await subscription.requireRegion(cfg, planType); }
        catch (error) { throw new ManualOrderError(error.message, 409); }
        const maxConcurrent = await store.getMaxConcurrentActivations();
        const slot = `manual-accept-${crypto.randomUUID()}`;
        let waitingTicket = null, waitingHandedOff = false;
        if ((waitingQueue ? waitingQueue.activeCount() : activeJobs.size) >= maxConcurrent) {
            if (!waitingQueue) throw new ManualOrderError('当前充值任务已满，请稍后重试', 429);
            waitingTicket = await waitingQueue.acquire(slot);
        }
        activeJobs.add(slot);
        async function handoffWaiting(order) {
            await executionGuard.assertOwned();
            const updated = order.state === 'preparing' && !Number(order.card_id)
                ? await store.noteManualWaiting(requestId, order.client_order_no, waitingQueue.waitingMessage) : order;
            waitingTicket.rename(order.client_order_no);
            activeJobs.delete(slot);
            activeJobs.add(order.client_order_no);
            const job = continueCardWaiting(updated, cfg, session, waitingTicket);
            waitingHandedOff = true;
            handoff(job);
            record(order, 'manual_card_waiting', waitingQueue.waitingMessage);
            return publicOrder(updated);
        }
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
            if (existing.state === 'retry_waiting') {
                existing = await store.startManualRetry(requestId, existing.client_order_no, { email, baseUrl: cfg.base_url, apiKeyHash: keyHash });
                if (!existing) return get(requestId);
            }
            const attemptIdentity = existing.client_order_no;
            cfg.auditJobKey = attemptIdentity;
            cfg.paymentGuard = { assertAllowed: () => store.assertPaymentAllowed(attemptIdentity) };
            if (waitingTicket) return await handoffWaiting(existing);
            if (existing.state === 'preparing') {
                record(existing, 'manual_preparation_started', '开始实时选卡并按需准备资金', { plan_type: planType });
                try {
                    if (!cardService || typeof cardService.allocate !== 'function') throw new Error('自动选卡服务尚未初始化');
                    const cardId = await cardService.allocate(cfg, existing.client_order_no, planType,
                        { manualRequestId: requestId, ...(manualHistory(existing).length ? {
                            excludedCardIds: manualHistory(existing).map(item => Number(item.card_id))
                        } : {}) });
                    await executionGuard.assertOwned();
                    existing = await store.markManualPrepared(requestId, existing.client_order_no, cardId);
                    record(existing, 'manual_card_ready', '管理员订单支付卡已准备', { card_id: cardId, plan_type: planType });
                } catch (error) {
                    if (error instanceof CardBusyError && waitingQueue) {
                        try {
                            waitingTicket = await waitingQueue.acquire(slot);
                            return await handoffWaiting(existing);
                        } catch (waitingError) { error = waitingError; }
                    }
                    if (error instanceof FundingAwaitingError && typeof cardService.confirmFunding === 'function') {
                        await executionGuard.assertOwned();
                        await store.assertPaymentAllowed(existing.client_order_no);
                        existing = await store.waitManualFunding(requestId, existing.client_order_no,
                            `原补款仍待到账，后台每 ${FUNDING_POLL_MS / 1000} 秒核对；确认足额后继续原订阅`);
                        activeJobs.delete(slot);
                        const activeIdentity = existing.client_order_no;
                        activeJobs.add(activeIdentity);
                        const job = continueFunding(existing, cfg, session, error.retryAfterMs);
                        handoff(job);
                        job.catch(() => {}).finally(() => activeJobs.delete(activeIdentity));
                        return publicOrder(existing);
                    }
                    // Release only after the store verifies that any original
                    // issue/funding is final; unresolved money operations stay locked.
                    try {
                        await executionGuard.assertOwned();
                        await store.failManualPreparation(requestId, existing.client_order_no, `支付准备失败：${error.message}`);
                    } catch (_) {
                        await executionGuard.assertOwned();
                        await store.pauseManualPreparation(requestId, existing.client_order_no,
                            '支付准备结果待人工核对，已退出自动支付；停止开卡、补款和订阅充值');
                    }
                    record(existing, 'manual_preparation_failed', '管理员订单支付准备未完成，请查询原准备记录', { error_type: error instanceof CardPreparationError ? 'card_preparation' : 'local_error' });
                    if (String(error.code || '').startsWith('PAYMENT_QUEUE_')) throw error;
                    if (error instanceof ManualOrderError) throw error;
                    if (error instanceof CardPreparationError || /请求编号|待确认管理员订单|支付卡|CDK|卡密/.test(error.message)) {
                        throw new ManualOrderError(error.message, 409);
                    }
                    throw error;
                }
            }
            await executionGuard.assertOwned();
            if (await store.claimManualSubmission(requestId)) {
                rememberSession(requestId, session);
                activeJobs.delete(slot);
                const activeIdentity = existing.client_order_no;
                activeJobs.add(activeIdentity);
                const job = submit(existing, cfg, session);
                handoff(job);
                job.catch(() => {}).finally(() => activeJobs.delete(activeIdentity));
                record(existing, 'manual_order_accepted', '管理员订单已保存并认领提交',
                    { plan_type: planType, card_id: Number(existing.card_id), target_email: email, mode, cdk_code: code || undefined });
            }
            return publicOrder(await store.getManualOrder(requestId));
        } finally {
            activeJobs.delete(slot);
            if (waitingTicket && !waitingHandedOff) await waitingTicket.release();
        }
    }

    async function continueCardWaiting(order, cfg, session, ticket) {
        const identity = order.client_order_no;
        try {
            await waitingQueue.waitForCapacity(ticket, { session, cfg });
            let prepared = order;
            if (order.state !== 'prepared') {
                const cardId = await waitingQueue.allocate({ key: identity, session, cfg,
                    allocate: () => cardService.allocate(cfg, identity, order.plan_type, { manualRequestId: order.request_id,
                        excludedCardIds: manualHistory(order).map(item => Number(item.card_id)), waitForAvailability: waitingQueue.has(identity) }),
                    onWait: message => store.noteManualWaiting(order.request_id, identity, message) });
                await cfg.executionGuard?.assertOwned();
                parseSession(session);
                prepared = await store.markManualPrepared(order.request_id, identity, cardId);
            } else await ticket.release();
            if (await store.claimManualSubmission(order.request_id)) {
                rememberSession(order.request_id, session);
                await submit(prepared, cfg, session);
            }
        } catch (error) {
            if (error instanceof PaymentStoppedError) return;
            try {
                await cfg.executionGuard?.assertOwned();
                if (error instanceof FundingAwaitingError) {
                    const waiting = await store.waitManualFunding(order.request_id, identity, '支付卡已分配，正在核对原补款到账后继续');
                    await continueFunding(waiting, cfg, session, error.retryAfterMs);
                } else {
                    try { await store.failManualPreparation(order.request_id, identity, require('../logging/log-safety').sanitize(error.message)); }
                    catch (_) { await store.pauseManualPreparation(order.request_id, identity, '等待支付卡期间准备结果待核对，保留原记录'); }
                }
            } catch (_) { record(order, 'manual_wait_recovery_deferred', '支付卡等待已停止，保留原任务供恢复核对'); }
        } finally {
            try { await ticket.release(); } finally { activeJobs.delete(identity); }
        }
    }

    async function finishFundingError(order, cfg, error) {
        if (error instanceof PaymentStoppedError) return;
        await cfg.executionGuard?.assertOwned();
        const released = await store.releaseManualFunding(order.request_id, order.client_order_no,
            '原补款已核对，会员订阅尚未提交；准备任务已释放，请使用最新 Session 和新的请求编号重新提交');
        if (!released) {
            nextQueryAt.set(order.request_id, now() + 60000);
            await store.pauseManualPreparation(order.request_id, order.client_order_no,
                '原补款待核对，自动支付已停止；后台仅核对原资金，确认前保留支付卡与 CDK');
        }
    }

    async function continueFunding(order, cfg, session, retryAfterMs) {
        const deadline = now() + fundingWaitMs;
        let delay = Math.max(FUNDING_POLL_MS, retryAfterMs || 0);
        async function review(message) {
            await cfg.executionGuard?.assertOwned();
            await store.assertPaymentAllowed(order.client_order_no);
            await store.reviewManualFunding(order.request_id, order.client_order_no, message);
            record(order, 'manual_funding_review', '原补款已转人工对账，停止自动订阅；后台仅只读核对原资金');
        }
        try {
            while (now() < deadline) {
                await cfg.executionGuard?.assertOwned();
                await store.assertPaymentAllowed(order.client_order_no);
                try { parseSession(session); }
                catch (_) {
                    await review('Session 已过期，已转人工对账；后台仅核对原补款，确认后释放准备任务，需重新提交最新 Session');
                    return;
                }
                await sleep(Math.min(delay, deadline - now()));
                await cfg.executionGuard?.assertOwned();
                await store.assertPaymentAllowed(order.client_order_no);
                if (now() >= deadline) break;
                try { parseSession(session); }
                catch (_) {
                    await review('Session 已过期，已转人工对账；后台仅核对原补款，确认后释放准备任务，需重新提交最新 Session');
                    return;
                }
                let cardId;
                try { cardId = await cardService.confirmFunding(cfg, order.client_order_no, order.plan_type); }
                catch (error) {
                    if (!(error instanceof FundingAwaitingError)) throw error;
                    delay = Math.max(FUNDING_POLL_MS, error.retryAfterMs || 0);
                    continue;
                }
                await cfg.executionGuard?.assertOwned();
                await store.assertPaymentAllowed(order.client_order_no);
                if (now() >= deadline) break;
                try { parseSession(session); }
                catch (_) {
                    await review('原补款已到账，但 Session 已过期；已转人工对账，请核对后使用最新 Session 和新的请求编号重新提交');
                    return;
                }
                const prepared = await store.markManualPrepared(order.request_id, order.client_order_no, cardId);
                if (await store.claimManualSubmission(order.request_id)) { rememberSession(order.request_id, session); await submit(prepared, cfg, session); }
                return;
            }
            await review('补款等待已超过 120 秒，已转人工对账；后台仅核对原补款，确认后释放准备任务，需重新提交最新 Session');
        } catch (error) {
            try { await finishFundingError(order, cfg, error); }
            catch (_) { record(order, 'manual_funding_recovery_deferred', '原补款等待暂未完成，保留原记录供后台继续核对'); }
        }
    }

    async function recoverFunding(order, existingGuard = null, knownCfg = null) {
        if ((nextQueryAt.get(order.request_id) || 0) > now()) return;
        const guard = existingGuard || await store.acquirePaymentLock(recoveryKeys(order));
        if (!guard) return;
        try {
            await guard.assertOwned();
            order = await store.getManualOrder(order.request_id);
            if (!order || !['funding_waiting','funding_review','funding_pending'].includes(order.state)) return;
            nextQueryAt.set(order.request_id, now() + FUNDING_POLL_MS);
            const cfg = { ...(knownCfg || await config()), executionGuard: guard, auditJobKey: order.client_order_no };
            if (!matches(order, { cfg, planType: order.plan_type, targetEmail: order.target_email })) {
                throw new ManualOrderError('补款平台或 API Key 与原管理员订单不一致，请恢复原配置后核对',409);
            }
            await store.assertFundingReconciliationAllowed(order.client_order_no);
            if (order.state === 'funding_waiting') {
                order = await store.reviewManualFunding(order.request_id, order.client_order_no,
                    '原 Session 已不可用，已转人工对账；后台仅核对原补款，确认后释放准备任务，需重新提交最新 Session');
            }
            nextQueryAt.set(order.request_id, now() + FUNDING_POLL_MS);
            try {
                await cardService.confirmFunding(cfg, order.client_order_no, order.plan_type);
                await guard.assertOwned();
                await store.assertFundingReconciliationAllowed(order.client_order_no);
                await store.releaseManualFunding(order.request_id, order.client_order_no,
                    '原补款已到账，会员订阅尚未提交；准备任务已释放，请使用最新 Session 和新的请求编号重新提交');
            } catch (error) {
                if (error instanceof FundingAwaitingError) {
                    nextQueryAt.set(order.request_id, now() + Math.max(FUNDING_POLL_MS, error.retryAfterMs || 0));
                    return;
                }
                await finishFundingError(order, cfg, error);
            }
        } finally { if (!existingGuard) await guard.release(); }
    }

    async function recoverPreparation(order, guard) {
        if ((nextQueryAt.get(order.request_id) || 0) > now()) return;
        nextQueryAt.set(order.request_id, now() + 60000);
        await guard.assertOwned();
        try {
            const released = await store.failManualPreparation(order.request_id, order.client_order_no,
                '原支付准备记录已核对，会员订阅未提交；准备任务已释放，请使用最新 Session 和新请求编号重新提交');
            if (released) record(released, 'manual_preparation_released', '原支付准备记录已核对，释放未提交任务');
        } catch (_) {
            await guard.assertOwned();
            await store.pauseManualPreparation(order.request_id, order.client_order_no,
                '原开卡或补款尚待核对，自动支付已停止；确认原资金结果后释放准备任务');
        }
    }

    async function submit(order, cfg, session) {
        const identity = order.client_order_no;
        cfg = { ...cfg, auditJobKey: identity, paymentGuard: { assertAllowed: () => store.assertPaymentAllowed(identity) } };
        try {
            const prepared = subscription.prepare({ cfg, identity, planType: order.plan_type, cardId: order.card_id, session });
            const result = await subscription.submit({ ...cfg, auditJobKey: identity }, prepared);
            await cfg.executionGuard?.assertOwned();
            const snapshot = result.snapshot;
            if (result.rejected) {
                if (result.cardRejected) {
                    const failed = await store.settleManualOrder(order.request_id, { state: 'failed', snapshot,
                        expectedClientOrderNo: identity, retryAllowed: true,
                        message: '卡台确认支付卡不可用，已停用并安排补开' });
                    record(order, 'manual_card_rejected', '卡台确认支付卡不可用，已保存停用及补开记录', { card_id: Number(order.card_id) });
                    if (failed?.state === 'retry_waiting') await retryPayment(failed, cfg);
                    return;
                }
                await store.settleManualOrder(order.request_id, { state: 'rejected', snapshot,
                    expectedClientOrderNo: identity,
                    message: result.message || result.disposition?.message || 'Orbitcard 明确拒绝提交；支付卡已释放，请核对 Session 与配置' });
                retrySessions.delete(order.request_id);
                record(order, 'manual_order_rejected', '卡台明确拒绝管理员订单');
                return;
            }
            if (result.retryAfterMs) nextQueryAt.set(order.request_id, now() + result.retryAfterMs);
            await store.settleManualOrder(order.request_id, { state: 'pending',
                expectedClientOrderNo: identity,
                taskNo: result.orderId || null, snapshot,
                message: result.message || '已提交或结果待确认；只查询原订单，不重复创建' });
            record(order, 'manual_order_submitted', '管理员订单已提交或状态待确认',
                { plan_type: order.plan_type, card_id: Number(order.card_id), client_order_no: identity });
            await refreshOwned(order.request_id, cfg);
        } catch (_) {
            if (cfg.executionGuard) {
                try { await cfg.executionGuard.assertOwned(); }
                catch (_) { record(order, 'execution_lock_lost', '管理员订单执行权已失效，保留原单等待恢复核对'); return; }
            }
            await store.settleManualOrder(order.request_id, { state: 'pending',
                expectedClientOrderNo: identity,
                message: '提交结果尚未确认；请查询原订单，勿重新发起付款' }).catch(() => {});
            record(order, 'manual_order_unknown', '管理员订单提交结果待核对');
        }
    }

    async function retryPayment(order, cfg, handoff = null) {
        // Recheck persisted evidence before credentials, plan queries or card
        // allocation, including retry_waiting rows created by older versions.
        await cfg.executionGuard?.assertOwned();
        if (store.reviewManualRetry) order = await store.reviewManualRetry(order.request_id, order.client_order_no);
        if (!order || order.manual_result || order.manual_local_released_at || order.state !== 'retry_waiting') {
            if (order) retrySessions.delete(order.request_id);
            return publicOrder(order);
        }
        let snapshot;
        try { snapshot = JSON.parse(order.snapshot || '{}'); } catch (_) { snapshot = null; }
        if (!retryableFailure(snapshot, { clientOrderNo: order.client_order_no, orderId: order.task_no,
            cardId: order.card_id, planType: order.plan_type, email: order.target_email })) {
            retrySessions.delete(order.request_id);
            return publicOrder(order);
        }
        const entry = retrySessions.get(order.request_id);
        if (!entry || entry.until <= now()) { retrySessions.delete(order.request_id); return publicOrder(order); }
        try { parseSession(entry.session); } catch (_) { retrySessions.delete(order.request_id); return publicOrder(order); }
        if (!matches(order, { cfg, planType: order.plan_type, targetEmail: entry.session.user.email.trim().toLowerCase() })) {
            throw new ManualOrderError('重试账号、平台或密钥与原订单不一致', 409);
        }
        await subscription.requirePlan(cfg, order.plan_type);
        await subscription.requireRegion(cfg, order.plan_type);
        const capacity = await store.getMaxConcurrentActivations();
        const alreadyActive = activeJobs.has(order.client_order_no);
        if (!alreadyActive && (waitingQueue ? waitingQueue.activeCount() : activeJobs.size) >= capacity) return publicOrder(order);
        const slot = alreadyActive ? null : `manual-retry-accept-${crypto.randomUUID()}`;
        if (slot) activeJobs.add(slot);
        let next;
        try {
            await cfg.executionGuard?.assertOwned();
            next = await store.startManualRetry(order.request_id, order.client_order_no, {
                email: order.target_email, baseUrl: cfg.base_url, apiKeyHash: order.api_key_hash
            });
            if (next) activeJobs.add(next.client_order_no);
        } finally { if (slot) activeJobs.delete(slot); }
        if (!next) return get(order.request_id);
        const retryIdentity = next.client_order_no;
        const retryCfg = { ...cfg, auditJobKey: retryIdentity,
            paymentGuard: { assertAllowed: () => store.assertPaymentAllowed(retryIdentity) } };
        let background = false;
        try {
            const allocate = () => cardService.allocate(retryCfg, next.client_order_no, next.plan_type, {
                manualRequestId: next.request_id, excludedCardIds: manualHistory(next).map(item => Number(item.card_id)),
                ...(waitingQueue ? { waitForAvailability: waitingQueue.has(retryIdentity) } : {})
            });
            let cardId;
            try {
                cardId = await (waitingQueue && !handoff ? waitingQueue.allocate({ key: retryIdentity, session: entry.session, cfg: retryCfg, allocate,
                    onWait: message => store.noteManualWaiting(next.request_id, retryIdentity, message) }) : allocate());
            } catch (error) {
                if (!(error instanceof CardBusyError) || !waitingQueue || !handoff) throw error;
                const ticket = await waitingQueue.acquire(retryIdentity);
                const updated = await store.noteManualWaiting(next.request_id, retryIdentity, waitingQueue.waitingMessage);
                const job = continueCardWaiting(updated, retryCfg, entry.session, ticket);
                background = true;
                handoff(job);
                return publicOrder(updated);
            }
            await cfg.executionGuard?.assertOwned();
            const prepared = await store.markManualPrepared(next.request_id, next.client_order_no, cardId);
            if (await store.claimManualSubmission(next.request_id)) await submit(prepared, retryCfg, entry.session);
        } catch (error) {
            await cfg.executionGuard?.assertOwned();
            if (error instanceof FundingAwaitingError) {
                const waiting = await store.waitManualFunding(next.request_id, next.client_order_no, '换卡补款处理中，核对原补款后继续');
                const job = continueFunding(waiting, retryCfg, entry.session, error.retryAfterMs);
                if (handoff) {
                    background = true;
                    handoff(job.finally(() => activeJobs.delete(retryIdentity)));
                    return publicOrder(waiting);
                }
                await job;
            } else {
                try { await store.failManualPreparation(next.request_id, next.client_order_no, require('../logging/log-safety').sanitize(error.message)); }
                catch (_) { await store.pauseManualPreparation(next.request_id, next.client_order_no, '换卡资金操作待核对，保留原记录'); }
            }
        } finally {
            if (!background) {
                try { await waitingQueue?.release(retryIdentity); } finally { activeJobs.delete(retryIdentity); }
            }
        }
        return get(order.request_id);
    }

    async function refresh(requestId, knownCfg = null) {
        const order = await store.getManualOrder(requestId);
        if (!order) throw new ManualOrderError('管理员订单不存在', 404);
        const guard = await store.acquirePaymentLock(recoveryKeys(order));
        if (!guard) return get(requestId);
        let background = null;
        try { await guard.assertOwned(); return await refreshOwned(requestId, knownCfg, guard, pending => { background = pending; }); }
        finally {
            if (background) background.catch(() => {}).finally(() => guard.release()).catch(() => {});
            else await guard.release();
        }
    }

    async function refreshOwned(requestId, knownCfg = null, guard = null, handoff = null) {
        if (inFlight.has(requestId)) return get(requestId);
        inFlight.add(requestId);
        try {
            const order = await store.getManualOrder(requestId);
            if (!order) throw new ManualOrderError('管理员订单不存在', 404);
            if (['funding_waiting','funding_review','funding_pending'].includes(order.state)) {
                await recoverFunding(order, guard || knownCfg?.executionGuard, knownCfg);
                return get(requestId);
            }
            if (order.state === 'card_pending') {
                await recoverPreparation(order, guard || knownCfg?.executionGuard);
                return get(requestId);
            }
            if (order.state === 'retry_waiting') {
                const cfg = { ...(knownCfg || await config()), executionGuard: guard || knownCfg?.executionGuard };
                return await retryPayment(order, cfg, handoff);
            }
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
            nextQueryAt.set(requestId, now() + Math.max(result.stopTracking ? 300000 : 5000, result.retryAfterMs || 0));
            if (!result.success) {
                challenges.delete(requestId);
                record(order, 'manual_order_query_unconfirmed', '原管理员订单尚未返回可核对的归属结果');
                return publicOrder(await store.settleManualOrder(requestId, { state: 'pending',
                    expectedClientOrderNo: order.client_order_no,
                    message: `${result.error || '原订单查询暂不可确认'}；保留原订单与支付卡占用，勿重新付款` }));
            }
            const state = result.state;
            const next = state === 'success' ? 'success' : state === 'failed' ? 'failed' : 'pending';
            if (next !== 'pending') nextQueryAt.delete(requestId);
            const captcha = result.captcha;
            if (captcha && next === 'pending') challenges.set(requestId, captcha);
            else challenges.delete(requestId);
            const updated = await store.settleManualOrder(requestId, {
                state: next, taskNo: result.orderId,
                retryAllowed: next === 'failed' && retryableFailure(result.snapshot, {
                    orderId: result.orderId || order.task_no, clientOrderNo: order.client_order_no,
                    cardId: order.card_id, planType: order.plan_type, email: order.target_email
                }), expectedClientOrderNo: order.client_order_no,
                snapshot: result.snapshot,
                message: next === 'success' ? 'Orbitcard 已确认开通成功' : next === 'failed'
                    ? `${classifyFailure(result.snapshot).message}；原订单已确认失败，支付卡释放，保留原记录供核对` : captcha
                        ? '需要完成人机验证，然后继续查询原订单' : 'Orbitcard 仍在处理；继续查询原订单'
            });
            record(order, 'manual_order_query', '管理员原订单查询完成', { state: next, task_no: updated.task_no });
            if (updated.state === 'retry_waiting') return await retryPayment(updated, cfg, handoff);
            if (next !== 'pending') retrySessions.delete(requestId);
            return publicOrder(updated);
        } finally { inFlight.delete(requestId); }
    }

    async function recover() {
        if (recovering) return;
        recovering = true;
        try {
            for (const order of await store.listRecoverableManualOrders()) {
                if (activeJobs.has(order.client_order_no) || inFlight.has(order.request_id)) continue;
                try {
                    if (['funding_waiting','funding_review','funding_pending'].includes(order.state)) {
                        await recoverFunding(order);
                        continue;
                    }
                    if (['preparing','card_pending'].includes(order.state)) {
                        const guard = await store.acquirePaymentLock(recoveryKeys(order));
                        if (!guard) continue;
                        try {
                            await guard.assertOwned();
                            const current = await store.getManualOrder(order.request_id);
                            if (current && ['preparing','card_pending'].includes(current.state)) await recoverPreparation(current, guard);
                        } finally { await guard.release(); }
                        continue;
                    }
                    if (order.state === 'prepared') {
                        const guard = await store.acquirePaymentLock(recoveryKeys(order));
                        if (!guard) continue;
                        try {
                            await guard.assertOwned();
                            const released = await store.abandonPreparedManualOrder(order.request_id);
                            if (released) record(released, 'manual_order_prepared_abandoned', '管理员订单提交前中断，已释放 CDK 与卡片');
                        } finally { await guard.release(); }
                        continue;
                    }
                    await refresh(order.request_id);
                } catch (_) {
                    // One unavailable order must not prevent the rest of this
                    // bounded batch from reconciling their original payments.
                } finally {
                    try { await store.noteManualQueryAttempt(order.request_id); } catch (_) { /* retry on the next pass */ }
                }
            }
        } finally { recovering = false; }
    }

    return { catalog, list, get, create, refresh, recover, ManualOrderError };
};

module.exports.ManualOrderError = ManualOrderError;
