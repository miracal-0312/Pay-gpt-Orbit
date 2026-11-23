'use strict';
const poolPolicy = require('../orbitcard/orbitcard-pool');

const crypto = require('node:crypto');
const { parseSession } = require('../payments/session-input');
const { confirmedSuccess } = require('../payments/payment-retry-policy');
const { PLAN_TYPES, PROVIDER_PLANS, paymentPlan } = require('../config/plan-registry');
const { paymentRegion, planPrice } = require('../config/orbitcard-config');
const { CardBusyError, CardPreparationError, INACTIVE_CARD_STATUSES } = require('../orbitcard/orbitcard-card-policy');
const { validateRequest } = require('../orbitcard/orbitcard-api-contract');
const { prepare: prepareTestSubscription } = require('../orbitcard/orbitcard-subscription-service')(null);
const { decideCards } = require('../orbitcard/orbitcard-payment-decision');
const { simulateSelection, taskCount } = require('./orbitcard-concurrency-simulation');
const money = require('../orbitcard/orbitcard-money');

// The supplied Session is only parsed locally. Simulation uses a synthetic fixture.
const SIMULATED_SESSION = { user: { email: 'preflight@example.invalid' }, account: {}, accessToken: 'preflight-fixture' };

// Read-only: no allocation locks, reservations, synchronization, card creation or funding.
module.exports = function createDiagnostics({ store, audit, provider = require('../orbitcard/orbitcard-client'), cards = require('../orbitcard/orbitcard-cards-client') }) {
    async function preflight(input = {}) {
        const stage = input.stage || 'full';
        if (!['session','plans','balance','regions','cards','concurrency','full'].includes(stage)) throw new Error('无效的预检步骤');
        const concurrentTasks = stage === 'concurrency' ? taskCount(input.concurrent_tasks) : null;
        const requestId = input.request_id || crypto.randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('无效的预检编号');
        const traceId = `debug-${requestId}`, steps = [], result = {};
        const full = stage === 'full';
        const simulation = { outcome: 'incomplete', funds_moved: false, order_created: false };
        if (full) result.simulation = simulation;
        let cfg, plan, available;
        let selectedCard, cardMethods, openingCost = 0n, simulatedOrder;
        const record = (event, text, data) => audit({ jobKey: traceId, source: 'diagnostics', event, text, data });
        async function step(name, text, action, simulated = false) {
            const started = Date.now(); record('preflight_started', text, { step: name, read_only: true, simulated });
            try {
                const data = await action();
                const row = { step: name, state: 'passed', elapsed_ms: Date.now() - started, message: text, simulated, data };
                steps.push(row); record('preflight_passed', text, row); return true;
            } catch (error) {
                const message = name === 'session' ? 'Session 格式、账号邮箱或有效期不符合要求，请重新获取完整 Session'
                    : error instanceof CardPreparationError ? error.message : '该步骤暂不可用，请检查接口权限或服务端状态';
                const state = error instanceof CardBusyError ? 'waiting' : 'failed';
                const row = { step: name, state, elapsed_ms: Date.now() - started, message, simulated };
                steps.push(row); record(`preflight_${state}`, message, row); return false;
            }
        }
        async function session() {
            parseSession(input.session);
            return { valid_structure: true, authentication: 'not_verified', forwarded_to_platform: false };
        }
        async function plans() {
            const response = await provider.fetchPlans(cfg);
            if (!response.success) throw new CardPreparationError('卡台套餐查询失败，请检查订阅读取权限');
            result.plans = (response.plans || []).filter(item => Object.values(PROVIDER_PLANS).includes(item.type))
                .map(item => ({ type: item.type, name: String(item.name || item.type).slice(0,128) }));
            if (stage !== 'plans' && !result.plans.some(item => item.type === PROVIDER_PLANS[plan])) throw new CardPreparationError('当前套餐未在卡台开放');
            return { plans: result.plans, selected_plan: plan ? PROVIDER_PLANS[plan] : null };
        }
        async function balance() {
            const response = await provider.request(cfg, 'getAccountBalance');
            if (!response.success) throw new CardPreparationError('账户余额查询失败，请检查账户读取权限');
            available = money.units(response.data?.available_balance);
            result.available_balance = money.decimal(available);
            return { available_balance: result.available_balance };
        }
        async function regions() {
            const response = await provider.request(cfg, 'getSubscriptionPaymentRegions', { plan_type: PROVIDER_PLANS[plan] });
            if (!response.success || response.data?.plan_type !== PROVIDER_PLANS[plan] || !Array.isArray(response.data?.payment_regions)) {
                throw new CardPreparationError('当前套餐地区读取失败或响应不匹配');
            }
            const selected = paymentRegion(cfg, plan);
            const options = response.data.payment_regions.filter(item => /^[A-Z]{2}$/.test(item?.code || ''))
                .map(item => ({ code: item.code, default: item.default === true }));
            result.region = { configured: selected || null, mode: selected ? 'configured' : 'platform_default', options };
            if (selected && !options.some(item => item.code === selected)) throw new CardPreparationError('该套餐保存的地区已不可用，请在默认充值地区中重新选择并保存');
            return result.region;
        }
        async function selectionSnapshot() {
            if (!planPrice(cfg, plan)) throw new CardPreparationError('请先在后台配置当前套餐的 USD 支付金额，已停止代充');
            const listed = await cards.listCards(cfg);
            cardMethods = store.cardMethods(cfg.base_url);
            const existing = await cardMethods.listCards();
            const saved = existing.map(row => ({ ...row }));
            for (const card of listed) if (!saved.some(row => Number(row.card_id) === card.card_id)) {
                saved.push({ card_id: card.card_id, successful_order_count: 0 });
            }
            const summaries = listed.map(card => ({ card_id: card.card_id, status: card.provider_status,
                successful_order_count: saved.find(row => Number(row.card_id) === card.card_id)?.successful_order_count,
                max_successful_orders: poolPolicy.MAX_SUCCESSFUL_ORDERS,
                availability_basis: 'card_errors', disabled_at: saved.find(row => Number(row.card_id) === card.card_id)?.disabled_at,
                busy: Boolean(saved.find(row => Number(row.card_id) === card.card_id)?.active_job),
                balance: null, currency: card.currency || null }));
            result.selection = { action: 'wait', card_id: null, candidate_count: 0, skipped: [], waiting: [],
                cards: summaries, reserved: false, account_check: 'passed', snapshot_only: true };
            const readable = listed.filter(card => card.provider_status !== 'DELETED');
            const snapshotNow = Date.now();
            const relevant = saved.filter(row => readable.some(card => card.card_id === Number(row.card_id)
                && !INACTIVE_CARD_STATUSES.has(card.provider_status))
                && poolPolicy.eligible(row) && !row.active_job);
            const detailed = await cards.cardDetailsInBatches(cfg, relevant.map(row => Number(row.card_id)), { allowPartial: true });
            if (relevant.length && !detailed.length) throw new CardPreparationError('批量卡片详情全部缺失，停止选卡，请联系售后');
            for (const card of detailed) {
                const summary = summaries.find(item => item.card_id === card.card_id);
                if (summary) Object.assign(summary, { status: card.provider_status, balance: card.balance_amount, currency: card.currency });
            }
            return { saved, listed: full ? listed : readable, detailed, now: snapshotNow };
        }
        async function concurrency() {
            const snapshot = await selectionSnapshot();
            result.concurrency = await simulateSelection({ snapshot, count: concurrentTasks, available,
                planType: plan, jobPrefix: traceId, priceFor: type => planPrice(cfg, type) });
            delete result.selection;
            return result.concurrency;
        }
        async function selection() {
            const snapshot = await selectionSnapshot();
            const { saved, listed: readable } = snapshot;
            const decision = decideCards({ ...snapshot, jobKey: traceId, planType: plan,
                priceFor: type => planPrice(cfg, type) });
            const selected = decision.candidates[0];
            Object.assign(result.selection, { action: decision.action, card_id: selected?.card.card_id || null,
                candidate_count: decision.candidates.length, skipped: decision.skipped, waiting: decision.waiting });
            const funding = selected?.fundingAmount || 0n;
            if (selected) {
                result.selection.funding_amount = money.cents(funding);
                if (!selected.fundingSufficient) throw new CardPreparationError('支付卡余额不足，按套餐全额补款后仍不满足套餐金额，请联系客服');
                selectedCard = selected;
            } else if (full) {
                if (decision.waiting.some(card => card.reason === 'busy')) throw new CardBusyError('合格卡片正在使用，模拟停在等待空闲卡');
                if (decision.action === 'wait' || decision.skipped.some(card =>
                    ['invalid_detail', 'invalid_payment_data', 'order_count_unconfirmed'].includes(card.reason))) {
                    throw new CardPreparationError('候选卡片的状态、实时详情或成功次数尚未确认，暂停模拟开卡');
                }
                result.selection.action = 'open';
                return result.selection;
            } else if (decision.action === 'unavailable') {
                throw new CardPreparationError('当前快照没有可选的现有卡。实际支付时会重新核对，确认缺卡后按需开卡');
            } else throw new CardPreparationError('卡片被占用或平台状态尚未确认，实际支付需要等待处理；共享等待位最多 1 个');
            const required = funding;
            if (cfg.enabled) {
                result.selection.maintenance = { current_size:readable.length,
                    quota_exhausted_card_ids:saved.filter(poolPolicy.exhausted).map(row => Number(row.card_id)), funding_amount:money.cents(funding),
                    required_balance:money.cents(required), fees_included:false, snapshot_only:true };
            }
            if (!full && available < required) {
                result.selection.account_check = 'failed';
                throw new CardPreparationError('账户可用余额不足以完成本单套餐全额补款，请联系客服；基础预算不含平台额外费用');
            }
            return result.selection;
        }
        async function opening() {
            if (!cfg.enabled) throw new CardPreparationError('当前接单配置未开启，自动开卡不可用');
            for (const type of PLAN_TYPES) {
                if (await cardMethods.pendingIssue(type)) throw new CardBusyError('有待确认的开卡申请，模拟停在确认原申请');
            }
            const products = await cards.products(cfg);
            const selected = cards.chooseOpeningProduct(products, cfg, (await cardMethods.listIssues())[0]?.product_code);
            const body = cards.createCardBody(selected);
            validateRequest('createCard', body, `${traceId}-open`);
            openingCost = money.units(body.amount);
            simulation.opening = { product_code: body.product_code, initial_deposit_usd: body.amount };
            if (available < openingCost) {
                result.selection.account_check = 'failed';
                throw new CardPreparationError('账户可用余额不足以支付开卡首充；预算仅包含已知金额');
            }
            const card = { card_id: 1, provider_status: 'ACTIVE', currency: 'USD', balance_amount: body.amount, product_code: body.product_code };
            const row = { card_id: card.card_id, successful_order_count: 0 };
            [selectedCard] = decideCards({ saved: [row], listed: [card], detailed: [card], jobKey: traceId,
                planType: plan, priceFor: type => planPrice(cfg, type) }).candidates;
            return { ...simulation.opening, simulated_card_status: 'ACTIVE' };
        }
        function funding() {
            const amount = selectedCard.fundingAmount;
            const total = openingCost + amount;
            simulation.funding = { card_source: openingCost ? 'simulated_new_card' : 'existing_card',
                card_id: openingCost ? null : selectedCard.card.card_id, topup_usd: money.cents(amount),
                account_required_usd: money.cents(total), includes_platform_fees: false };
            if (available < total) {
                result.selection.account_check = 'failed';
                throw new CardPreparationError('账户可用余额不足以完成本次资金准备；预算仅包含已知金额');
            }
            if (amount > 0n) validateRequest('rechargeCard', { card_id: selectedCard.card.card_id, amount: money.cents(amount) }, `${traceId}-fund`);
            return { ...simulation.funding, reservation: 'simulated' };
        }
        function submission() {
            const { body, expected } = prepareTestSubscription({ cfg, identity: `${traceId}-subscription`, planType: plan,
                cardId: selectedCard.card.card_id, session: SIMULATED_SESSION });
            validateRequest('createSubscription', body, expected.clientOrderNo);
            simulatedOrder = { ...expected, orderId: `${traceId}-order` };
            return { client_order_no: expected.clientOrderNo, order_id: simulatedOrder.orderId, plan_type: expected.planType,
                payment_region: body.payment_region || null, operation: 'createSubscription', simulated_status: 'processing', sent_to_platform: false };
        }
        function query() {
            const order = simulatedOrder;
            validateRequest('getSubscription', { task_no: order.orderId }, '');
            const reply = { task_no: order.orderId, client_order_no: order.clientOrderNo, card_id: order.cardId,
                plan_type: order.planType, targetEmail: order.email, query_source: 'upstream', status: 'succeeded', subscription_succeeded: true };
            if (!confirmedSuccess(reply, order)) throw new CardPreparationError('模拟原单的归属或结果校验未通过');
            return { order_id: order.orderId, operation: 'getSubscription', simulated_status: reply.status };
        }
        function settlement() {
            simulation.outcome = 'simulated_success';
            const count = Number(selectedCard.row.successful_order_count) + 1;
            simulation.settlement = { order_id: simulatedOrder.orderId, order_state: 'simulated_success',
                reservation: 'simulated_release', successful_order_count_after: count,
                reaches_card_limit: count >= poolPolicy.MAX_SUCCESSFUL_ORDERS };
            return simulation.settlement;
        }
        record('preflight_created', '已建立只读支付预检记录', { stage, read_only: true });
        if (stage === 'session' || full) {
            if (!await step('session', '本地校验 Session；尚未发送卡台', session)) return finish();
        }
        if (stage === 'session') return finish();
        if (!await step('config', '读取已保存的平台配置', async () => {
            cfg = { ...await store.getGptApiConfig(), auditJobKey: traceId };
            if (stage !== 'plans' && stage !== 'balance') {
                if (!PLAN_TYPES.includes(input.plan_type) && !Object.values(PROVIDER_PLANS).includes(input.plan_type)) throw new CardPreparationError('请选择 Plus 或三档 Pro 套餐');
                plan = paymentPlan(input.plan_type);
            }
            return { plan_type: plan || null };
        })) return finish();
        const actions = full ? ['plans','balance','regions','cards']
            : ['cards','concurrency'].includes(stage) ? ['plans','balance',stage] : [stage];
        const handlers = { plans, balance, regions, cards: selection, concurrency };
        const titles = { plans: '核对卡台已开放套餐', balance: '读取账户可用余额', regions: '核对本套餐默认支付地区', cards: '读取实时卡片和已确认的成功会员订单次数，模拟选卡与补款决策',
            concurrency: `读取实时快照，模拟 ${concurrentTasks} 个任务同时进入选卡` };
        for (const name of actions) if (!await step(name, titles[name], handlers[name])) return finish();
        if (full) {
            if (!selectedCard && !await step('opening', '按当前配置和库存模拟申请一张新卡并确认激活', opening, true)) return finish();
            const fundingTitle = selectedCard.fundingAmount > 0n ? `模拟预占支付卡后补款 ${money.cents(selectedCard.fundingAmount)} USD`
                : '模拟预占支付卡，卡内余额已足够';
            if (!await step('funding', fundingTitle, funding, true)) return finish();
            if (!await step('submission', '模拟提交订阅请求，校验套餐、地区及本次订单身份', submission, true)) return finish();
            if (!await step('query', '模拟查询同一订单，校验归属及模拟成功结果', query, true)) return finish();
            await step('settlement', '模拟记录成功次数并释放支付卡占用', settlement, true);
        }
        return finish();
        function finish() {
            const passed = steps.length > 0 && steps.every(row => row.state === 'passed');
            const ready = full && passed;
            if (full && steps.at(-1)?.state === 'waiting') simulation.outcome = 'waiting';
            record('preflight_completed', passed ? '只读预检完成；未提交 Session、订阅、补款或开卡' : '预检未通过；未执行资金操作', { passed, ready, read_only: true });
            return { success: true, trace_id: traceId, passed, ready, read_only: true, steps, result };
        }
    }
    return { preflight };
};
