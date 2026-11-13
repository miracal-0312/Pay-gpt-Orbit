'use strict';
const poolPolicy = require('./orbitcard-pool');
const { readAuthorizations } = require('./orbitcard-authorizations');

const crypto = require('node:crypto');
const { parseSession } = require('./session-input');
const { PLAN_TYPES, PROVIDER_PLANS, paymentPlan } = require('./plan-registry');
const { paymentRegion, planPrice } = require('./orbitcard-config');
const { CardPreparationError } = require('./orbitcard-card-policy');
const { decideCards } = require('./orbitcard-payment-decision');
const money = require('./orbitcard-money');

// Read-only: no allocation locks, reservations, synchronization, card creation or funding.
module.exports = function createDiagnostics({ store, audit, provider = require('./orbitcard-client'), cards = require('./orbitcard-cards-client') }) {
    async function preflight(input = {}) {
        const stage = input.stage || 'full';
        if (!['session','plans','balance','regions','cards','full'].includes(stage)) throw new Error('无效的预检步骤');
        const requestId = input.request_id || crypto.randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('无效的预检编号');
        const traceId = `debug-${requestId}`, steps = [], result = {};
        let cfg, plan, available;
        const record = (event, text, data) => audit({ jobKey: traceId, source: 'diagnostics', event, text, data });
        async function step(name, text, action) {
            const started = Date.now(); record('preflight_started', text, { step: name, read_only: true });
            try {
                const data = await action();
                const row = { step: name, state: 'passed', elapsed_ms: Date.now() - started, message: text, data };
                steps.push(row); record('preflight_passed', text, row); return true;
            } catch (error) {
                const message = name === 'session' ? 'Session 格式、账号邮箱或有效期不符合要求，请重新获取完整 Session'
                    : error instanceof CardPreparationError ? error.message : '该步骤暂不可用，请检查接口权限或服务端状态';
                const row = { step: name, state: 'failed', elapsed_ms: Date.now() - started, message };
                steps.push(row); record('preflight_failed', message, row); return false;
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
        async function selection() {
            if (!planPrice(cfg, plan)) throw new CardPreparationError('请先在后台配置当前套餐的 USD 支付金额，已停止代充');
            const products = await cards.products(cfg);
            const listed = await cards.listCards(cfg);
            const methods = store.cardMethods(cfg.base_url);
            const existing = await methods.listCards();
            const saved = existing.map(row => ({ ...row }));
            for (const card of listed) if (!saved.some(row => Number(row.card_id) === card.card_id)) {
                saved.push({ card_id: card.card_id, authorization_count: null });
            }
            const summaries = listed.map(card => ({ card_id: card.card_id, status: card.provider_status,
                authorization_count: null, authorization_limit: poolPolicy.MAX_USES,
                authorizations_checked_at: null, authorization_pending: false,
                busy: Boolean(saved.find(row => Number(row.card_id) === card.card_id)?.active_job),
                balance: null, currency: card.currency || null }));
            result.selection = { action: 'wait', card_id: null, candidate_count: 0, skipped: [], waiting: [],
                cards: summaries, reserved: false, account_check: 'passed', snapshot_only: true };
            const retired = new Set();
            // Mirror lifecycle recovery without changing the saved card or its
            // intent. A missing list item alone never confirms a deletion.
            for (const row of saved.filter(row => row.retirement_key)) {
                const id = Number(row.card_id);
                const present = listed.some(card => Number(card.card_id) === id);
                if (!present && row.provider_status === 'DELETED') continue;
                result.selection.waiting = [{card_id:id,reason:'retirement_unconfirmed'}];
                if (row.active_job) throw new CardPreparationError('待删除卡片仍有订单占用，实际支付需先确认原订单');
                const detail = await cards.cardDetail(cfg, id);
                if (Number(detail?.card_id) !== id || detail?.provider_status !== 'DELETED') {
                    throw new CardPreparationError('原删卡结果仍未确认，实际支付需要先只读查询确认删除');
                }
                retired.add(id);
                const summary = summaries.find(card => card.card_id === id);
                if (summary) summary.status = 'DELETED';
            }
            result.selection.waiting = [];
            // Merge observed authorization identities in temporary copies only.
            // A later settlement must neither double count nor erase an observed authorization.
            const readable = listed.filter(card => card.provider_status !== 'DELETED' && !retired.has(Number(card.card_id)));
            for (const card of readable) {
                const row = saved.find(row => Number(row.card_id) === card.card_id);
                const summary = summaries.find(item => item.card_id === card.card_id);
                try {
                    const persisted = await methods.listAuthorizations(card.card_id);
                    // A concurrent sync may commit new IDs after listCards returned.
                    // Older cached counts may lag this ledger; missing persisted IDs still fail closed.
                    if (!Array.isArray(persisted) || (row.authorization_count != null
                        && (!Number.isSafeInteger(Number(row.authorization_count)) || Number(row.authorization_count) < 0
                            || Number(row.authorization_count) > new Set(persisted).size))) {
                        throw new CardPreparationError('已保存的消费授权次数与交易记录不一致，请检查数据库');
                    }
                    const observed = await readAuthorizations(provider, cfg, card.card_id);
                    row.authorization_count = new Set([...persisted, ...observed]).size;
                    row.authorizations_checked_at = new Date().toISOString();
                    Object.assign(summary, { authorization_count: row.authorization_count,
                        authorizations_checked_at: row.authorizations_checked_at,
                        authorization_pending: row.authorization_pending_count != null && row.authorization_count < Number(row.authorization_pending_count) });
                } catch (error) {
                    result.selection.waiting = summaries.filter(item => item.status !== 'DELETED' && item.authorization_count == null)
                        .map(item => ({ card_id: item.card_id, reason: 'authorizations_unconfirmed' }));
                    throw error;
                }
            }
            const relevant = saved.filter(row => readable.some(card => card.card_id === Number(row.card_id)
                && !['DELETED','CANCELLED','FROZEN'].includes(card.provider_status))
                && poolPolicy.eligible(row) && !row.active_job);
            const detailed = await cards.cardDetailsInBatches(cfg, relevant.map(row => Number(row.card_id)), { allowPartial: true });
            if (relevant.length && !detailed.length) throw new CardPreparationError('批量卡片详情全部缺失，停止选卡，请联系售后');
            const decision = decideCards({ saved, listed:readable, detailed, products, jobKey: traceId, planType: plan,
                priceFor: (_product, type) => planPrice(cfg, type) });
            const selected = decision.candidates[0];
            for (const card of detailed) {
                const summary = summaries.find(item => item.card_id === card.card_id);
                if (summary) Object.assign(summary, { status: card.provider_status, balance: card.balance_amount, currency: card.currency });
            }
            Object.assign(result.selection, { action: decision.action, card_id: selected?.card.card_id || null,
                candidate_count: decision.candidates.length, skipped: decision.skipped, waiting: decision.waiting });
            let funding = selected ? money.units(money.cents(selected.deficit)) : 0n;
            let opening;
            if (selected) {
                result.selection.funding_amount = money.cents(selected.deficit);
            } else if (decision.action === 'open') {
                opening = cards.chooseProduct(products, plan, cfg);
                result.selection.opening = cards.createCardBody(opening);
                const target = money.units(planPrice(cfg, plan)) + money.units(opening.min_retained_balance);
                const deficit = target - money.units(opening.amount);
                funding = deficit > 0n ? money.units(money.cents(deficit)) : 0n;
            } else throw new CardPreparationError(decision.waiting.some(card => card.reason === 'cooldown')
                ? '卡片处于支付后 5 分钟冷却期，实际支付需要等待或使用其他可用卡'
                : '卡片被占用或消费授权仍待同步，实际支付需要等待处理');
            const required = selected ? funding : money.units(opening.amount) + funding;
            if (cfg.enabled) {
                const retiring = saved.filter(row => !row.active_job && Number(row.authorization_count) >= poolPolicy.MAX_USES
                    && readable.some(card => card.card_id === Number(row.card_id)));
                const openCount = selected ? 0 : 1;
                const openingAmount = selected ? 0n : money.units(opening.amount);
                result.selection.maintenance = { capacity_limit:null, auto_refill:false, current_size:readable.length,
                    retire_card_ids:retiring.map(row => Number(row.card_id)), open_count:openCount,
                    opening_amount:money.cents(openingAmount), funding_amount:money.cents(funding),
                    required_balance:money.cents(required), fees_included:false, snapshot_only:true };
            }
            if (available < required) {
                result.selection.account_check = 'failed';
                throw new CardPreparationError('账户可用余额不足以完成本单按需开卡和支付补款；基础预算不含平台额外费用');
            }
            return result.selection;
        }
        record('preflight_created', '已建立只读支付预检记录', { stage, read_only: true });
        if (stage === 'session' || stage === 'full') {
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
        const actions = stage === 'full' ? ['plans','balance','regions','cards']
            : stage === 'cards' ? ['plans','balance','cards'] : [stage];
        const handlers = { plans, balance, regions, cards: selection };
        const titles = { plans: '核对卡台已开放套餐', balance: '读取账户可用余额', regions: '核对本套餐默认支付地区', cards: '读取实时卡片和成功消费授权记录，模拟选卡、补款或开卡决策' };
        for (const name of actions) if (!await step(name, titles[name], handlers[name])) break;
        return finish();
        function finish() {
            const passed = steps.length > 0 && steps.every(row => row.state === 'passed');
            const ready = stage === 'full' && passed;
            record('preflight_completed', passed ? '只读预检完成；未提交 Session、订阅、补款或开卡' : '预检未通过；未执行资金操作', { passed, ready, read_only: true });
            return { success: true, trace_id: traceId, passed, ready, read_only: true, steps, result };
        }
    }
    return { preflight };
};
