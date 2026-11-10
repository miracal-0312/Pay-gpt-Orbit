'use strict';
const MAX_USES = 7;
const REUSE_COOLDOWN_MS = 5 * 60 * 1000;
function coolingDown(card, now = Date.now()) {
    const until = Number(card.reuse_after_ms ?? 0);
    return !Number.isSafeInteger(until) || until < 0 || until > now;
}
function awaitingAuthorization(card) {
    return card.authorization_pending_count != null
        && (card.authorization_count == null || Number(card.authorization_count) < Number(card.authorization_pending_count));
}
function eligible(card, now = Date.now()) {
    return card.authorization_count != null && Number.isSafeInteger(Number(card.authorization_count))
        && Number(card.authorization_count) >= 0 && Number(card.authorization_count) < MAX_USES
        && !awaitingAuthorization(card) && !coolingDown(card, now) && !card.retirement_key;
}

module.exports = { MAX_USES, REUSE_COOLDOWN_MS, eligible, awaitingAuthorization, coolingDown };
