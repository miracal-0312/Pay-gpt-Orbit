'use strict';
const poolPolicy = require('./orbitcard-pool');
const { CardPreparationError, CardBusyError, AccountBalanceError, CardDataError, CardSelectionError, FundingAwaitingError, FUNDING_POLL_MS } = require('./orbitcard-card-policy');

const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const cardsApi = require('./orbitcard-cards-client');
const { readAuthorizations } = require('./orbitcard-authorizations');
const { planFor, cardScope } = require('./orbitcard-card-policy');
const money = require('./orbitcard-money');
const { PLAN_TYPES } = require('../config/plan-registry');
const { decideCards } = require('./orbitcard-payment-decision');
const { planPrice } = require('../config/orbitcard-config');
const { PaymentStoppedError } = require('../payments/payment-automation');
const { classifyApiError } = require('./orbitcard-error-policy');

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
    async function withRecoveryOwner(cfg, entry, action, { issueReconciliation = false } = {}) {
        const owner = await store.paymentOwner(entry.job_key);
        const originalIssueOnly = issueReconciliation && Boolean(entry.job_key)
            && (owner.allowed || owner.canReconcileIssue);
        if (!owner.allowed && !originalIssueOnly) return false;
        // Historical order-bound applications reconcile their original identity.
        // Shared replacement applications are owned by the card pool.
        if (originalIssueOnly && entry.state !== 'prepared' && !entry.order_no) return false;
        // Dedicated funding reconciliation owns these jobs. The legacy card
        // maintenance pass must not lengthen their delay or resend funding.
        if (['funding_waiting','funding_review','funding_pending'].includes(owner.state)) return false;
        const assertOwner = originalIssueOnly ? assertIssueReconciliationAllowed : assertPaymentAllowed;
        if (!owner.keys.length) {
            await assertOwner(cfg, entry.job_key);
            await action(cfg, { originalIssueOnly });
            return true;
        }
        const guard = await store.acquirePaymentLock(owner.keys);
        if (!guard) return false;
        try {
            const ownedCfg = { ...cfg, executionGuard: guard };
            await assertOwner(ownedCfg, entry.job_key);
            await action(ownedCfg, { originalIssueOnly });
            return true;
        } catch (error) {
            if (error instanceof PaymentStoppedError) return false;
            throw error;
        } finally { await guard.release(); }
    }
    const fundingService = require('./orbitcard-funding-service')({api,cardsApi,audit,now,
        assertPaymentAllowed, assertReconciliationAllowed, withRecoveryOwner});
    const retire = require('./orbitcard-retirement')({api, cardsApi});
    const orderSync = require('./orbitcard-order-sync')({ api, store });
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

    async function maintainPool(cfg, locked, listed) {
        if (!cfg.enabled) return listed;
        const removed = new Set();
        async function retireAndRecord(card, row, isListed = true) {
            if (row.active_job) throw new CardPreparationError('待删除卡片仍有订单占用，暂停卡片退役');
            const deleted = await retire(cfg, locked, card, row, { listed: isListed });
            removed.add(Number(card.card_id));
            record('', 'card_pool_retired', '已确认完成卡片退役删除', {
                card_id: card.card_id, successful_order_count: row.successful_order_count,
                ...(deleted.refunded_amount == null ? {} : {refunded_amount: deleted.refunded_amount}) });
        }
        // Recover durable delete intents before deciding current card eligibility.
        for (const row of await locked.listCards()) {
            if (!row.retirement_key) continue;
            const card = listed.find(card => Number(card.card_id) === Number(row.card_id));
            if (!card && row.provider_status === 'DELETED') continue;
            await retireAndRecord(card || row, row, Boolean(card));
        }
        const live = listed.filter(card => card.provider_status !== 'DELETED' && !removed.has(Number(card.card_id)));
        // Replacement issuance runs in allocation and background recovery.
        return live.filter(card => !removed.has(Number(card.card_id)));
    }

    async function confirmIssue(cfg, locked, issue, polls = maxIssuePolls, { originalIssueOnly = false } = {}) {
        const assertAllowed = originalIssueOnly ? assertIssueReconciliationAllowed : assertPaymentAllowed;
        await assertAllowed(cfg, issue.job_key);
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
            await assertAllowed(cfg, issue.job_key);
            const result = await api.request({ ...cfg, auditJobKey: issue.job_key || cfg.auditJobKey || '' }, 'createCard', body, issue.issue_key);
            await assertAllowed(cfg, issue.job_key);
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
                await assertAllowed(cfg, issue.job_key);
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

    async function applyManualCard(cfg, locked, planType) {
        await assertPaymentAllowed(cfg, null);
        const plan = planFor(planType);
        let issue = await locked.pendingIssue(plan);
        if (issue?.job_key) {
            throw new CardPreparationError('同套餐另一笔开卡申请尚待确认，请先核对原申请，不能将其卡片分配给当前订单');
        }
        if (!issue) {
            // Refresh before a new issue; an unresolved issue retains its original body and key.
            const products = await cardsApi.products(cfg);
            const selected = cardsApi.chooseOpeningProduct(products,cfg,(await locked.listIssues())[0]?.product_code);
            const body = cardsApi.createCardBody(selected);
            requireFunds('',await account(cfg),money.units(body.amount));
            await assertPaymentAllowed(cfg, null);
            issue = await locked.createManualIssue({ issue_key: `card-${crypto.randomUUID()}`, ...selected,
                plan_type:plan,
                credential_hash: credentialHash(cfg), request_body: JSON.stringify(body) });
            record('', 'card_issue_prepared', '已保存管理员开卡申请', {
                issue_key: issue.issue_key, plan_type: plan, product_code: issue.product_code, amount: issue.amount, currency: 'USD',parameters:body });
        }
        return confirmIssue(cfg, locked, issue);
    }

    async function replaceDisabledCard(cfg, locked, planType, knownProducts = null) {
        if (!cfg.enabled && !cfg.auditJobKey) return null;
        for (const row of await locked.listCards()) {
            if (!row.disabled_at || row.disabled_code === 'manual' || row.active_job) continue;
            const failureJobKey = row.disabled_job_key || '';
            let issue = await locked.replacementForCard(row.card_id, failureJobKey);
            if (issue && ['ready', 'failed'].includes(issue.state)) continue;
            if (!issue) {
                // A unique issue per card and failure survives restarts and retries.
                for (const plan of PLAN_TYPES) {
                    if (await locked.pendingIssue(plan)) throw new CardBusyError('原开卡申请正在确认，等待原申请完成后补开');
                }
                const products = knownProducts || await cardsApi.products(cfg);
                const selected = cardsApi.chooseOpeningProduct(products, cfg, (await locked.listIssues())[0]?.product_code);
                const body = cardsApi.createCardBody(selected);
                requireFunds(cfg.auditJobKey, await account(cfg), money.units(body.amount));
                await assertPaymentAllowed(cfg, cfg.auditJobKey || null);
                issue = await locked.createManualIssue({ issue_key: `card-${crypto.randomUUID()}`,
                    plan_type: planFor(planType), ...selected, credential_hash: credentialHash(cfg),
                    request_body: JSON.stringify(body), replacement_for_card_id: row.card_id, replacement_for_job_key: failureJobKey });
                record(cfg.auditJobKey, 'card_replacement_started', '卡片因订阅错误停用，已登记补开申请', {
                    card_id: Number(row.card_id), failure_code: row.disabled_code,
                    issue_key: issue.issue_key, product_code: selected.product_code });
            }
            try {
                const card = await confirmIssue(cfg, locked, issue, 1);
                record(cfg.auditJobKey, 'card_replacement_ready', '停用卡的补开申请已完成', {
                    disabled_card_id: Number(row.card_id), card_id: card.card_id, issue_key: issue.issue_key });
                return card;
            } catch (error) {
                const latest = await locked.replacementForCard(row.card_id, failureJobKey);
                if (latest && !['ready', 'failed'].includes(latest.state)) {
                    record(cfg.auditJobKey, 'card_replacement_pending', '补开申请待确认，保留原请求身份', {
                        card_id: Number(row.card_id), issue_key: issue.issue_key });
                    throw new CardBusyError('支付卡补开申请正在确认，卡片就绪后将继续选卡');
                }
                throw error;
            }
        }
        return null;
    }

    async function reusable(cfg, locked, jobKey, planType, liveCards, products, excludedCardIds = []) {
        const plan = planFor(planType), live = new Map(liveCards.map(card => [Number(card.card_id),card]));
        const saved = await locked.listCards();
        const owned=saved.filter(row=>row.active_job===jobKey);
        if(owned.length>1 || owned.some(row=>!live.has(Number(row.card_id))
            || !poolPolicy.eligible(row))) {
            throw new CardPreparationError('原订单已预占卡片但平台列表或可用状态不一致，请核对原订单');
        }
        const relevant=saved.filter(row => live.has(Number(row.card_id))
            && !['DELETED','CANCELLED','FROZEN'].includes(live.get(Number(row.card_id)).provider_status)
            && poolPolicy.eligible(row)
            && (!row.active_job || row.active_job===jobKey));
        const details=new Map();
        try {
            for(const card of await cardsApi.cardDetailsInBatches(cfg,relevant.map(row=>Number(row.card_id)),{allowPartial:true}))
                details.set(card.card_id,card);
        } catch(error) {
            if(!(error instanceof CardDataError)) throw error;
            throw new CardSelectionError('平台批量卡片详情不完整，无法确认可用支付卡；CDK 已锁定，请联系人工售后');
        }
        if(relevant.length && details.size===0) {
            throw new CardSelectionError('平台卡片列表非空但批量详情全部缺失，无法确认可用支付卡；请联系人工售后');
        }
        const decision = decideCards({ saved, listed: liveCards, detailed: [...details.values()], products,
            jobKey, planType, priceFor: (_product, plan) => planPrice(cfg, plan), excludedCardIds });
        for (const skipped of decision.skipped) record(jobKey, 'card_unavailable', '卡片已从本次支付选择中排除', skipped);
        for (const card of details.values()) await locked.syncCards([card]);
        record(jobKey, 'card_payment_decision', '支付卡准备决策', {
            action: decision.action, candidates: decision.candidates.length, waiting: decision.waiting, skipped: decision.skipped.length });
        let busy = false;
        const candidates = decision.candidates;
        for (const candidate of candidates) {
            const {row,card,target,fundingAmount,fundingSufficient}=candidate;
            if (!fundingSufficient) throw new CardPreparationError('支付卡余额不足，按套餐全额补款后仍不满足最低留存要求；充值已停止，请联系客服');
            const reserved = await locked.reserveCard(card.card_id, jobKey, planType);
            if (!reserved) {
                if(row.active_job===jobKey) throw new CardPreparationError('原订单预占卡片状态已变更，禁止换卡或重复开卡');
                busy=true;continue;
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
        const occupied = busy || decision.waiting.some(card => card.reason === 'busy');
        if (occupied) {
            throw new CardBusyError('支付卡正在使用，请等待原任务完成或核对原资金记录；本次未开新卡');
        }
        if (busy || decision.action === 'wait') {
            const statusUnknown = decision.waiting.some(card => card.reason === 'status_unconfirmed');
            throw new CardPreparationError(statusUnknown ? '支付卡平台状态尚未确认，请同步卡片并核对原记录'
                : '支付卡正在使用，请等待原任务完成或核对原资金记录；本次未开新卡');
        }
        return null;
    }

    async function allocate(cfg, jobKey, planType, selection = {}) {
        cfg = await latestOpeningConfig(cfg);
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
                const products=await cardsApi.products(cfg);
                const product=products.find(item=>item.product_code===(card.product_code || reservation.product_code));
                const price=requirePlanPrice(cfg,planType);
                if (!product) throw new CardPreparationError('原补款卡片的实时产品资料缺失，禁止继续支付');
                const required=money.units(price)+money.units(product.min_retained_balance);
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
                const products = await cardsApi.products(cfg);
                const selected = await reusable(cfg, locked, jobKey, planType, [opened], products);
                if (!selected || selected.card_id !== Number(opened.card_id)) {
                    throw new CardPreparationError('原开卡申请的卡片暂不可支付，请核对原卡；禁止重新开卡');
                }
                return selected.card_id;
            }
            const products = await cardsApi.products(cfg);
            let listed = await refreshCards();
            const excludedIds = selection.excludedCardIds || [];
            const waitingForReplacement = (await locked.listCards()).some(row => row.disabled_at
                && excludedIds.map(Number).includes(Number(row.card_id)));
            if (!waitingForReplacement) {
                const existing = await reusable(cfg, locked, jobKey, planType, listed, products, excludedIds);
                if (existing) return existing.card_id;
            }
            const replacement = await replaceDisabledCard(cfg, locked, planType, products);
            if (replacement) listed = [replacement];
            const selected = await reusable(cfg, locked, jobKey, planType, listed, products, excludedIds);
            if (selected) return selected.card_id;
            throw new CardPreparationError('没有可用支付卡，请管理员补充卡片或核对停用卡的补开申请');
        });
    }

    // Short, read-only financial reconciliation. Never allocates another card or
    // sends a funding request. The caller sleeps after this allocation lock ends.
    async function confirmFunding(cfg, jobKey, planType) {
        cfg = await latestOpeningConfig(cfg);
        try {
            return await store.withCardAllocationLock(cfg.base_url, async locked => {
                await assertReconciliationAllowed(cfg, jobKey);
                const funding = await locked.fundingForJob(jobKey);
                if (!funding || funding.plan_type !== planFor(planType)) throw new CardPreparationError('原补款记录缺失或套餐不匹配，请人工核对');
                const reservation = (await locked.listCards()).find(row => Number(row.card_id) === Number(funding.card_id));
                if (!reservation || reservation.active_job !== jobKey) throw new CardPreparationError('原补款卡片占用归属已变更，请人工核对');
                const owner = await store.paymentOwner(jobKey);
                const releaseOnly = ['funding_review','funding_pending'].includes(owner.state);
                const card = await fundingService.confirm(cfg, locked, funding, { readOnly: true, releaseOnly });
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
        // Order-history I/O must not hold the allocation lock. Per-card row locks
        // serialize successful-order imports against live payment settlement.
        const observed = await cardsApi.listCards(cfg);
        await store.withCardAllocationLock(cfg.base_url, locked => locked.syncCards(observed));
        let orderResult;
        try { orderResult = await orderSync.synchronize(cfg, observed); }
        catch (error) {
            orderResult = { complete: false, added: 0, error: error instanceof CardPreparationError ? error.message : '会员订单同步失败，保留已确认计数' };
        }
        record('', 'card_orders_synchronized', orderResult.complete ? '已核对卡台成功会员订单' : '会员订单未完全同步，保留已确认计数', orderResult);
        return store.withCardAllocationLock(cfg.base_url, async locked => {
            try {
                let listed = await cardsApi.listCards(cfg);
                await locked.syncCards(listed);
                listed = await maintainPool(cfg, locked, listed);
                const deleted = listed.filter(card => card.provider_status === 'DELETED');
                const readable = listed.filter(card => card.provider_status !== 'DELETED');
                const detailed = await cardsApi.cardDetailsInBatches(cfg,readable.map(card=>card.card_id),{allowPartial:true});
                const live = new Map(listed.map(card => [card.card_id, card]));
                // Absence from a complete list means unavailable, not proven deletion.
                // Retain quotas and reservations for reconciliation of historical orders.
                const missing = (await locked.listCards()).filter(card => !live.has(Number(card.card_id)));
                // List metadata can fill identification fields, never the detail balance/status.
                for (const card of detailed) {
                    card.product_code ||= live.get(card.card_id)?.product_code || '';
                    card.bin ||= live.get(card.card_id)?.bin || '';
                    card.last4 ||= live.get(card.card_id)?.last4 || '';
                }
                await locked.syncCards(detailed);
                await locked.syncCards([
                    ...deleted.map(card => ({...card, balance:null})),
                    ...missing.map(card => ({...card, provider_status:card.provider_status === 'DELETED' ? 'DELETED' : 'UNAVAILABLE',
                        bin:card.card_bin, balance:null}))
                ]);
                const confirmed = new Set(detailed.map(card => card.card_id));
                const result = { order_sync: orderResult, count: detailed.length, listed_ids: listed.map(card => card.card_id),
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
            if ((await locked.listCards()).some(card => card.retirement_key && card.provider_status !== 'DELETED'))
                throw new CardPreparationError('存在未确认删卡申请，请先同步卡池');
            const pending = [];
            for (const plan of PLAN_TYPES) {
                const issue = await locked.pendingIssue(plan);
                if (issue) pending.push(issue);
            }
            if (pending.length > 1 || pending.some(issue => issue.job_key))
                throw new CardPreparationError('存在其他待确认开卡申请，请先恢复原订单，暂停新增开卡');
            // Applying for a card alone needs no membership price; those budgets belong to redemption.
            // A historical pool application keeps its original plan/body/key.
            return applyManualCard(cfg,locked,pending[0]?.plan_type || 'plus');
        });
    }
    let recovering = false;
    async function recover(cfg) {
        if (recovering) return;
        recovering = true;
        try {
            await store.withCardAllocationLock(cfg.base_url, async locked => {
                await fundingService.recover(cfg,locked);
                const candidates=[];
                for (const plan of PLAN_TYPES) {
                    const issue = await locked.pendingIssue(plan);
                    if(issue && Number(issue.retry_at || 0)<=now()) candidates.push(issue);
                }
                candidates.sort((a,b) => new Date(a.updated_at || a.created_at || 0)-new Date(b.updated_at || b.created_at || 0));
                for(const issue of candidates) {
                    const handled = await withRecoveryOwner(cfg, issue, async (ownedCfg, options) => {
                        // Prepared means the remote-write marker was never committed.
                        if (issue.state === 'prepared' && !issue.replacement_for_card_id) {
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
                try { await replaceDisabledCard(cfg, locked, 'plus'); }
                catch (error) {
                    record('', 'card_replacement_deferred', '停用卡补开尚未完成，请核对开卡记录、账户余额和产品设置', {
                        reason: error instanceof CardPreparationError ? error.message : 'replacement_unavailable' });
                }
            });
        } finally { recovering = false; }
    }
    let balanceCache=null;
    async function transactions(cfg,cardId,page=1) {
        cfg = await latestOpeningConfig(cfg);
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
        cfg = await latestOpeningConfig(cfg);
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
