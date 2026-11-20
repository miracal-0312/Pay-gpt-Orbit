'use strict';
const poolPolicy = require('./orbitcard-pool');

const money = require('./orbitcard-money');
const { planFor, CardPreparationError } = require('./orbitcard-card-policy');

// Pure decisions over one platform snapshot. No network requests or persistence.
function decideCards({ saved, listed, detailed, jobKey, planType, priceFor, excludedCardIds = [] }) {
    const plan = planFor(planType), live = new Map(listed.map(card => [Number(card.card_id), card]));
    const details = new Map(detailed.map(card => [Number(card.card_id), card]));
    const excluded = new Set(excludedCardIds.map(Number));
    const candidates = [], skipped = [], waiting = [];
    for (const row of saved) {
        const id = Number(row.card_id), owned = row.active_job === jobKey;
        if (excluded.has(id)) { skipped.push({ card_id: id, reason: 'previous_payment_attempt' }); continue; }
        if (!live.has(id)) { skipped.push({ card_id: id, reason: 'missing_from_platform_list' }); continue; }
        if (!poolPolicy.eligible(row)) {
            if (owned) throw new CardPreparationError('原订单卡片已停用或正在退役，请核对原订单');
            skipped.push({ card_id: id, reason: row.disabled_at ? 'card_error_disabled' : row.retirement_key ? 'retiring'
                : poolPolicy.exhausted(row) ? 'success_limit_reached' : 'order_count_unconfirmed', code: row.disabled_code || '' }); continue;
        }
        // An unresolved owner still blocks a replacement, including when the
        // platform has frozen its card or its quota is already exhausted.
        if (row.active_job && !owned) { waiting.push({ card_id: id, reason: 'busy' }); continue; }
        if (live.get(id).provider_status === 'DELETED') {
            if (owned) throw new CardPreparationError('已预占卡片已注销，请核对原订单');
            skipped.push({ card_id: id, reason: 'inactive', status: 'DELETED' }); continue;
        }
        const detail = details.get(id);
        const status = detail?.provider_status || live.get(id).provider_status;
        if (['CANCELLED', 'FROZEN', 'DELETED'].includes(status)) {
            if (owned) throw new CardPreparationError('已预占卡片状态异常，请核对原补款及管理员订单');
            skipped.push({ card_id: id, reason: 'inactive', status }); continue;
        }
        if (status !== 'ACTIVE') { waiting.push({ card_id: id, reason: 'status_unconfirmed' }); continue; }
        if (!detail) {
            if (owned) throw new CardPreparationError('已预占卡片的实时详情缺失，请核对原补款及管理员订单');
            skipped.push({ card_id: id, reason: 'invalid_detail' }); continue;
        }
        const card = { ...detail, product_code: detail.product_code || live.get(id).product_code || '',
            bin: detail.bin || live.get(id).bin || '', last4: detail.last4 || live.get(id).last4 || '' };
        if (card.provider_status !== 'ACTIVE') {
            if (owned) throw new CardPreparationError('已预占卡片状态异常，请核对原补款及管理员订单');
            skipped.push({ card_id: id, reason: 'inactive', status: card.provider_status }); continue;
        }
        // The opening catalog only describes products currently available to
        // issue. Existing cards can outlive those products and opening choices.
        const price = priceFor(plan);
        try {
            if (!price || card.currency !== 'USD' || card.balance_amount == null) throw new CardPreparationError('支付资料不完整');
            const planAmount = money.units(price), balance = money.units(card.balance_amount);
            const target = planAmount;
            const fundingAmount = balance < target ? money.units(money.cents(planAmount)) : 0n;
            candidates.push({ card, row, target, balance, fundingAmount,
                fundingSufficient: balance + fundingAmount >= target, action: fundingAmount ? 'fund' : 'pay' });
        } catch (error) {
            if (!(error instanceof CardPreparationError)) throw error;
            if (owned) throw new CardPreparationError('已预占卡片的支付价格或余额资料异常，请核对原订单');
            skipped.push({ card_id: id, reason: 'invalid_payment_data', status: card.provider_status });
        }
    }
    candidates.sort((a,b) => (a.row.active_job === jobKey ? -1 : b.row.active_job === jobKey ? 1 : 0)
        || Number(b.fundingSufficient) - Number(a.fundingSufficient)
        || (a.fundingAmount < b.fundingAmount ? -1 : a.fundingAmount > b.fundingAmount ? 1 : 0)
        || (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : a.card.card_id - b.card.card_id));
    return { action: candidates[0]?.action || (waiting.length ? 'wait' : 'unavailable'), candidates, skipped, waiting };
}

module.exports = { decideCards };
