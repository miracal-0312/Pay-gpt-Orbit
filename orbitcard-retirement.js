'use strict';

const crypto = require('node:crypto');
const { CardPreparationError } = require('./orbitcard-card-policy');

// deleteCard differs from createCard: an uncertain deletion is recovered through
// read-only cardDetail, never by replaying a money-affecting delete request.
module.exports = function createRetirement({ api, cardsApi }) {
    return async function retire(cfg, locked, card, row = {}, { listed = true } = {}) {
        const cardId = cardsApi.positiveId(card?.card_id);
        if (!cardId || row.card_id != null && Number(row.card_id) !== cardId) {
            throw new CardPreparationError('待删除卡片的 ID 不一致');
        }
        const credential = String(cfg.api_key || '').trim();
        if (!credential) throw new CardPreparationError('删卡需要原 API Key');
        const prefix = `retire-${crypto.createHash('sha256').update(credential).digest('hex').slice(0,16)}-`;
        function validateKey(key) {
            if (typeof key !== 'string' || !key.startsWith(prefix) || key.length > 80 || !key.slice(prefix.length)) {
                throw new CardPreparationError('原删卡申请的 API Key 与当前配置不同或幂等键无效，请恢复原凭据后确认');
            }
        }
        if (row.retirement_key) validateKey(row.retirement_key);
        if (!listed && !row.retirement_key) throw new CardPreparationError('卡片不在平台列表中且缺少原删卡意图，已停止补卡');
        const intent = await locked.retireCard(cardId, row.retirement_key || `${prefix}${crypto.randomUUID()}`);
        const key = intent.retirement_key;
        validateKey(key);

        async function confirm(deleted) {
            if (cardsApi.positiveId(deleted?.card_id) !== cardId || deleted?.provider_status !== 'DELETED') {
                throw new CardPreparationError('卡片删除仍未确认，已保留原删卡意图并暂停补卡');
            }
            const summary = { ...card, ...deleted, card_id: cardId, provider_status: 'DELETED' };
            await locked.confirmRetirement(cardId, key, summary);
            return summary;
        }
        async function recover() {
            try {
                return await confirm(await cardsApi.cardDetail(cfg, cardId));
            } catch (error) {
                if (error instanceof CardPreparationError) throw error;
                throw new CardPreparationError('卡片删除结果查询失败，已保留原删卡意图；稍后只读查询确认，暂停补卡');
            }
        }
        // Legacy keys have no state and may already have been sent. A missing
        // list item is also not proof of deletion; require an explicit detail.
        if (!listed || intent.retirement_state !== 'prepared') return recover();
        if (!['ACTIVE', 'CANCELLED'].includes(card.provider_status)) {
            throw new CardPreparationError('卡片当前状态不允许发起删除，已暂停补卡');
        }
        if (!await locked.markRetirementSubmitted(cardId, key)) return recover();

        let result;
        try {
            result = await api.request(cfg, 'deleteCard', { card_id: cardId }, key);
        } catch {
            throw new CardPreparationError('卡片删除结果未知，已保留原删卡意图；后续只读查询确认，暂停补卡');
        }
        if (!result?.success || cardsApi.positiveId(result.data?.card_id) !== cardId
            || result.data?.status !== 'DELETED') {
            throw new CardPreparationError('卡片删除仍未确认，已保留原删卡意图；后续只读查询确认，暂停补卡');
        }
        // A DELETED status alone does not prove the amount refunded. Preserve the
        // last observed balance unless cardDetail later reports a new balance.
        // An amount explicitly returned by the confirmed deletion can be kept
        // as audit evidence; it must not be reconstructed from that balance.
        const refunded = result.data.refunded_amount;
        const evidence = typeof refunded === 'string' && refunded.length <= 64 && /^\d+(?:\.\d{1,8})?$/.test(refunded)
            ? {refunded_amount:refunded} : {};
        return confirm({ ...card, provider_status: 'DELETED', ...evidence });
    };
};
