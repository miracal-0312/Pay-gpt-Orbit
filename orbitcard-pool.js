'use strict';
const DEFAULT_MAX_SUCCESSFUL_ORDERS = 4;
function validateLimit(value) {
    if (!['number','string'].includes(typeof value) || String(value).trim() === '') throw new Error('单卡成功会员订单上限必须为正安全整数');
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('单卡成功会员订单上限必须为正安全整数');
    return limit;
}
function successfulOrderLimit(cfg) {
    // Keep the persisted configuration key so upgrades preserve custom limits.
    return validateLimit(cfg?.orbitcard_max_authorizations ?? DEFAULT_MAX_SUCCESSFUL_ORDERS);
}
function eligible(card, limit = DEFAULT_MAX_SUCCESSFUL_ORDERS) {
    limit = validateLimit(limit);
    return card.successful_order_count != null && Number.isSafeInteger(Number(card.successful_order_count))
        && Number(card.successful_order_count) >= 0 && Number(card.successful_order_count) < limit
        && !card.retirement_key;
}

module.exports = { DEFAULT_MAX_SUCCESSFUL_ORDERS, validateLimit, successfulOrderLimit, eligible };
