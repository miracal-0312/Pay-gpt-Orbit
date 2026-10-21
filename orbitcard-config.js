'use strict';

const DEFAULT_BASE_URL = 'https://orbitcard.cc';
const PROTOCOL_VERSION = 'orbitcard-hmac-v1';
const RETIRED_CONFIG_KEYS = ['gpt_api_provider', 'gpt_api_plan_key', 'gpt_api_country', 'gpt_api_currency'];

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
        Object.assign(changes, { gpt_api_enabled: '0', gpt_api_key: '', gpt_api_base_url: DEFAULT_BASE_URL });
    }
    return changes;
}

function prepareConfig(input, existing = {}, secretAvailable = false) {
    if (input.enabled != null && typeof input.enabled !== 'boolean') throw new Error('启用开关必须为布尔值');
    if (input.provider && input.provider !== 'orbitcard') throw new Error('第三方代充仅支持 Orbitcard HMAC V1');
    const cfg = {
        enabled: input.enabled == null ? Boolean(existing.enabled) : Boolean(input.enabled),
        base_url: normalizeBaseUrl(input.base_url || existing.base_url || DEFAULT_BASE_URL),
        api_key: String(input.api_key || existing.api_key || '').trim(),
        orbitcard_region: String(input.orbitcard_region ?? existing.orbitcard_region ?? '').trim().toUpperCase(),
        orbitcard_max_fee: String(input.orbitcard_max_fee ?? existing.orbitcard_max_fee ?? '').trim(),
        orbitcard_product_code: String(input.orbitcard_product_code ?? existing.orbitcard_product_code ?? '').trim(),
        orbitcard_safety_margin: String(input.orbitcard_safety_margin ?? existing.orbitcard_safety_margin ?? '1').trim(),
        orbitcard_max_initial_amount: String(input.orbitcard_max_initial_amount ?? existing.orbitcard_max_initial_amount ?? '').trim()
    };
    for (const plan of ['plus','pro100','pro200','pro500']) {
        const key = `orbitcard_price_${plan}`;
        cfg[key] = String(input[key] ?? existing[key] ?? '').trim();
        if (cfg[key] && (!/^\d+(?:\.\d{1,2})?$/.test(cfg[key]) || Number(cfg[key]) <= 0 || Number(cfg[key]) > 99999999)) throw new Error('套餐单次预算必须为正 USD 金额，最多两位小数');
        const regionKey = `orbitcard_region_${plan}`;
        cfg[regionKey] = String(input[regionKey] ?? existing[regionKey] ?? '').trim().toUpperCase();
        if (cfg[regionKey] && !/^[A-Z]{2}$/.test(cfg[regionKey])) throw new Error(`${plan} 默认支付地区必须为两位地区代码`);
    }
    if (cfg.orbitcard_region && !/^[A-Z]{2}$/.test(cfg.orbitcard_region)) throw new Error('支付地区必须为两位地区代码');
    if (cfg.orbitcard_max_fee && !/^\d+(?:\.\d+)?$/.test(cfg.orbitcard_max_fee)) throw new Error('最高服务费必须为非负十进制金额');
    if (cfg.orbitcard_product_code.length > 128 || /[\x00-\x1f]/.test(cfg.orbitcard_product_code)) throw new Error('开卡产品代码无效');
    if (!/^\d+(?:\.\d{1,2})?$/.test(cfg.orbitcard_safety_margin) || Number(cfg.orbitcard_safety_margin) > 100) throw new Error('开卡安全余量必须为 0–100 USD，最多两位小数');
    if (cfg.orbitcard_max_initial_amount && (!/^\d+(?:\.\d{1,2})?$/.test(cfg.orbitcard_max_initial_amount) || Number(cfg.orbitcard_max_initial_amount) <= 0 || Number(cfg.orbitcard_max_initial_amount) > 99999999)) throw new Error('单卡首充上限必须为正数，最多两位小数');
    if (cfg.enabled && (!cfg.api_key || !secretAvailable)) {
        throw new Error('启用 Orbitcard 前必须配置配对的 API Key 和 API Secret');
    }
    return cfg;
}

module.exports = { DEFAULT_BASE_URL, PROTOCOL_VERSION, RETIRED_CONFIG_KEYS, normalizeBaseUrl, migrationValues, prepareConfig };
