'use strict';
function eligible(card) {
    return Boolean(card) && !card.disabled_at && !card.retirement_key;
}

module.exports = { eligible };
