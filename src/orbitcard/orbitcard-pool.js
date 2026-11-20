'use strict';
const MAX_SUCCESSFUL_ORDERS = 3;
function validCount(card) {
    return card?.successful_order_count != null && Number.isSafeInteger(Number(card.successful_order_count))
        && Number(card.successful_order_count) >= 0;
}
function exhausted(card) {
    return validCount(card) && Number(card.successful_order_count) >= MAX_SUCCESSFUL_ORDERS;
}
function eligible(card) {
    return Boolean(card) && validCount(card) && !exhausted(card) && !card.disabled_at && !card.retirement_key;
}

module.exports = { eligible, exhausted, validCount, MAX_SUCCESSFUL_ORDERS };
