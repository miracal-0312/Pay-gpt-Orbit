'use strict';

const crypto = require('node:crypto');

const { paymentPlan } = require('./plan-registry');
class CardPreparationError extends Error {}
class AccountBalanceError extends CardPreparationError {}
class FundingPendingError extends CardPreparationError {}
const FUNDING_POLL_MS = 5000;
const FUNDING_WAIT_MS = 120000;
class FundingAwaitingError extends FundingPendingError {
    constructor(message, retryAfterMs = FUNDING_POLL_MS) {
        super(message);
        this.retryAfterMs = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
            ? Math.max(FUNDING_POLL_MS, Number(retryAfterMs)) : FUNDING_POLL_MS;
    }
}
class CardDataError extends CardPreparationError {}
class CardSelectionError extends CardPreparationError {}

function planFor(planType) {
    return paymentPlan(planType);
}

function cardScope(baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
        throw new Error('卡片平台地址必须为 HTTPS 根域名');
    }
    return crypto.createHash('sha256').update(url.origin).digest('hex');
}

function settlementState(current, orbitcardState) {
    if (current === 'consumed') return current;
    if (orbitcardState === 'success') return 'consumed';
    if (['failed', 'rejected'].includes(orbitcardState)) return 'released';
    return current;
}

module.exports = { planFor, cardScope, settlementState, CardPreparationError, AccountBalanceError, FundingPendingError, FundingAwaitingError, FUNDING_POLL_MS, FUNDING_WAIT_MS,
    CardDataError, CardSelectionError };
