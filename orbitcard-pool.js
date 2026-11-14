'use strict';
const MAX_USES = 4;
function validateLimit(value) {
    if (!['number','string'].includes(typeof value) || String(value).trim() === '') throw new Error('单卡成功授权次数上限必须为正安全整数');
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('单卡成功授权次数上限必须为正安全整数');
    return limit;
}
function authorizationLimit(cfg) {
    return validateLimit(cfg?.orbitcard_max_authorizations ?? MAX_USES);
}
function awaitingAuthorization(card) {
    return card.authorization_pending_count != null
        && (card.authorization_count == null || Number(card.authorization_count) < Number(card.authorization_pending_count));
}
function eligible(card, _now = Date.now(), limit = MAX_USES) {
    limit = validateLimit(limit);
    return card.authorization_count != null && Number.isSafeInteger(Number(card.authorization_count))
        && Number(card.authorization_count) >= 0 && Number(card.authorization_count) < limit
        && !awaitingAuthorization(card) && !card.retirement_key;
}

module.exports = { MAX_USES, validateLimit, authorizationLimit, eligible, awaitingAuthorization };
