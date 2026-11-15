'use strict';
const DEFAULT_MAX_AUTHORIZATIONS = 4;
function validateLimit(value) {
    if (!['number','string'].includes(typeof value) || String(value).trim() === '') throw new Error('单卡成功会员订单上限必须为正安全整数');
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('单卡成功会员订单上限必须为正安全整数');
    return limit;
}
function authorizationLimit(cfg) {
    return validateLimit(cfg?.orbitcard_max_authorizations ?? DEFAULT_MAX_AUTHORIZATIONS);
}
function eligible(card, limit = DEFAULT_MAX_AUTHORIZATIONS) {
    limit = validateLimit(limit);
    return card.successful_order_count != null && Number.isSafeInteger(Number(card.successful_order_count))
        && Number(card.successful_order_count) >= 0 && Number(card.successful_order_count) < limit
        && !card.retirement_key;
}

module.exports = { DEFAULT_MAX_AUTHORIZATIONS, validateLimit, authorizationLimit, eligible };
