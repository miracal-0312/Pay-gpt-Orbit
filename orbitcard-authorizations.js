'use strict';

const { CardPreparationError } = require('./orbitcard-card-policy');

const PAGE_SIZE = 100;
const MAX_PAGES = 10000;
// The provider document does not define numeric status codes. Only explicit
// textual outcomes are accepted; an unknown value cannot silently become zero.
const SUCCESS = new Set(['authorized', 'approved', 'success', 'successful', 'succeeded', 'completed', '授权成功', '已完成']);
const NOT_SUCCESS = new Set(['pending', 'processing', 'failed', 'declined', 'rejected', 'cancelled', 'canceled', 'reversed', 'expired', 'voided']);
const OTHER_TYPES = new Set(['settlement', 'refund', 'reversal', 'chargeback']);

function fail(message) { throw new CardPreparationError(message); }
function integer(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function transactionId(value) {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)))
        fail('消费交易记录缺少有效的唯一 ID，已停止选卡');
    const id = String(value);
    if (!id.trim() || id !== id.trim() || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id))
        fail('消费交易记录缺少有效的唯一 ID，已停止选卡');
    return id;
}
function nonzeroAmount(value) {
    if (typeof value !== 'number' && typeof value !== 'string')
        fail('成功授权金额缺失或格式无效，已停止选卡');
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Math.abs(value) >= 1e14)
            fail('成功授权金额缺失或格式无效，已停止选卡');
        // A tiny nonzero amount must not be rounded into a zero verification.
        if (value !== 0 && Math.abs(value) < 1e-8)
            fail('成功授权金额精度无法确认，已停止选卡');
        value = value.toFixed(8);
    }
    const match = /^[+-]?(\d{1,14})(?:\.(\d{1,8}))?$/.exec(value);
    if (!match) fail('成功授权金额缺失或格式无效，已停止选卡');
    return /[1-9]/.test(match[1] + (match[2] || ''));
}

async function readAuthorizations(api, cfg, cardId) {
    const id = integer(cardId);
    if (!id) fail('消费交易卡片 ID 无效');
    const seen = new Set(), successful = new Set();
    let expected = null, hasTotal = null, read = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
        let result;
        try { result = await api.request(cfg, 'cardTransaction', { card_id: id, page, page_size: PAGE_SIZE }); }
        catch { fail('消费交易记录读取失败，已停止选卡和卡池维护'); }
        const data = result?.data, rows = data?.list;
        if (result?.success !== true || !Array.isArray(rows) || rows.length > PAGE_SIZE)
            fail('消费交易记录读取失败或分页格式无效，已停止选卡和卡池维护');
        const present = data.total != null;
        const total = present ? integer(data.total) : null;
        if ((present && total === null) || (hasTotal !== null && present !== hasTotal)
            || (page > 1 && present && total !== expected))
            fail('消费交易分页总数缺失、变化或无效，请重新同步');
        if ((data.page != null && integer(data.page) !== page)
            || (data.page_size != null && integer(data.page_size) !== PAGE_SIZE))
            fail('消费交易分页参数与请求不一致，请重新同步');
        hasTotal = present; expected = total;
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row)
                || (row.card_id != null && integer(row.card_id) !== id))
                fail('消费交易记录归属或格式无效，已停止选卡');
            const key = transactionId(row.transaction_id ?? row.id);
            let type = typeof (row.transaction_type ?? row.type) === 'string'
                ? (row.transaction_type ?? row.type).trim().toLowerCase() : '';
            if (type === '消费授权') type = 'authorization';
            if (type !== 'authorization' && !OTHER_TYPES.has(type))
                fail('未知消费交易类型，无法确认成功授权次数');
            // An authorization and its settlement may share their transaction ID.
            // Repeated records of the same type indicate unstable pagination.
            const identity = `${type}:${key}`;
            if (seen.has(identity)) fail('消费交易分页包含重复记录，请重新同步');
            seen.add(identity);
            if (type !== 'authorization') continue;
            const status = typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
            if (SUCCESS.has(status)) {
                if (nonzeroAmount(row.authorization_amount ?? row.amount)) successful.add(key);
            } else if (!NOT_SUCCESS.has(status)) {
                fail('未知消费授权状态，无法确认使用次数，请核对平台响应');
            }
        }
        read += rows.length;
        if (present && read > total) fail('消费交易分页数量超过总数，请重新同步');
        if (present ? read === total : rows.length < PAGE_SIZE) return [...successful];
        if (!rows.length) fail('消费交易分页不完整，请重新同步');
    }
    fail('消费交易分页超限，无法确认成功授权次数');
}

module.exports = { readAuthorizations };
