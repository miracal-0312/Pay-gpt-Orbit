'use strict';

const crypto = require('node:crypto');
const { parseSession } = require('./session-input');
const { PLAN_TYPES, PROVIDER_PLANS, paymentPlan } = require('./plan-registry');
const { paymentRegion } = require('./orbitcard-config');
const { LIMITS, CardPreparationError } = require('./orbitcard-card-policy');
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
            const products = await cards.products(cfg);
            const prices = products.map(product => cards.planPrice(product, plan)).filter(Boolean).map(money.units);
            if (!prices.length) throw new CardPreparationError('缺少当前套餐的资金校验依据，停止支付准备');
            const threshold = prices.reduce((a,b) => a < b ? a : b);
            if (available < threshold) throw new CardPreparationError('账户可用余额不足，实际支付将停止，请联系管理员充值');
            const listed = await cards.listCards(cfg);
            const existing = await store.cardMethods(cfg.base_url).listCards();
            const saved = [...existing];
            for (const card of listed) if (!saved.some(row => Number(row.card_id) === card.card_id)) {
                saved.push({ card_id: card.card_id, history_confirmed: false });
            }
            const relevant = saved.filter(row => listed.some(card => card.card_id === Number(row.card_id))
                && row.history_confirmed && Number(row[`successful_${plan}`]) < LIMITS[plan] && !row.active_job);
            const detailed = await cards.cardDetailsInBatches(cfg, relevant.map(row => Number(row.card_id)), { allowPartial: true });
            if (relevant.length && !detailed.length) throw new CardPreparationError('批量卡片详情全部缺失，停止选卡，请联系售后');
            const decision = decideCards({ saved, listed, detailed, products, jobKey: traceId, planType: plan, priceFor: cards.planPrice });
            const selected = decision.candidates[0];
            result.selection = { action: decision.action, card_id: selected?.card.card_id || null,
                candidate_count: decision.candidates.length, skipped: decision.skipped, waiting: decision.waiting,
                cards: detailed.map(card => ({ card_id: card.card_id, status: card.provider_status,
                    balance: card.balance_amount, currency: card.currency })),
                reserved: false, account_check: 'passed', snapshot_only: true };
            if (selected) {
                if (available < selected.price || available < money.units(money.cents(selected.deficit))) {
                    throw new CardPreparationError('账户可用余额不足以完成所选卡片的支付准备');
                }
                result.selection.funding_amount = money.cents(selected.deficit);
            } else if (decision.action === 'open') {
                const opening = cards.chooseProduct(products, plan, cfg);
                result.selection.opening = cards.createCardBody(opening);
                if (available < money.units(opening.amount)) throw new CardPreparationError('账户可用余额不足以首充开卡');
            } else throw new CardPreparationError('卡片被占用或历史次数未登记，实际支付需要等待处理');
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
        const titles = { plans: '核对卡台已开放套餐', balance: '读取账户可用余额', regions: '核对本套餐默认支付地区', cards: '实时读取卡片并模拟选卡、补款或开卡决策' };
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
