'use strict';

const { confirmedFailure } = require('../payments/payment-retry-policy');
const { classifyFailure } = require('./orbitcard-error-policy');

function cardFailure(snapshot) {
    const policy = classifyFailure(snapshot);
    return policy.disableCard ? { code: policy.code, reason: policy.reason } : null;
}

async function disableFailedCard({ runExecute, scope, cardId, jobKey, snapshot, expected, options }) {
    if (!confirmedFailure(snapshot, expected)) return false;
    const failure = cardFailure(snapshot);
    if (!failure) return false;
    await runExecute(`UPDATE orbitcard_managed_cards SET disabled_at = COALESCE(disabled_at, UTC_TIMESTAMP(3)),
        disabled_code = COALESCE(disabled_code, ?), disabled_reason = COALESCE(disabled_reason, ?),
        disabled_job_key = COALESCE(disabled_job_key, ?) WHERE scope = ? AND card_id = ?`,
    [failure.code, failure.reason, jobKey, scope, cardId], options);
    return true;
}

module.exports = { cardFailure, disableFailedCard };
