'use strict';
const { CardPreparationError } = require('./orbitcard-card-policy');
const SIZE = 5, MAX_USES = 6;
function eligible(card) {
    return card.transaction_count != null && Number.isSafeInteger(Number(card.transaction_count))
        && Number(card.transaction_count) >= 0 && Number(card.transaction_count) < MAX_USES && !card.retirement_key;
}

// Count only successful settlements: authorizations and their later settlement
// must never count twice. Unknown statuses fail closed rather than imply zero use.
async function countTransactions(api, cfg, cardId) {
    const seen = new Set();
    let count = 0, expected = null, read = 0;
    for (let page = 1; page <= 10000; page++) {
        const result = await api.request(cfg, 'cardTransaction', { card_id: cardId, page, page_size: 100 });
        const rows = result.data?.list;
        if (!result.success || !Array.isArray(rows)) throw new CardPreparationError('交易记录读取失败，停止选卡和卡池维护');
        const total = result.data.total == null ? null : Number(result.data.total);
        if (total !== null && (!Number.isSafeInteger(total) || total < 0 || (expected !== null && total !== expected)))
            throw new CardPreparationError('交易分页总数变化或无效，请重新同步');
        if (page > 1 && (total === null) !== (expected === null))
            throw new CardPreparationError('交易分页总数缺失或变化，请重新同步');
        expected = total;
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row) || (row.card_id != null && Number(row.card_id) !== cardId))
                throw new CardPreparationError('交易记录归属或格式无效');
            const id = row.transaction_id ?? row.id;
            if (id == null || !['string','number'].includes(typeof id) || !String(id).trim()) throw new CardPreparationError('交易记录缺少唯一 ID');
            const type = String(row.transaction_type ?? row.type ?? '').toLowerCase();
            const status = String(row.status ?? '').toLowerCase();
            const key = `${type}:${id}`;
            if (seen.has(key)) throw new CardPreparationError('交易分页重复，请重新同步');
            seen.add(key);
            if (type === 'settlement' || (!type && status === 'settlement')) {
                if (['success','successful','settled','completed','settlement'].includes(status)) count++;
                else if (!['failed','declined','rejected','pending','processing','cancelled','canceled','reversed'].includes(status))
                    throw new CardPreparationError('未知清算状态，无法确认成交次数');
            } else if (!['authorization','refund','reversal','chargeback'].includes(type)) {
                throw new CardPreparationError('未知交易类型，无法确认成交次数');
            }
        }
        read += rows.length;
        if (expected !== null && read > expected) throw new CardPreparationError('交易分页数量超过总数');
        if (expected !== null ? read === expected : rows.length < 100) return count;
        if (!rows.length) throw new CardPreparationError('交易分页不完整');
    }
    throw new CardPreparationError('交易分页超限，无法确认成交次数');
}
module.exports = { SIZE, MAX_USES, eligible, countTransactions };
