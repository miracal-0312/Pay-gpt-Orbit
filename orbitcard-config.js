'use strict';
const { PLAN_TYPES, paymentPlan } = require('./plan-registry');
const money = require('./orbitcard-money');

const DEFAULT_BASE_URL = 'https://orbitcard.cc';
const PROTOCOL_VERSION = 'orbitcard-hmac-v1';
const RETIRED_CONFIG_KEYS = ['gpt_api_provider', 'gpt_api_plan_key', 'gpt_api_country', 'gpt_api_currency'];

function normalizePaymentRegions(input = {}, existing = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !PLAN_TYPES.includes(key))) throw new Error('请选择四档套餐各自的默认充值地区');
    return Object.fromEntries(PLAN_TYPES.map(plan => {
        const raw = Object.hasOwn(input, plan) ? input[plan] : existing[plan] ?? '';
        if (typeof raw !== 'string') throw new Error('充值地区必须是两位地区代码或留空使用平台默认');
        const code = raw.trim().toUpperCase();
        if (code && !/^[A-Z]{2}$/.test(code)) throw new Error('充值地区必须是两位地区代码或留空使用平台默认');
        return [plan, code];
    }));
}

function paymentRegion(cfg, planType) {
    return normalizePaymentRegions(cfg.orbitcard_payment_regions)[paymentPlan(planType)];
}

function normalizePlanPrices(input = {}, existing = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !PLAN_TYPES.includes(key))) throw new Error('请配置四档套餐各自的 USD 卡支付金额');
    return Object.fromEntries(PLAN_TYPES.map(plan => {
        const raw = Object.hasOwn(input, plan) ? input[plan] : existing[plan] ?? '';
        if (typeof raw !== 'string') throw new Error('套餐 USD 卡支付金额必须为正数金额字符串，或留空暂停该套餐');
        const value = raw.trim();
        if (!value) return [plan, ''];
        let amount;
        try { amount = money.units(value); } catch (_) { throw new Error('套餐 USD 卡支付金额格式无效，最多 14 位整数和 8 位小数'); }
        if (amount <= 0n) throw new Error('套餐 USD 卡支付金额必须大于零，或留空暂停该套餐');
        return [plan, money.decimal(amount)];
    }));
}

function planPrice(cfg, planType) {
    try { return normalizePlanPrices(cfg?.orbitcard_plan_prices)[paymentPlan(planType)] || null; }
    catch (_) { return null; }
}

function normalizeBaseUrl(raw) {
    const url = new URL(String(raw || DEFAULT_BASE_URL).trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
        throw new Error('Orbitcard Base URL 必须为 HTTPS 根域名，例如 https://orbitcard.cc');
    }
    return url.origin;
}

function migrationValues(saved) {
    if (saved.gpt_api_protocol_version === PROTOCOL_VERSION) return {};
    const changes = { gpt_api_protocol_version: PROTOCOL_VERSION };
    if (saved.gpt_api_provider !== 'orbitcard') {
        // A credential for the retired service must never be forwarded to Orbitcard.
        Object.assign(changes, { gpt_api_enabled: '0', gpt_api_base_url: DEFAULT_BASE_URL });
    }
    return changes;
}

function prepareConfig(input, existing = {}, secretAvailable = false) {
    if (input.enabled != null && typeof input.enabled !== 'boolean') throw new Error('启用开关必须为布尔值');
    if (input.provider && input.provider !== 'orbitcard') throw new Error('第三方代充仅支持 Orbitcard HMAC V1');
    const cfg = {
        enabled: input.enabled == null ? Boolean(existing.enabled) : Boolean(input.enabled),
        base_url: normalizeBaseUrl(input.base_url || existing.base_url || DEFAULT_BASE_URL),
        api_key: String(process.env.ORBITCARD_API_KEY || '').trim(),
        orbitcard_max_fee: String(input.orbitcard_max_fee ?? existing.orbitcard_max_fee ?? '').trim(),
        orbitcard_product_code: String(input.orbitcard_product_code ?? existing.orbitcard_product_code ?? '').trim(),
        orbitcard_max_initial_amount: String(input.orbitcard_max_initial_amount ?? existing.orbitcard_max_initial_amount ?? '').trim(),
        orbitcard_payment_regions: normalizePaymentRegions(input.orbitcard_payment_regions, existing.orbitcard_payment_regions),
        orbitcard_plan_prices: normalizePlanPrices(input.orbitcard_plan_prices, existing.orbitcard_plan_prices)
    };
    if (cfg.orbitcard_max_fee && !/^\d+(?:\.\d+)?$/.test(cfg.orbitcard_max_fee)) throw new Error('最高服务费必须为非负十进制金额');
    if (cfg.orbitcard_product_code.length > 128 || /[\x00-\x1f]/.test(cfg.orbitcard_product_code)) throw new Error('开卡产品代码无效');
    if (cfg.orbitcard_max_initial_amount && (!/^\d+(?:\.\d{1,2})?$/.test(cfg.orbitcard_max_initial_amount) || Number(cfg.orbitcard_max_initial_amount) <= 0 || Number(cfg.orbitcard_max_initial_amount) > 99999999)) throw new Error('单卡首充上限必须为正数，最多两位小数');
    if (cfg.enabled && (!cfg.api_key || !secretAvailable)) {
        throw new Error('启用 Orbitcard 前请在服务器环境变量配置 ORBITCARD_API_KEY 和 ORBITCARD_API_SECRET');
    }
    return cfg;
}

module.exports = { DEFAULT_BASE_URL, PROTOCOL_VERSION, RETIRED_CONFIG_KEYS, normalizeBaseUrl, migrationValues, prepareConfig,
    normalizePaymentRegions, paymentRegion, normalizePlanPrices, planPrice };
