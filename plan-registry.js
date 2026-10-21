'use strict';
const PLAN_TYPES = Object.freeze(['plus', 'pro100', 'pro200', 'pro500']);
const PROVIDER_PLANS = Object.freeze({ plus: 'gpt-plus', pro100: 'gpt-pro-5x', pro200: 'gpt-pro-20x', pro500: 'gpt-pro-25x' });
const PROVIDER_TO_PLAN = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_PLANS).map(([plan, provider]) => [provider, plan])));
const CARD_LIMITS = Object.freeze({ plus: 4, pro100: 1, pro200: 1, pro500: 1 });
const LEGACY_PLAN_ALIASES = Object.freeze({ pro_5x: 'pro100', pro_20x: 'pro200' });
const PLAN_LABELS = Object.freeze({ plus: 'ChatGPT Plus', pro100: 'ChatGPT Pro 100', pro200: 'ChatGPT Pro 200', pro500: 'ChatGPT Pro 500',
    pro_5x: 'ChatGPT Pro 5x（历史）', pro_20x: 'ChatGPT Pro 20x（历史）' });
function normalizePlanType(value, { allowLegacy = true } = {}) {
    const type = String(value || '').trim().toLowerCase();
    if (PLAN_TYPES.includes(type)) return type;
    if (allowLegacy && Object.hasOwn(LEGACY_PLAN_ALIASES, type)) return LEGACY_PLAN_ALIASES[type];
    throw new Error(`不支持的套餐: ${type || '空值'}`);
}
function paymentPlan(value) {
    return normalizePlanType(PROVIDER_TO_PLAN[value] || value);
}
module.exports = { PLAN_TYPES, PLAN_LABELS, LEGACY_PLAN_ALIASES, normalizePlanType,
    PROVIDER_PLANS, PROVIDER_TO_PLAN, CARD_LIMITS, paymentPlan };
