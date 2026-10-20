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
    if (input.provider && input.provider !== 'orbitcard') throw new Error('第三方代充仅支持 Orbitcard HMAC V1');
    const cfg = {
        enabled: input.enabled == null ? Boolean(existing.enabled) : Boolean(input.enabled),
        base_url: normalizeBaseUrl(input.base_url || existing.base_url || DEFAULT_BASE_URL),
        api_key: String(input.api_key || existing.api_key || '').trim(),
        orbitcard_card_id: String(input.orbitcard_card_id ?? existing.orbitcard_card_id ?? '').trim(),
        orbitcard_region: String(input.orbitcard_region ?? existing.orbitcard_region ?? '').trim().toUpperCase(),
        orbitcard_max_fee: String(input.orbitcard_max_fee ?? existing.orbitcard_max_fee ?? '').trim()
    };
    const card = Number(cfg.orbitcard_card_id);
    if (cfg.orbitcard_card_id && (!Number.isSafeInteger(card) || card <= 0)) throw new Error('平台卡 ID 必须为正整数');
    if (cfg.orbitcard_region && !/^[A-Z]{2}$/.test(cfg.orbitcard_region)) throw new Error('支付地区必须为两位地区代码');
    if (cfg.orbitcard_max_fee && !/^\d+(?:\.\d+)?$/.test(cfg.orbitcard_max_fee)) throw new Error('最高服务费必须为非负十进制金额');
    if (cfg.enabled && (!cfg.api_key || !cfg.orbitcard_card_id || !secretAvailable)) {
        throw new Error('启用 Orbitcard 前必须配置 API Key、平台卡 ID 和服务端 ORBITCARD_API_SECRET');
    }
    return cfg;
}

module.exports = { DEFAULT_BASE_URL, PROTOCOL_VERSION, RETIRED_CONFIG_KEYS, normalizeBaseUrl, migrationValues, prepareConfig };
