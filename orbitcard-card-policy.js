'use strict';

const crypto = require('node:crypto');

const LIMITS = Object.freeze({ plus: 4, pro100: 1, pro200: 1, pro500: 1 });
class CardPreparationError extends Error {}
class AccountBalanceError extends CardPreparationError {}
class FundingPendingError extends CardPreparationError {}
class CardDataError extends CardPreparationError {}
class CardSwitchExhaustedError extends CardPreparationError {}

function planFor(planType) {
    if (['plus', 'gpt-plus'].includes(planType)) return 'plus';
    if (['pro100', 'pro_5x', 'gpt-pro-5x'].includes(planType)) return 'pro100';
    if (['pro200', 'pro_20x', 'gpt-pro-20x'].includes(planType)) return 'pro200';
    if (['pro500', 'gpt-pro-25x'].includes(planType)) return 'pro500';
    throw new Error('不支持的卡片充值套餐');
}

function cardScope(baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
        throw new Error('卡片平台地址必须为 HTTPS 根域名');
    }
    return crypto.createHash('sha256').update(url.origin).digest('hex');
}

// Count unresolved orders as occupied slots. Success replaces a reservation,
// rather than incrementing a separate counter which could be applied twice.
function capacity(planType, reservations) {
    const plan = planFor(planType);
    let used = 0, reserved = 0;
    for (const row of reservations) {
        if (row.state === 'released') continue;
        // Unknown ledger states cannot silently make a card available again.
        if (!['reserved', 'consumed'].includes(row.state) || !Object.hasOwn(LIMITS, row.plan_type)) {
            return { plan, limit: LIMITS[plan], used, reserved, remaining: 0, eligible: false, reason: 'unknown_history' };
        }
        if (row.plan_type !== plan) continue;
        if (row.state === 'consumed') used++; else reserved++;
    }
    const remaining = Math.max(0, LIMITS[plan] - used - reserved);
    const reason = remaining ? null : 'limit_reached';
    return { plan, limit: LIMITS[plan], used, reserved, remaining,
        eligible: reason === null, reason };
}

function settlementState(current, orbitcardState) {
    if (current === 'consumed') return current;
    if (orbitcardState === 'success') return 'consumed';
    if (['failed', 'rejected'].includes(orbitcardState)) return 'released';
    return current;
}

module.exports = { LIMITS, planFor, cardScope, capacity, settlementState, CardPreparationError, AccountBalanceError, FundingPendingError,
    CardDataError, CardSwitchExhaustedError };
