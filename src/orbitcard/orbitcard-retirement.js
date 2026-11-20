'use strict';

const crypto = require('node:crypto');
const { CardPreparationError } = require('./orbitcard-card-policy');

module.exports = function createRetirementReconciler({ cardsApi }) {
    return async function reconcileRetirement(cfg, locked, row, snapshot) {
        const cardId = cardsApi.positiveId(row.card_id);
        if (!cardId) throw new CardPreparationError('原删卡记录的卡片 ID 无效');
        const credential = String(cfg.api_key || '').trim();
        const prefix = `retire-${crypto.createHash('sha256').update(credential).digest('hex').slice(0, 16)}-`;
        const key = row.retirement_key;
        if (!credential || typeof key !== 'string' || !key.startsWith(prefix) || key.length <= prefix.length || key.length > 80) {
            throw new CardPreparationError('原删卡申请的 API Key 或幂等键不一致，请使用原凭据核对');
        }
        const card = snapshot?.provider_status === 'DELETED' ? snapshot : await cardsApi.cardDetail(cfg, cardId);
        if (card?.provider_status !== 'DELETED') return false;
        await locked.confirmRetirement(cardId, key, card);
        return true;
    };
};
