'use strict';
const SIZE = 5, MAX_USES = 6;
function eligible(card) {
    return card.activation_count != null && Number.isSafeInteger(Number(card.activation_count))
        && Number(card.activation_count) >= 0 && Number(card.activation_count) < MAX_USES && !card.retirement_key;
}

module.exports = { SIZE, MAX_USES, eligible };
