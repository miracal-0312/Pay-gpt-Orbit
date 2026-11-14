'use strict';
const poolPolicy = require('./orbitcard-pool');

const money = require('./orbitcard-money');
const { planFor, CardPreparationError } = require('./orbitcard-card-policy');

// Pure decisions over one platform snapshot. No network requests or persistence.
function decideCards({ saved, listed, detailed, products, jobKey, planType, priceFor, excludedCardIds = [], now = Date.now() }) {
    const plan = planFor(planType), live = new Map(listed.map(card => [Number(card.card_id), card]));
    const details = new Map(detailed.map(card => [Number(card.card_id), card]));
    const candidates = [], skipped = [], waiting = [];
    for (const row of saved) {
        const id = Number(row.card_id), owned = row.active_job === jobKey;
        if (excludedCardIds.map(Number).includes(id)) { skipped.push({ card_id: id, reason: 'previous_payment_attempt' }); continue; }
        if (!live.has(id)) { skipped.push({ card_id: id, reason: 'missing_from_platform_list' }); continue; }
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
        if (row.authorization_count == null) { waiting.push({ card_id: id, reason: 'authorizations_unconfirmed' }); continue; }
        const used = Number(row.authorization_count);
        if (!Number.isSafeInteger(used) || used < 0) throw new CardPreparationError('成功消费授权次数无效，请重新同步交易');
        if (poolPolicy.coolingDown(row, now) && used < poolPolicy.MAX_USES && !row.retirement_key) {
            waiting.push({ card_id: id, reason: 'cooldown', reuse_after_ms: row.reuse_after_ms }); continue;
        }
        if (poolPolicy.awaitingAuthorization(row) && used < poolPolicy.MAX_USES && !row.retirement_key) {
            if (owned) throw new CardPreparationError('已预占卡片仍在等待授权同步，请核对原订单');
            // Keep this card ineligible until its provider authorization arrives.
            // Once its owner is released and cooldown has ended, this local
            // restriction must not prevent a different order using a new card.
            skipped.push({ card_id: id, reason: 'authorization_pending' }); continue;
        }
        if (!poolPolicy.eligible(row, now)) { skipped.push({ card_id: id, reason: 'limit_reached', successful_uses: used, limit: poolPolicy.MAX_USES }); continue; }
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
        const product = products.find(item => item.product_code === card.product_code), price = priceFor(product, plan);
        try {
            if (!price || !product || card.currency !== 'USD' || card.balance_amount == null) throw new CardPreparationError('支付资料不完整');
            const target = money.units(price) + money.units(product.min_retained_balance);
            const difference = target - money.units(card.balance_amount), deficit = difference > 0n ? difference : 0n;
            candidates.push({ card, row, price: money.units(price), target, deficit, action: deficit ? 'fund' : 'pay' });
        } catch (error) {
            if (!(error instanceof CardPreparationError)) throw error;
            if (owned) throw new CardPreparationError('已预占卡片的支付价格或余额资料异常，请核对原订单');
            skipped.push({ card_id: id, reason: 'invalid_payment_data', status: card.provider_status });
        }
    }
    candidates.sort((a,b) => (a.row.active_job === jobKey ? -1 : b.row.active_job === jobKey ? 1 : 0)
        || (a.deficit < b.deficit ? -1 : a.deficit > b.deficit ? 1 : a.card.card_id - b.card.card_id));
    return { action: candidates[0]?.action || (waiting.length ? 'wait' : 'unavailable'), candidates, skipped, waiting };
}

module.exports = { decideCards };
