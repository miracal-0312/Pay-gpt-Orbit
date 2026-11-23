'use strict';
const poolPolicy = require('./orbitcard-pool');
const { CardPreparationError, CardBusyError, AccountBalanceError, CardDataError, CardSelectionError, FundingAwaitingError, FUNDING_POLL_MS,
    planFor, cardScope, INACTIVE_CARD_STATUSES } = require('./orbitcard-card-policy');

const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const cardsApi = require('./orbitcard-cards-client');
const { readAuthorizations } = require('./orbitcard-authorizations');
const money = require('./orbitcard-money');
const { PLAN_TYPES } = require('../config/plan-registry');
const { decideCards } = require('./orbitcard-payment-decision');
const { planPrice } = require('../config/orbitcard-config');
const { PaymentStoppedError } = require('../payments/payment-automation');
const { classifyApiError } = require('./orbitcard-error-policy');

const AUTO_ISSUE_PREFIX = 'card-auto-';

module.exports = function createCardService({ store, audit, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxIssuePolls = 3, now = Date.now }) {
    function record(jobKey, event, text, data) { audit({ jobKey: jobKey || '', source: 'orbitcard', event, text, data }); }
    const credentialHash = cfg => crypto.createHash('sha256').update(String(cfg.api_key || '').trim()).digest('hex');
    async function latestOpeningConfig(cfg) {
        const latest = store.getGptApiConfig ? await store.getGptApiConfig() : cfg;
        return { ...cfg, orbitcard_product_codes: latest.orbitcard_product_codes,
            orbitcard_product_code: latest.orbitcard_product_code, orbitcard_bins: latest.orbitcard_bins,
            orbitcard_max_initial_amount: latest.orbitcard_max_initial_amount };
    }
    async function assertPaymentAllowed(cfg, jobKey) {
        await cfg.executionGuard?.assertOwned();
        await store.assertPaymentAllowed(jobKey);
    }
    async function assertReconciliationAllowed(cfg, jobKey) {
        await cfg.executionGuard?.assertOwned();
        await store.assertFundingReconciliationAllowed(jobKey);
    }
    async function assertIssueReconciliationAllowed(cfg, jobKey) {
        await cfg.executionGuard?.assertOwned();
        await store.assertIssueReconciliationAllowed(jobKey);
    }
    async function withReplacementOwner(cfg, jobKey, action) {
        if (!jobKey) return action(cfg);
        const owner = await store.paymentOwner(jobKey);
        if (owner.localReleased || owner.manualClosed) return null;
        const current = cfg.executionGuard && cfg.auditJobKey ? await store.paymentOwner(cfg.auditJobKey) : null;
        const reused = Boolean(cfg.executionGuard && owner.keys.length && owner.keys.every(key => current?.keys?.includes(key)));
        const guard = reused ? cfg.executionGuard : owner.keys.length ? await store.acquirePaymentLock(owner.keys) : null;
        if (owner.keys.length && !guard) return null; // Nonblocking: allocation lock must never wait for an order lock.
        try {
            await guard?.assertOwned();
            const latest = await store.paymentOwner(jobKey);
            if (latest.localReleased || latest.manualClosed) return null;
            const executionGuard = { async assertOwned() {
                await cfg.executionGuard?.assertOwned();
                if (!reused) await guard?.assertOwned();
                const currentOwner = await store.paymentOwner(jobKey);
                if (currentOwner.localReleased || currentOwner.manualClosed) throw new PaymentStoppedError('原订单已人工闭单或解除本地占用，停止新增补开');
            } };
            return await action({ ...cfg, executionGuard });
        } finally { if (guard && !reused) await guard.release(); }
    }
    async function withRecoveryOwner(cfg, entry, action, { issueReconciliation = false } = {}) {
        const ownerJob = entry.job_key || entry.replacement_for_job_key || null;
        const owner = await store.paymentOwner(ownerJob);
        if (!entry.job_key && entry.replacement_for_job_key && !owner.localReleased && !owner.manualClosed && !entry.local_released_at) {
            return Boolean(await withReplacementOwner(cfg, ownerJob, async ownedCfg => {
                await action(ownedCfg, { originalIssueOnly: false, localReleased: false });
                return true;
            }));
        }
        const originalIssueOnly = issueReconciliation && Boolean(ownerJob)
            && (owner.allowed || owner.canReconcileIssue);
        const originalFundingOnly = Boolean(entry.funding_key && owner.localReleased && owner.canReconcileFunding);
        if (!owner.allowed && !originalIssueOnly && !originalFundingOnly) return false;
        if ((owner.localReleased || entry.local_released_at || issueReconciliation && owner.manualClosed) && !entry.order_no) return false;
        // Historical order-bound applications reconcile their original identity.
        // Shared replacement applications are owned by the card pool.
        if (originalIssueOnly && entry.state !== 'prepared' && !entry.order_no) return false;
        // Dedicated funding reconciliation owns these jobs. The legacy card
        // maintenance pass must not lengthen their delay or resend funding.
        if (!owner.localReleased && !owner.manualClosed && ['funding_waiting','funding_review','funding_pending'].includes(owner.state)) return false;
        const assertOwner = originalIssueOnly ? assertIssueReconciliationAllowed : originalFundingOnly ? assertReconciliationAllowed : assertPaymentAllowed;
        const recoveryEntry = { originalIssueOnly, reconciliationJob: originalIssueOnly ? ownerJob : null,
            localReleased: Boolean(owner.localReleased || entry.local_released_at) };
        if (!owner.keys.length) {
            await assertOwner(cfg, ownerJob);
            await action(cfg, recoveryEntry);
            return true;
        }
        const guard = await store.acquirePaymentLock(owner.keys);
        if (!guard) return false;
        try {
            const ownedCfg = { ...cfg, executionGuard: guard };
            await assertOwner(ownedCfg, ownerJob);
            await action(ownedCfg, recoveryEntry);
            return true;
        } catch (error) {
            if (error instanceof PaymentStoppedError) return false;
            throw error;
        } finally { await guard.release(); }
    }
    const fundingService = require('./orbitcard-funding-service')({api,cardsApi,audit,now,
        assertPaymentAllowed, assertReconciliationAllowed, withRecoveryOwner});
    const reconcileRetirement = require('./orbitcard-retirement')({ cardsApi });
    async function account(cfg) {
        const result=await api.request(cfg,'getAccountBalance');
        if(!result.success || result.requestError || result.data?.request_error || result.code != null && result.code !== 0) {
            const disposition = classifyApiError({ operation: 'getAccountBalance', status: result.status,
                code: result.code, requestError: result.requestError || result.data?.request_error, retryAfterMs: result.retryAfterMs });
            throw new CardPreparationError(`${disposition.message}；已停止选卡、开卡和补款`);
        }
        const available=money.units(result.data?.available_balance);
        record(cfg.auditJobKey,'account_balance_checked','已读取账户可用余额',{available_balance:money.decimal(available)});
        return available;
    }
    function requireFunds(jobKey, available, required) {
        if(available>=required) return;
        const message=`账户可用余额不足：可用 ${money.decimal(available)} USD，本次所需 ${money.decimal(required)} USD；充值已停止，请联系客服`;
        record(jobKey,'account_balance_insufficient',message,{available_balance:money.decimal(available),required_balance:money.decimal(required)});
        throw new AccountBalanceError(message);
    }
    function requirePlanPrice(cfg, plan) {
        const price = planPrice(cfg, plan);
        if (!price) throw new CardPreparationError('请先在后台配置当前套餐的 USD 支付金额，已停止代充');
        return price;
    }

    async function reconcileLegacyRetirements(cfg, locked, listed = null) {
        const snapshots = new Map((listed || []).map(card => [Number(card.card_id), card]));
        const confirmed = new Set();
        for (const row of await locked.listCards()) {
            if (row.active_job || !row.retirement_key) continue;
            const id = Number(row.card_id);
            if (row.retirement_state === 'confirmed') { confirmed.add(id); continue; }
            const snapshot = snapshots.get(id);
            if (listed && snapshot?.provider_status !== 'DELETED') continue;
            try {
                if (await reconcileRetirement(cfg, locked, row, snapshot)) {
                    confirmed.add(id);
                    record('', 'card_pool_retired', '已核实旧删卡记录', { card_id: id });
                }
            } catch (error) {
                record('', 'card_retirement_reconciliation_pending', '旧删卡记录待核对', {
                    card_id: id, reason: error instanceof CardPreparationError ? error.message : 'retirement_lookup_error' });
            }
        }
        return confirmed;
    }

    async function confirmIssue(cfg, locked, issue, polls = maxIssuePolls, { originalIssueOnly = false, reconciliationJob = null } = {}) {
        const assertAllowed = originalIssueOnly ? assertIssueReconciliationAllowed : assertPaymentAllowed;
        const ownerJob = issue.job_key || reconciliationJob || (issue.local_released_at ? issue.replacement_for_job_key : null);
        await assertAllowed(cfg, ownerJob);
        if (issue.scope !== cardScope(cfg.base_url)) throw new CardPreparationError('原开卡平台与当前配置不同，请恢复原配置后确认');
        if (originalIssueOnly && !issue.order_no) throw new CardPreparationError('原开卡申请缺少平台订单号，保留原申请等待人工核对');
        if (issue.credential_hash !== credentialHash(cfg)) throw new CardPreparationError('原开卡申请的 API Key 与当前配置不同，请恢复原凭据后确认，禁止换身份重开');
        if (Number(issue.retry_at || 0) > now()) throw new CardPreparationError('原开卡申请处于重查间隔内，请稍后确认原申请');
        let body;
        try { body = JSON.parse(issue.request_body); } catch (_) { throw new CardPreparationError('原开卡请求正文缺失，请人工核对'); }
        if (!body || Object.keys(body).length !== 3 || JSON.stringify(body) !== issue.request_body || body.product_code !== issue.product_code || body.amount !== Number(issue.amount).toFixed(2) || body.quantity !== 1) {
            throw new CardPreparationError('原开卡参数不一致，请恢复原请求，禁止更换参数重开');
        }
        // Only this original, durably stored body and key may confirm the application.
        await locked.updateIssue(issue.issue_key, { state: 'submitting', message: '正在确认原开卡请求' });
        const deadline = now() + 120000;
        for (let attempt = 0; attempt < polls && now() < deadline; attempt++) {
            await assertAllowed(cfg, ownerJob);
            const result = await api.request({ ...cfg, auditJobKey: issue.job_key || cfg.auditJobKey || '' }, 'createCard', body, issue.issue_key);
            await assertAllowed(cfg, ownerJob);
            if (!result.success || result.status !== 200 || result.requestError || result.data?.request_error
                || result.code != null && result.code !== 0) {
                const disposition = classifyApiError({ operation: 'createCard', status: result.status, code: result.code,
                    requestError: result.requestError || result.data?.request_error, retryAfterMs: result.retryAfterMs });
                const delay = Math.max(5000, result.retryAfterMs || 0, disposition.retryAfterMs,
                    disposition.stopTracking ? 300000 : 0);
                const message = `${disposition.message}；保留原开卡申请，禁止更换幂等键重开`;
                await locked.updateIssue(issue.issue_key, { state: 'unknown', message, retry_at: now() + delay });
                issue.retry_at = now() + delay;
                record(issue.job_key, 'card_issue_unconfirmed', message, { issue_key: issue.issue_key,
                    order_no: issue.order_no || '', error_action: disposition.action });
                const error = new CardPreparationError(message);
                error.disposition = disposition; error.retryAfterMs = delay;
                throw error;
            }
            const detail = cardsApi.issueResult(result.data);
            if ((issue.order_no && detail.order_no && issue.order_no !== detail.order_no)
                || (issue.card_id && detail.card_id && Number(issue.card_id) !== detail.card_id)
                || (issue.replacement_for_card_id && detail.card_id === Number(issue.replacement_for_card_id))
                || (detail.product_code && detail.product_code !== issue.product_code)
                || (detail.fees.initial_amount && Number(detail.fees.initial_amount) !== Number(issue.amount))) {
                await locked.updateIssue(issue.issue_key, { state: 'unknown', message: '原开卡订单或参数归属不一致，停止自动履约', retry_at: now() + 60000 });
                throw new CardPreparationError('原开卡订单归属不一致，请人工核对，禁止重新申请');
            }
            const validEnvelope = result.success && result.status === 200 && Boolean(detail.order_no);
            const delay = Math.max(Math.min(5000 * 2 ** attempt, 60000), result.retryAfterMs || 0, detail.retryAfterMs || 0);
            const update = { state: validEnvelope ? 'pending' : 'unknown', order_no: detail.order_no, card_id: detail.card_id,
                provider_status: detail.status, completed: detail.completed, fee_snapshot: Object.keys(detail.fees).length ? JSON.stringify(detail.fees) : undefined, retry_at: now() + delay,
                message: '开卡结果待确认；保留固定申请身份，禁止换键重开' };
            await locked.updateIssue(issue.issue_key, update);
            issue.order_no = detail.order_no || issue.order_no;
            issue.card_id = detail.card_id || issue.card_id;
            issue.retry_at = update.retry_at;
            record(issue.job_key, 'card_issue_result', '收到原开卡请求结果', { issue_key: issue.issue_key,
                order_no: detail.order_no, card_id: detail.card_id, status: detail.status, completed: detail.completed, success: result.success, fees: detail.fees });
            if (validEnvelope && detail.status === 'success' && detail.card_id && detail.completed !== false) {
                const card = await cardsApi.cardDetail(cfg, detail.card_id);
                await assertAllowed(cfg, ownerJob);
                if (card.provider_status !== 'ACTIVE') throw new CardPreparationError('原开卡订单的卡片尚未激活，请继续确认原申请');
                if (card.product_code && card.product_code !== issue.product_code) throw new CardPreparationError('开卡产品归属不一致，请人工核对原申请');
                card.product_code ||= issue.product_code;
                await locked.syncCards([card]);
                await locked.completeIssue(issue, card);
                record(issue.job_key, 'card_issue_ready', '平台卡已激活并登记订单计数', { issue_key: issue.issue_key, card_id: card.card_id, plan_type: issue.plan_type });
                return card;
            }
            if (validEnvelope && ['failed','refunded'].includes(detail.status) && detail.completed !== false) {
                await locked.updateIssue(issue.issue_key, { state: 'failed', order_no: detail.order_no, message: '平台明确返回开卡失败' });
                throw new CardPreparationError('Orbitcard 已确认开卡失败，请检查产品及余额');
            }
            if (!result.success || !['pending','pending_confirm','processing','created','validating','balance_locked'].includes(detail.status)) break;
            if (attempt + 1 < polls && now() + delay < deadline) await sleep(delay); else break;
        }
        throw new CardPreparationError('原开卡申请仍待确认，尚未提交会员充值；请稍后重试或在后台确认原申请');
    }

    async function preparePoolIssue(cfg, locked, plan, { jobKey = null, replacementCardId = null, failureJobKey = '' } = {}) {
        const products = await cardsApi.products(cfg);
        const selected = cardsApi.chooseOpeningProduct(products, cfg, (await locked.listIssues())[0]?.product_code);
        const body = cardsApi.createCardBody(selected);
        requireFunds(jobKey, await account(cfg), money.units(body.amount));
        await assertPaymentAllowed(cfg, jobKey);
        const prefix = jobKey && !replacementCardId ? AUTO_ISSUE_PREFIX : 'card-';
        return locked.createManualIssue({ issue_key: `${prefix}${crypto.randomUUID()}`, plan_type: plan,
            ...selected, credential_hash: credentialHash(cfg), request_body: JSON.stringify(body),
            ...(replacementCardId ? { replacement_for_card_id: replacementCardId, replacement_for_job_key: failureJobKey } : {}) });
    }

    async function pendingCardIssues(locked, includeReleased = false) {
        const pending = [];
        for (const plan of PLAN_TYPES) {
            const issue = await locked.pendingIssue(plan, includeReleased);
            if (issue) pending.push(issue);
        }
        return pending;
    }

    async function openCardForPayment(cfg, locked, jobKey, planType) {
        if (!cfg.enabled && !cfg.auditJobKey) return null;
        cfg = { ...cfg, auditJobKey: jobKey };
        const saved = await locked.listCards();
        const sources = saved.filter(row => !row.active_job && (poolPolicy.exhausted(row) ? cfg.enabled
            : row.disabled_at && row.disabled_code !== 'manual'));
        const pending = await pendingCardIssues(locked);

        async function confirmPoolIssue(ownedCfg, issue, options) {
            const replacementId = issue.replacement_for_card_id;
            await assertPaymentAllowed(ownedCfg, jobKey);
            try {
                const card = await confirmIssue(ownedCfg, locked, issue, 1, options);
                record(jobKey, replacementId ? 'card_replacement_ready' : 'card_auto_issue_ready',
                    replacementId ? '停用卡的补开申请已完成' : '卡池新卡已激活', {
                        disabled_card_id: replacementId, card_id: card.card_id, issue_key: issue.issue_key });
                return card;
            } catch (error) {
                if (error instanceof PaymentStoppedError) throw error;
                const latest = await locked.pendingIssue(issue.plan_type);
                if (latest?.issue_key === issue.issue_key) {
                    record(jobKey, replacementId ? 'card_replacement_pending' : 'card_auto_issue_pending',
                        '开卡申请待确认，保留原请求身份', { card_id: replacementId, issue_key: issue.issue_key });
                    throw new CardBusyError(`支付卡${replacementId ? '补开' : '开卡'}申请正在确认，卡片就绪后将继续选卡`);
                }
                throw error;
            }
        }

        // Open at most one card after existing-card selection has found no usable card.
        // Resume the original shared application before considering any new request.
        if (pending.length) {
            const [issue] = pending;
            if (pending.length !== 1 || issue.job_key
                || (!issue.replacement_for_card_id && !issue.issue_key.startsWith(AUTO_ISSUE_PREFIX))) {
                throw new CardPreparationError('存在其他待确认开卡申请，请管理员核对原开卡记录后重试');
            }
            let card;
            const handled = await withRecoveryOwner(cfg, issue, async (ownedCfg, options) => {
                card = await confirmPoolIssue(ownedCfg, issue, options);
            }, { issueReconciliation: true });
            if (!handled) throw new CardPreparationError('原补开申请不可继续提交，请核对原订单及开卡记录');
            return card;
        }

        let blockedReplacement = false;
        for (const row of sources) {
            const quota = poolPolicy.exhausted(row);
            const failureJobKey = quota ? '' : row.disabled_job_key || '';
            const previous = await locked.replacementForCard(row.card_id, failureJobKey);
            if (previous) {
                if (previous.state !== 'ready') blockedReplacement = true;
                continue;
            }
            const replaced = await withReplacementOwner(cfg, failureJobKey, async ownedCfg => {
                const issue = await preparePoolIssue(await latestOpeningConfig(ownedCfg), locked, planFor(planType),
                    { jobKey, replacementCardId: row.card_id, failureJobKey });
                record(jobKey, quota ? 'card_quota_replacement_started' : 'card_replacement_started',
                    quota ? '无合格现有卡，已登记满额卡补开申请' : '无合格现有卡，已登记错误停用卡补开申请', {
                        card_id: Number(row.card_id), failure_code: row.disabled_code,
                        issue_key: issue.issue_key, product_code: issue.product_code });
                return confirmPoolIssue(ownedCfg, issue);
            });
            if (replaced) return replaced;
            blockedReplacement = true;
        }
        // A blocked replacement must retain its original owner's protections.
        if (blockedReplacement || !cfg.enabled) return null;
        const issue = await preparePoolIssue(await latestOpeningConfig(cfg), locked, planFor(planType), { jobKey });
        record(jobKey, 'card_auto_issue_started', '没有合格现有卡，已登记开卡申请', {
            issue_key: issue.issue_key, product_code: issue.product_code });
        return confirmPoolIssue(cfg, issue);
    }

    async function reusable(cfg, locked, jobKey, planType, liveCards, excludedCardIds = []) {
        const plan = planFor(planType), live = new Map(liveCards.map(card => [Number(card.card_id),card]));
        const saved = await locked.listCards();
        const owned=saved.filter(row=>row.active_job===jobKey);
        if(owned.length>1 || owned.some(row=>!live.has(Number(row.card_id))
            || !poolPolicy.eligible(row))) {
            throw new CardPreparationError('原订单已预占卡片但平台列表或可用状态不一致，请核对原订单');
        }
        const relevant=saved.filter(row => live.has(Number(row.card_id))
            && !INACTIVE_CARD_STATUSES.has(live.get(Number(row.card_id)).provider_status)
            && poolPolicy.eligible(row)
            && (!row.active_job || row.active_job===jobKey));
        let details;
        try {
            details = await cardsApi.cardDetailsInBatches(cfg, relevant.map(row => Number(row.card_id)), { allowPartial: true });
        } catch(error) {
            if(!(error instanceof CardDataError)) throw error;
            throw new CardSelectionError('平台批量卡片详情不完整，无法确认可用支付卡；CDK 已锁定，请联系人工售后');
        }
        if (relevant.length && !details.length) {
            throw new CardSelectionError('平台卡片列表非空但批量详情全部缺失，无法确认可用支付卡；请联系人工售后');
        }
        const decision = decideCards({ saved, listed: liveCards, detailed: details,
            jobKey, planType, priceFor: plan => planPrice(cfg, plan), excludedCardIds });
        for (const skipped of decision.skipped) record(jobKey, 'card_unavailable', '卡片已从本次支付选择中排除', skipped);
        if (details.length) await locked.syncCards(details);
        record(jobKey, 'card_payment_decision', '支付卡准备决策', {
            action: decision.action, candidates: decision.candidates.length, waiting: decision.waiting, skipped: decision.skipped.length });
        let occupied = decision.waiting.some(card => card.reason === 'busy');
        for (const { row, card, target, fundingAmount, fundingSufficient } of decision.candidates) {
            if (!fundingSufficient) throw new CardPreparationError('支付卡余额不足，按套餐全额补款后仍不满足支付金额；充值已停止，请联系客服');
            const reserved = await locked.reserveCard(card.card_id, jobKey, planType);
            if (!reserved) {
                if(row.active_job===jobKey) throw new CardPreparationError('原订单预占卡片状态已变更，禁止换卡或重复开卡');
                occupied = true;
                continue;
            }
            record(jobKey, 'card_reserved', '已预占状态可用的支付卡', {
                card_id: card.card_id, plan_type: plan, availability_basis: 'card_errors' });
            record(jobKey,'card_funds_before_subscription','订阅提交前支付卡资金快照',{
                card_id:card.card_id,balance:card.balance_amount,required_balance:money.decimal(target),currency:card.currency});
            if(fundingAmount>0n) {
                requireFunds(jobKey,await account(cfg),fundingAmount);
                return fundingService.ensure(cfg,locked,jobKey,plan,card,target,fundingAmount);
            }
            return card;
        }
        if(owned.length) throw new CardPreparationError('原订单预占卡片暂不可支付，禁止换卡或重复开卡');
        if (occupied) {
            throw new CardBusyError('支付卡正在使用，请等待原任务完成或核对原资金记录；本次未开新卡');
        }
        if (decision.action === 'wait') {
            throw new CardPreparationError('支付卡平台状态尚未确认，请同步卡片并核对原记录');
        }
        if (decision.skipped.some(card => ['invalid_detail', 'order_count_unconfirmed'].includes(card.reason))) {
            throw new CardSelectionError('现有支付卡的详情或成功订单次数尚未核对完整，请同步卡片后重试');
        }
        if (decision.skipped.some(card => card.reason === 'invalid_payment_data')) {
            throw new CardPreparationError('候选支付卡的实时币种或余额资料不完整，请同步卡片后重试');
        }
        return null;
    }

    async function allocate(cfg, jobKey, planType, selection = {}) {
        await assertPaymentAllowed(cfg, jobKey);
        return store.withCardAllocationLock(cfg.base_url, async cardMethods => {
            await assertPaymentAllowed(cfg, jobKey);
            requirePlanPrice(cfg, planType);
            const locked = selection.manualRequestId ? {
                ...cardMethods,
                reserveCard: (cardId, key, plan) => store.reserveManualCard(selection.manualRequestId, cardId, key, plan)
            } : cardMethods;
            // Every selection (including manual requests) starts with
            // a complete provider snapshot. Never fall back to cached card state.
            async function refreshCards() {
                const listed = await cardsApi.listCards(cfg);
                const live = new Map(listed.map(card => [Number(card.card_id), card]));
                const missing = (await locked.listCards()).filter(card => !live.has(Number(card.card_id)));
                await locked.syncCards(listed.map(card => card.provider_status === 'DELETED' ? {...card, balance:null} : card));
                await locked.syncCards(missing.map(card => ({...card,
                    provider_status:card.provider_status === 'DELETED' ? 'DELETED' : 'UNAVAILABLE',
                    bin:card.card_bin, balance:null})));
                record(jobKey, 'cards_refreshed_before_selection', '选卡前已更新卡台状态，注销及列表缺失卡片已停用', {
                    listed_ids: listed.map(card => card.card_id),
                    removed_ids: [...listed.filter(card => card.provider_status === 'DELETED'), ...missing].map(card => Number(card.card_id))
                });
                if (missing.some(card => card.active_job === jobKey))
                    throw new CardPreparationError('原订单卡片不在平台列表，禁止换卡重复充值');
                // Recovery must first resolve the original financial operation.
                // Unrelated cards cannot block it through their transaction API.
                return listed;
            }
            function requireListedCard(listed, cardId) {
                const card = listed.find(card => Number(card.card_id) === Number(cardId));
                if (!card || card.provider_status === 'DELETED') {
                    throw new CardPreparationError('原订单卡片已注销或不在卡台列表中，已停止支付，请核对原订单；禁止换卡重复充值');
                }
            }
            const originalFunding=await locked.fundingForJob(jobKey);
            if(originalFunding) {
                if(originalFunding.scope!==cardScope(cfg.base_url)
                    || originalFunding.credential_hash!==credentialHash(cfg)
                    || originalFunding.plan_type!==planFor(planType)) {
                    throw new CardPreparationError('原补款的平台、密钥或套餐与当前订单不一致，禁止继续支付');
                }
                if (originalFunding.state === 'failed') throw new CardPreparationError('原补款已失败，请确认原订单后重新发起兑换');
                requireListedCard(await refreshCards(), originalFunding.card_id);
                const card = originalFunding.state==='ready'
                    ? await cardsApi.cardDetail(cfg,originalFunding.card_id)
                    : await fundingService.confirm(cfg,locked,originalFunding);
                await locked.syncCards([card]);
                const reservation = (await locked.listCards()).find(row => Number(row.card_id)===Number(originalFunding.card_id));
                if(!reservation || reservation.active_job!==jobKey || !poolPolicy.eligible(reservation)) {
                    throw new CardPreparationError('原补款卡片占用归属已变更，禁止继续提交订阅');
                }
                const price=requirePlanPrice(cfg,planType);
                const required=money.units(price);
                if(card.provider_status!=='ACTIVE' || card.currency!=='USD' || card.balance_amount===null
                    || money.units(card.balance_amount)<money.units(originalFunding.target_balance)
                    || money.units(card.balance_amount)<required) {
                    throw new CardPreparationError('原补款卡片尚未满足支付金额，请继续核对原补款，禁止换卡重复充值');
                }
                return card.card_id;
            }
            const originalIssue = await locked.issueForJob(jobKey);
            if (originalIssue) {
                if (originalIssue.plan_type !== planFor(planType) || originalIssue.credential_hash !== credentialHash(cfg)) {
                    throw new CardPreparationError('原开卡申请的套餐或密钥不一致，请核对原订单');
                }
                if (originalIssue.state === 'failed') throw new CardPreparationError('原开卡已失败，请确认原订单后重新发起兑换');
                const listed = await refreshCards();
                if (originalIssue.card_id) requireListedCard(listed, originalIssue.card_id);
                // Finish this job's original issue before looking at unrelated cards.
                if (originalIssue.state !== 'ready') throw new CardPreparationError('原开卡申请须先完成对账，请查询原申请');
                const opened = await cardsApi.cardDetail(cfg, originalIssue.card_id);
                const selected = await reusable(cfg, locked, jobKey, planType, [opened]);
                if (!selected || selected.card_id !== Number(opened.card_id)) {
                    throw new CardPreparationError('原开卡申请的卡片暂不可支付，请核对原卡；禁止重新开卡');
                }
                return selected.card_id;
            }
            const listed = await refreshCards();
            const excludedIds = selection.excludedCardIds || [];
            const existing = await reusable(cfg, locked, jobKey, planType, listed, excludedIds);
            if (existing) return existing.card_id;
            const opened = await openCardForPayment(cfg, locked, jobKey, planType);
            if (opened) {
                const selected = await reusable(cfg, locked, jobKey, planType, [opened], excludedIds);
                if (selected) return selected.card_id;
            }
            throw new CardPreparationError('没有可用支付卡，请管理员补充卡片或核对停用卡的补开申请');
        });
    }

    // Short, read-only financial reconciliation. Never allocates another card or
    // sends a funding request. The caller sleeps after this allocation lock ends.
    async function confirmFunding(cfg, jobKey, planType) {
        try {
            return await store.withCardAllocationLock(cfg.base_url, async locked => {
                await assertReconciliationAllowed(cfg, jobKey);
                const funding = await locked.fundingForJob(jobKey);
                if (!funding || funding.plan_type !== planFor(planType)) throw new CardPreparationError('原补款记录缺失或套餐不匹配，请人工核对');
                const owner = await store.paymentOwner(jobKey);
                const reservation = (await locked.listCards()).find(row => Number(row.card_id) === Number(funding.card_id));
                if (!owner.localReleased && (!reservation || reservation.active_job !== jobKey)) throw new CardPreparationError('原补款卡片占用归属已变更，请人工核对');
                const releaseOnly = owner.localReleased || ['funding_review','funding_pending'].includes(owner.state);
                const card = await fundingService.confirm(cfg, locked, funding, { readOnly: true, releaseOnly, localReleased: owner.localReleased });
                await assertReconciliationAllowed(cfg, jobKey);
                if (releaseOnly) return card.card_id;
                const latest = (await locked.listCards()).find(row => Number(row.card_id) === Number(card.card_id));
                if (!latest || latest.active_job !== jobKey || !poolPolicy.eligible(latest)) {
                    throw new CardPreparationError('原补款卡片当前不符合支付条件，请核对原订单');
                }
                return card.card_id;
            });
        } catch (error) {
            if (error.code === 'CARD_ALLOCATION_BUSY') throw new FundingAwaitingError('其他任务正在准备卡片，稍后继续核对原补款', FUNDING_POLL_MS);
            throw error;
        }
    }

    async function synchronize(cfg) {
        return store.withCardAllocationLock(cfg.base_url, async locked => {
            try {
                const listed = await cardsApi.listCards(cfg);
                await locked.syncCards(listed);
                const retired = await reconcileLegacyRetirements(cfg, locked, listed);
                const deleted = listed.filter(card => card.provider_status === 'DELETED' || retired.has(card.card_id));
                const readable = listed.filter(card => card.provider_status !== 'DELETED' && !retired.has(card.card_id));
                const detailed = await cardsApi.cardDetailsInBatches(cfg,readable.map(card=>card.card_id),{allowPartial:true});
                const live = new Map(listed.map(card => [card.card_id, card]));
                // Absence from a complete list means unavailable, not proven deletion.
                // Retain quotas and reservations for existing orders.
                const saved = await locked.listCards();
                const missing = saved.filter(card => !live.has(Number(card.card_id)));
                // List metadata can fill identification fields, never the detail balance/status.
                for (const card of detailed) {
                    card.product_code ||= live.get(card.card_id)?.product_code || '';
                    card.bin ||= live.get(card.card_id)?.bin || '';
                    card.last4 ||= live.get(card.card_id)?.last4 || '';
                }
                await locked.syncCards(detailed);
                await locked.syncCards([
                    ...deleted.map(card => ({...card, provider_status:'DELETED', balance:null})),
                    ...missing.map(card => ({...card, provider_status:card.provider_status === 'DELETED' || retired.has(Number(card.card_id)) ? 'DELETED' : 'UNAVAILABLE',
                        bin:card.card_bin, balance:null}))
                ]);
                if (saved.some(row => poolPolicy.exhausted(row) && !row.disabled_at)) await locked.disableExhaustedCards();
                const confirmed = new Set(detailed.map(card => card.card_id));
                const result = { count: confirmed.size, listed_ids: listed.map(card => card.card_id),
                    synced_ids: [...confirmed], failed_ids: readable.filter(card => !confirmed.has(card.card_id)).map(card => card.card_id),
                    removed_ids: [...new Set([...deleted, ...missing, ...detailed.filter(card => card.provider_status === 'DELETED')].map(card => Number(card.card_id)))],
                    checked_at: new Date(now()).toISOString() };
                record('', 'cards_synchronized', '已同步平台卡片摘要，注销及列表缺失卡片已停用；其他缺失详情保留本地快照并标记未同步', result);
                return result;
            } catch (error) {
                record('', 'cards_sync_failed', '平台卡片同步失败，本地快照未确认，请勿视为实时余额', {
                    reason: error instanceof CardPreparationError ? error.message : 'local_sync_error' });
                throw error;
            }
        });
    }
    async function apply(cfg) {
        if (!cfg.enabled) throw new CardPreparationError('请先开启 Orbitcard 接单配置');
        return store.withCardAllocationLock(cfg.base_url, async locked => {
            const pending = await pendingCardIssues(locked);
            let [issue] = pending;
            if (pending.length > 1 || issue?.job_key) {
                throw new CardPreparationError('存在其他待确认开卡申请，请先恢复原订单，暂停新增开卡');
            }
            await assertPaymentAllowed(cfg, null);
            if (issue?.replacement_for_job_key) {
                let card;
                const handled = await withRecoveryOwner(cfg, issue, async (ownedCfg, options) => {
                    card = await confirmIssue(ownedCfg, locked, issue, maxIssuePolls, options);
                }, { issueReconciliation: true });
                if (!handled) throw new CardPreparationError('原补开申请不可继续提交，请核对原订单及开卡记录');
                return card;
            }
            if (!issue) {
                issue = await preparePoolIssue(cfg, locked, 'plus');
                record('', 'card_issue_prepared', '已保存管理员开卡申请', {
                    issue_key: issue.issue_key, plan_type: issue.plan_type, product_code: issue.product_code,
                    amount: issue.amount, currency: 'USD', parameters: JSON.parse(issue.request_body) });
            }
            return confirmIssue(cfg, locked, issue);
        });
    }
    let recovering = false;
    async function recover(cfg, { confirmIssues = false } = {}) {
        if (recovering) {
            if (confirmIssues) throw new CardBusyError('开卡与补款记录正在核对，请稍后重试');
            return;
        }
        recovering = true;
        try {
            await store.withCardAllocationLock(cfg.base_url, async locked => {
                await fundingService.recover(cfg,locked);
                const candidates = [];
                for (const issue of await pendingCardIssues(locked, true)) {
                    if (Number(issue.retry_at || 0) > now()) continue;
                    const neverSent = issue.state === 'prepared' && !issue.order_no;
                    // Background recovery may close an unsent manual request locally.
                    // Sending a createCard request requires selection or an admin action.
                    if (neverSent ? issue.replacement_for_card_id || issue.issue_key.startsWith(AUTO_ISSUE_PREFIX) : !confirmIssues) continue;
                    candidates.push(issue);
                }
                candidates.sort((a,b) => new Date(a.updated_at || a.created_at || 0)-new Date(b.updated_at || b.created_at || 0));
                for(const issue of candidates) {
                    const handled = await withRecoveryOwner(cfg, issue, async (ownedCfg, options) => {
                        // Prepared means the remote-write marker was never committed.
                        if (issue.state === 'prepared' && !issue.order_no && !issue.replacement_for_card_id && !options.localReleased) {
                            await locked.updateIssue(issue.issue_key, { state: 'failed', message: '服务在开卡提交前中断，未发送该申请' });
                            return;
                        }
                        try { await confirmIssue(ownedCfg, locked, issue, 1, options); }
                        catch (error) {
                            if (error instanceof PaymentStoppedError) throw error;
                            await locked.updateIssue(issue.issue_key,{state:'unknown',
                                retry_at:Math.max(Number(issue.retry_at || 0),now()+Math.max(60000,error.retryAfterMs || 0)),
                                message:error.disposition ? `${error.disposition.message}；保留原开卡申请` : '原开卡申请尚待确认或人工核对，保留原身份'});
                            record(issue.job_key, 'card_issue_pending', '原开卡申请尚待确认，保留原幂等身份', { issue_key: issue.issue_key });
                        }
                    }, { issueReconciliation: true });
                    if (handled) break;
                }
                if (cfg.enabled) await reconcileLegacyRetirements(cfg, locked);
            });
        } finally { recovering = false; }
    }
    let balanceCache=null;
    async function transactions(cfg,cardId,page=1) {
        const id=cardsApi.positiveId(cardId),number=Number(page);
        if(!id || !Number.isSafeInteger(number) || number<1 || number>10000) throw new CardPreparationError('交易查询参数无效');
        return store.withCardAllocationLock(cfg.base_url, async locked => {
            const card=await cardsApi.cardDetail(cfg,id);
            const ids=await readAuthorizations(api,cfg,id);
            await locked.syncCards([card]);
            await locked.saveAuthorizations(id,ids);
            const saved=(await locked.listCards()).find(row => Number(row.card_id) === id);
            return {successful_order_count:Number(saved.successful_order_count),availability_basis:'card_errors',disabled_at:saved.disabled_at,disabled_reason:saved.disabled_reason,card_id:id,card_status:card.provider_status,card_balance:card.balance_amount,currency:card.currency,
                authorization_count:saved?.authorization_count == null ? null : Number(saved.authorization_count),
                authorizations_checked_at:saved?.authorizations_checked_at,
                ...await transactionRows(cfg,id,number)};
        });
    }
    async function transactionRows(cfg,id,number) {
        const result=await api.request(cfg,'cardTransaction',{card_id:id,page:number,page_size:50});
        if(!result.success) throw new CardPreparationError(result.error || '平台消费交易读取失败，请检查交易读取权限');
        if(!Array.isArray(result.data?.list)) throw new CardPreparationError('平台消费交易响应格式无效');
        const list=[];
        for(const row of result.data.list) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new CardPreparationError('消费交易记录格式无效');
            if(row.card_id!=null && Number(row.card_id)!==id) throw new CardPreparationError('消费交易卡片归属不一致');
            const safe={};
            for(const key of ['transaction_id','id','card_id','transaction_type','type','status','merchant','mcc','amount',
                'authorization_amount','settlement_amount','currency','authorized_at','settled_at','created_at']) {
                if(['string','number'].includes(typeof row[key])) safe[key]=typeof row[key]==='string'?row[key].slice(0,128):row[key];
            }
            list.push(safe);
        }
        const total=result.data.total==null?null:Number(result.data.total);
        if(total!=null && (!Number.isSafeInteger(total) || total<list.length)) throw new CardPreparationError('消费交易分页总数无效');
        return {page:number,total,transactions:list};
    }
    async function reconcile(cfg,cardId,jobKey) {
        cardId=cardsApi.positiveId(cardId);
        if(!cardId) throw new CardPreparationError('交易查询参数无效');
        const identity={...cfg,auditJobKey:jobKey};
        const [card,balance,flows]=await Promise.allSettled([
            cardsApi.cardDetail(identity,cardId),account(identity),transactionRows(identity,cardId,1)]);
        const snapshot={card_id:cardId,availability_basis:'card_errors',card_status:card.status==='fulfilled'?card.value.provider_status:null,
            card_balance:card.status==='fulfilled'?card.value.balance_amount:null,
            account_available:balance.status==='fulfilled'?money.decimal(balance.value):null,
            observed_transactions:flows.status==='fulfilled'?flows.value.transactions.length:null,
            transaction_query_ok:flows.status==='fulfilled'};
        record(jobKey,'payment_funds_snapshot','订阅结果后只读核对账户、卡片和消费交易摘要',snapshot);
        return snapshot;
    }
    async function canResumeBalance(cfg,task) {
        if(String(cfg.base_url || '').replace(/\/+$/,'')!==String(task.orbitcard_base_url || '').replace(/\/+$/,'')) throw new CardPreparationError('余额锁定任务的平台地址与原配置不同');
        if(task.orbitcard_api_key_hash && task.orbitcard_api_key_hash!==credentialHash(cfg)) throw new CardPreparationError('余额锁定任务的 API Key 与原配置不同，请恢复原凭据后核对');
        const identity=`${cfg.base_url}:${credentialHash(cfg)}`;
        if(!balanceCache || balanceCache.identity!==identity || balanceCache.until<=now()) balanceCache={identity,until:now()+5000,pending:account(cfg)};
        let available;
        try { available=await balanceCache.pending; } catch(error) {balanceCache=null;throw error;}
        return available>=money.units(task.orbitcard_required_balance);
    }
    return { allocate, confirmFunding, synchronize, apply, recover, canResumeBalance, transactions, reconcile };
};
