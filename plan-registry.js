'use strict';
const PLAN_TYPES = Object.freeze(['plus', 'pro100', 'pro200', 'pro500']);
const LEGACY_PLAN_ALIASES = Object.freeze({ pro_5x: 'pro100', pro_20x: 'pro200' });
const PLAN_LABELS = Object.freeze({ plus: 'ChatGPT Plus', pro100: 'ChatGPT Pro 100', pro200: 'ChatGPT Pro 200', pro500: 'ChatGPT Pro 500',
    pro_5x: 'ChatGPT Pro 5x（历史）', pro_20x: 'ChatGPT Pro 20x（历史）' });
function normalizePlanType(value, { allowLegacy = true } = {}) {
    const type = String(value || '').trim().toLowerCase();
    if (PLAN_TYPES.includes(type)) return type;
    if (allowLegacy && Object.hasOwn(LEGACY_PLAN_ALIASES, type)) return LEGACY_PLAN_ALIASES[type];
    throw new Error(`不支持的套餐: ${type || '空值'}`);
}
module.exports = { PLAN_TYPES, PLAN_LABELS, LEGACY_PLAN_ALIASES, normalizePlanType };
