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
function requestFailure(result) {
    const status = Number.isSafeInteger(result?.status) && result.status >= 100 && result.status <= 599 ? result.status : null;
    const code = Number.isSafeInteger(result?.code) ? result.code : null;
    const details = [status == null ? '未收到 HTTP 响应' : `HTTP ${status}`, code == null ? '' : `平台 code ${code}`].filter(Boolean).join('，');
    const reason = status === 403 ? '请检查 API Key 的 transactions:read 权限及账户访问权限'
        : status === 401 ? '请检查 API Key、签名凭据、服务器时间及出口 IP 白名单'
            : status === 429 ? '平台请求受限，请按重试间隔稍后同步'
                : status === 404 ? '平台未找到该卡片或当前账户无权读取'
                    : '请检查平台连接和 API 配置后重新同步';
    fail(`消费交易记录读取失败（${details}）；${reason}`);
}
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

async function readAuthorizations(api, cfg, cardId) {
    const id = integer(cardId);
    if (!id) fail('消费交易卡片 ID 无效');
    const seen = new Set(), successful = new Set();
    let expected = null, hasTotal = null, read = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
        try {
            let result;
            try { result = await api.request(cfg, 'cardTransaction', { card_id: id, page, page_size: PAGE_SIZE }); }
            catch { requestFailure(null); }
            if (result?.success !== true) requestFailure(result);
            const data = result?.data, rows = data?.list;
            if (!Array.isArray(rows) || rows.length > PAGE_SIZE)
                fail('消费交易分页格式无效，需要 data.list 数组且单页不超过 100 条；已停止选卡和卡池维护');
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
                    // Usage follows successful authorization records, independent of amount fields.
                    successful.add(key);
                } else if (!NOT_SUCCESS.has(status)) {
                    fail('未知消费授权状态，无法确认使用次数，请核对平台响应');
                }
            }
            read += rows.length;
            if (present && read > total) fail('消费交易分页数量超过总数，请重新同步');
            if (present ? read === total : rows.length < PAGE_SIZE) return [...successful];
            if (!rows.length) fail('消费交易分页不完整，请重新同步');
        } catch (error) {
            const reason = error instanceof CardPreparationError ? error.message : '交易记录处理失败，已停止选卡和卡池维护';
            throw new CardPreparationError(`卡片 ${id}，交易第 ${page} 页：${reason}`);
        }
    }
    fail('消费交易分页超限，无法确认成功授权次数');
}

module.exports = { readAuthorizations };
