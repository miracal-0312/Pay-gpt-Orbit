'use strict';

const PLAN_NAME_MAP = Object.freeze({
    plus: 'chatgptplusplan',
    pro100: 'chatgptprolite',
    pro200: 'chatgptpro',
    pro500: 'chatgptpromax'
});
const LEGACY_PLAN_ALIASES = Object.freeze({ pro_5x: 'pro100', pro_20x: 'pro200' });
const PLAN_LABELS = Object.freeze({ plus: 'ChatGPT Plus', pro100: 'ChatGPT Pro 100', pro200: 'ChatGPT Pro 200', pro500: 'ChatGPT Pro 500', pro_5x: 'ChatGPT Pro 5x（历史）', pro_20x: 'ChatGPT Pro 20x（历史）' });

function normalizePlanType(value, { allowLegacy = true } = {}) {
    const type = String(value || '').trim().toLowerCase();
    if (Object.hasOwn(PLAN_NAME_MAP, type)) return type;
    if (allowLegacy && Object.hasOwn(LEGACY_PLAN_ALIASES, type)) return LEGACY_PLAN_ALIASES[type];
    throw new Error(`不支持的套餐: ${type || '空值'}`);
}
function resolvePlanName(value) { return PLAN_NAME_MAP[normalizePlanType(value)]; }

module.exports = { PLAN_NAME_MAP, PLAN_LABELS, LEGACY_PLAN_ALIASES, normalizePlanType, resolvePlanName };
