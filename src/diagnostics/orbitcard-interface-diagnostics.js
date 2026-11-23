'use strict';
const crypto = require('node:crypto');
const { OPERATIONS } = require('../orbitcard/orbitcard-api-contract');
const { normalizeBaseUrl } = require('../config/orbitcard-config');
const { CardPreparationError, cardScope } = require('../orbitcard/orbitcard-card-policy');
const { PROVIDER_PLANS, paymentPlan } = require('../config/plan-registry');
const { validOrder } = require('../payments/orbitcard-cdk');
const { normalizeCard } = require('../orbitcard/orbitcard-cards-client');

const LABELS = Object.freeze({ getAccountBalance: '账户余额', getProductCode: '开卡产品',
    getSubscriptionPlans: '订阅套餐', getSubscriptionPaymentRegions: '四档支付地区', getSubscription: '待确认订阅订单',
    getCardList: '卡片列表', cardDetail: '卡片详情', cardTransaction: '消费交易', getCardFlow: '卡片充值流水',
    createCard: '手动开卡', rechargeCard: '卡片补款', deleteCard: '卡片注销', createSubscription: '创建订阅' });
const CARD_OPERATIONS = new Set(['cardDetail', 'cardTransaction', 'getCardFlow']);
const PENDING_ORDER_STATES = new Set(['submitting', 'pending']);
const STATUS_VALUES = new Set(['ACTIVE', 'INACTIVE', 'FROZEN', 'CANCELLED', 'DELETED', 'PENDING', 'SUCCESS', 'FAILED',
    'pending', 'processing', 'succeeded', 'failed', 'success', 'manual', 'completed', 'pending_confirm']);
const positiveId = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f]/.test(value);
const rows = data => Array.isArray(data) ? data : ['list', 'items', 'cards'].map(key => data?.[key]).find(Array.isArray);
const count = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const amount = value => typeof value === 'string' && /^\d{1,14}(?:\.\d{1,8})?$/.test(value) ? value : null;
const operationRow = operation => ({ operation, path: OPERATIONS[operation].path, label: LABELS[operation],
    mode: OPERATIONS[operation].write ? 'local_simulation' : 'live_read' });
const OPERATION_ORDER = ['getAccountBalance', 'getProductCode', 'getSubscriptionPlans', 'getSubscriptionPaymentRegions',
    'getCardList', 'cardDetail', 'cardTransaction', 'getCardFlow', 'getSubscription',
    'createCard', 'rechargeCard', 'deleteCard', 'createSubscription'];

// Diagnostics deliberately bypass payment services: querying must never reserve,
// settle, reconcile, retry a payment, or persist an upstream response.
module.exports = function createInterfaceDiagnostics({ store, provider = require('../orbitcard/orbitcard-client'),
    simulation = require('./orbitcard-interface-simulation') }) {
    async function config() {
        const cfg = await store.getGptApiConfig();
        return { ...cfg, base_url: normalizeBaseUrl(cfg.base_url) };
    }
    async function manifest() {
        const cfg = await config();
        return { success: true, target: cfg.base_url, operations: OPERATION_ORDER.map(operationRow) };
    }
    async function selectedCard(cfg, input) {
        if (Object.hasOwn(input, 'card_id')) return positiveId(input.card_id);
        const saved = await store.cardMethods(cfg.base_url).listCards();
        return saved.filter(card => card.provider_status !== 'DELETED').map(card => positiveId(card.card_id)).find(Boolean) || null;
    }
    async function selectedOrder(cfg) {
        const hash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
        const scope = cardScope(cfg.base_url);
        const queries = [
            [`SELECT orbitcard_client_order_no AS client_order_no, gpt_api_order_id AS task_no,
                orbitcard_plan_type AS plan_type, orbitcard_card_id AS card_id, orbitcard_state AS state,
                orbitcard_base_url AS base_url, orbitcard_api_key_hash AS api_key_hash, updated_at
                FROM task_logs WHERE orbitcard_base_url = ? AND orbitcard_api_key_hash = ?
                AND orbitcard_client_order_no IS NOT NULL
                AND orbitcard_state IN ('submitting','pending')
                ORDER BY updated_at DESC LIMIT 1`, [cfg.base_url, hash]],
            [`SELECT client_order_no, task_no, plan_type, card_id, state, scope, api_key_hash, updated_at
                FROM orbitcard_admin_orders WHERE scope = ? AND api_key_hash = ? AND client_order_no IS NOT NULL
                AND state IN ('submitting','pending')
                ORDER BY updated_at DESC LIMIT 1`, [scope, hash]]
        ];
        const candidates = (await Promise.all(queries.map(([sql, params]) => store.runQuery(sql, params)))).flat();
        return candidates.filter(row => row.api_key_hash === hash && (row.scope === scope || row.base_url === cfg.base_url)
            && PENDING_ORDER_STATES.has(row.state) && identifier(row.client_order_no)
            && (!row.task_no || identifier(row.task_no)) && positiveId(row.card_id))
            .sort((a, b) => (new Date(b.updated_at).getTime() || 0) - (new Date(a.updated_at).getTime() || 0))[0] || null;
    }
    function summarize(operation, data, body, expected) {
        if (operation === 'getAccountBalance') {
            if (!amount(data?.available_balance)) throw Error('shape');
            return { available_balance: amount(data.available_balance) };
        }
        if (operation === 'getSubscriptionPlans') {
            if (typeof data?.enabled !== 'boolean' || !Array.isArray(data.plans)) throw Error('shape');
            return { enabled: data.enabled, plan_count: data.plans.length,
                supported_plans: data.plans.map(row => row?.type).filter(type => Object.values(PROVIDER_PLANS).includes(type)) };
        }
        if (operation === 'getSubscriptionPaymentRegions') {
            if (data?.plan_type !== body.plan_type || !Array.isArray(data.payment_regions)) throw Error('shape');
            const regions = [...new Set(data.payment_regions.filter(row => /^[A-Z]{2}$/.test(row?.code || '')).map(row => row.code))];
            if (!regions.length) throw Error('shape');
            return { plan_type: body.plan_type, region_count: regions.length, regions };
        }
        if (operation === 'getSubscription') {
            if (!validOrder(data, expected)) throw Error('ownership');
            return { ownership_matched: true, status: STATUS_VALUES.has(data.status) ? data.status : 'unknown',
                subscription_succeeded: typeof data.subscription_succeeded === 'boolean' ? data.subscription_succeeded : null };
        }
        if (operation === 'cardDetail') {
            if (!data || typeof data !== 'object' || Array.isArray(data)
                || Object.hasOwn(data, 'success') && data.success !== true) throw Error('shape');
            if (Object.hasOwn(data, 'data') && (!data.data || typeof data.data !== 'object' || Array.isArray(data.data))) throw Error('shape');
            const card = normalizeCard(data.data || data), outerId = data.card_id ?? data.cardId;
            if (outerId != null && positiveId(outerId) !== body.card_id || card.card_id && card.card_id !== body.card_id) throw Error('ownership');
            if (!positiveId(outerId) && !card.card_id) throw Error('ownership');
            if (!card.provider_status) throw Error('shape');
            return { card_id: body.card_id, status: STATUS_VALUES.has(card.provider_status) ? card.provider_status : 'unknown' };
        }
        const list = rows(data);
        if (!list) throw Error('shape');
        if (CARD_OPERATIONS.has(operation) && (data?.card_id != null && positiveId(data.card_id) !== body.card_id
            || list.some(row => row?.card_id != null && positiveId(row.card_id) !== body.card_id))) throw Error('ownership');
        if (operation === 'getCardFlow' && data.type != null && data.type !== body.type) throw Error('shape');
        const summary = { returned_count: list.length };
        if (count(data?.total) !== null) summary.total = count(data.total);
        if (operation === 'getCardList') summary.selected_card_id = list
            .filter(row => (row?.status || row?.card_status) !== 'DELETED')
            .map(row => positiveId(row?.card_id ?? row?.cardId ?? row?.id)).find(Boolean) || null;
        if (CARD_OPERATIONS.has(operation)) summary.card_id = body.card_id;
        return summary;
    }
    async function read(cfg, operation, body, expected) {
        const start = Date.now();
        try {
            const response = await provider.request(cfg, operation, body);
            const metadata = { elapsed_ms: Date.now() - start };
            if (Number.isSafeInteger(response?.status) && response.status >= 100 && response.status <= 599) metadata.http_status = response.status;
            if (Number.isSafeInteger(response?.code)) metadata.platform_code = response.code;
            if (response?.success !== true || response.requestError || response.data?.request_error) return { ...metadata,
                status: 'failed', message: '平台查询未通过，请检查连接、接口权限及请求限制' };
            try { return { ...metadata, status: 'passed', message: '只读请求及响应格式校验通过', summary: summarize(operation, response.data, body, expected) }; }
            catch { return { ...metadata, status: 'failed', message: '平台已响应，但数据格式或查询归属校验未通过' }; }
        } catch { return { status: 'failed', elapsed_ms: Date.now() - start, message: '接口查询暂不可用；未修改支付订单' }; }
    }
    async function run(input = {}) {
        if (!input || Object.getPrototypeOf(input) !== Object.prototype
            || Object.keys(input).some(key => !['operation', 'card_id'].includes(key))
            || typeof input.operation !== 'string' || !Object.hasOwn(OPERATIONS, input.operation)
            || Object.hasOwn(input, 'card_id') && (!CARD_OPERATIONS.has(input.operation) || !positiveId(input.card_id))) {
            throw new CardPreparationError('请选择已注册的接口及有效卡片 ID；测试仅使用已保存配置');
        }
        const started = Date.now(), operation = input.operation, cfg = await config();
        const base = operationRow(operation);
        const finish = result => ({ success: true, result: { ...base, ...result, elapsed_ms: Date.now() - started } });
        if (OPERATIONS[operation].write) {
            const result = await simulation.simulate(operation);
            return finish({ status: result.passed ? 'passed' : 'failed',
                message: result.passed ? '本地参数校验通过；未发送平台请求，未验证真实写入权限' : '本地参数校验未通过；未发送平台请求',
                summary: { validation: 'request_contract', sent_to_platform: false },
                checks: (result.checks || []).map(check => ({ name: String(check.name).slice(0, 80), status: check.status === 'passed' ? 'passed' : 'failed' })) });
        }
        if (operation === 'getSubscriptionPaymentRegions') {
            const checks = await Promise.all(Object.values(PROVIDER_PLANS).map(async plan_type =>
                ({ plan_type, ...await read(cfg, operation, { plan_type }) })));
            return finish({ status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
                message: '四档套餐各查询一次；每档结果见明细', checks });
        }
        let body = {}, expected;
        if (operation === 'getCardList') body = { page: 1, page_size: 100 };
        if (CARD_OPERATIONS.has(operation)) {
            const cardId = await selectedCard(cfg, input);
            if (!cardId) return finish({ status: 'skipped', message: '当前平台没有本地可选卡片；请先测试卡片列表后重试' });
            body = operation === 'cardDetail' ? { card_id: cardId, reveal_sensitive: false }
                : { card_id: cardId, page: 1, page_size: 100, ...(operation === 'getCardFlow' ? { type: 'recharge' } : {}) };
        }
        if (operation === 'getSubscription') {
            const order = await selectedOrder(cfg);
            if (!order) return finish({ status: 'skipped', message: '当前平台及 API 身份没有待确认的订阅订单' });
            let planType;
            try { planType = PROVIDER_PLANS[paymentPlan(order.plan_type)]; }
            catch { return finish({ status: 'skipped', message: '本地原订单套餐无法识别，未发送查询' }); }
            expected = { clientOrderNo: order.client_order_no, orderId: order.task_no || undefined, planType, cardId: Number(order.card_id) };
            body = order.task_no ? { task_no: order.task_no } : { client_order_no: order.client_order_no };
        }
        return finish(await read(cfg, operation, body, expected));
    }
    return { manifest, run };
};
