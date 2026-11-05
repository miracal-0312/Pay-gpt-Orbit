'use strict';
const SIZE = 5, MAX_USES = 6;
function awaitingAuthorization(card) {
    return card.authorization_pending_count != null
        && (card.authorization_count == null || Number(card.authorization_count) < Number(card.authorization_pending_count));
}
function eligible(card) {
    return card.authorization_count != null && Number.isSafeInteger(Number(card.authorization_count))
        && Number(card.authorization_count) >= 0 && Number(card.authorization_count) < MAX_USES
        && !awaitingAuthorization(card) && !card.retirement_key;
}

module.exports = { SIZE, MAX_USES, eligible, awaitingAuthorization };
