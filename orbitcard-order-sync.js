'use strict';
const { validOrder } = require('./orbitcard-cdk');
const { CardPreparationError } = require('./orbitcard-card-policy');
const { verifiedSuccess } = require('./orbitcard-order-usage');
const positiveId = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

// Read the platform list, then verify each new order through the original-order
// endpoint. Never derive a card from an amount, email, time or masked card number.
module.exports = function createOrderSync({ api, store }) {
    async function synchronize(cfg, cards) {
        const methods = store.cardMethods(cfg.base_url);
        const known = await methods.listSuccessfulOrders();
        const bindings = await methods.subscriptionBindings();
        const byOrder = new Map(known.map(row => [row.order_no, row]));
        const byClient = new Map(known.map(row => [row.client_order_no, row]));
        const bindingOrders = new Map(), bindingClients = new Map();
        for (const row of bindings) {
            for (const [index, key] of [[bindingOrders, row.order_no], [bindingClients, row.client_order_no]]) {
                if (!key) continue;
                if (!index.has(key)) index.set(key, []);
                index.get(key).push(row);
            }
        }
        const cardIds = new Set(cards.map(card => Number(card.card_id)));
        const orders = new Map();
        let total = null, read = 0;
        for (let page = 1; ; page++) {
            if (page > 1000) throw new CardPreparationError('会员订单分页超限，请缩小历史订单范围后核对');
            const result = await api.request(cfg, 'getSubscriptionList', { page, page_size: 20, status: 'succeeded', service_code: 'all' });
            if (!result.success || result.requestError || result.data?.request_error) throw new CardPreparationError('会员订单列表读取失败，请检查 subscriptions:read 权限或稍后同步');
            const data = result.data, rows = data?.items;
            if (!Array.isArray(rows) || rows.length > 20 || !['number','string'].includes(typeof data.total)
                || String(data.total).trim() === '' || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0
                || data.total == null || (total != null && Number(data.total) !== total)
                || (data.page != null && Number(data.page) !== page)) throw new CardPreparationError('会员订单分页数量变化或格式无效，请重新同步');
            total = Number(data.total);
            for (const row of rows) {
                const orderId = row?.task_no || row?.orderId;
                if (!identifier(orderId) || !identifier(row.client_order_no)
                    || (row.task_no && row.orderId && row.task_no !== row.orderId) || orders.has(orderId)) {
                    throw new CardPreparationError('会员订单列表缺少唯一订单身份或包含重复记录，请重新同步');
                }
                orders.set(orderId, row);
            }
            read += rows.length;
            if (read > total || (!rows.length && read < total)) throw new CardPreparationError('会员订单分页不完整，请重新同步');
            if (read === total) break;
        }
        const confirmed = [], unresolved = [];
        for (const [orderId, row] of orders) {
            const recorded = byOrder.get(orderId) || byClient.get(row.client_order_no);
            if (recorded) {
                if (recorded.client_order_no !== row.client_order_no || (recorded.order_no && recorded.order_no !== orderId)
                    || (row.card_id != null && Number(recorded.card_id) !== Number(row.card_id))) throw new CardPreparationError('平台成功订单身份与已有账本不一致');
                continue;
            }
            const matches = [...new Set([...(bindingOrders.get(orderId) || []), ...(bindingClients.get(row.client_order_no) || [])])];
            if (matches.some(item => item.client_order_no !== row.client_order_no || (item.order_no && item.order_no !== orderId))
                || new Set(matches.map(item => Number(item.card_id))).size > 1) throw new CardPreparationError('原会员订单卡片关联不一致');
            const boundCard = matches[0]?.card_id;
            if (row.card_id != null && boundCard != null && Number(row.card_id) !== Number(boundCard)) throw new CardPreparationError('平台会员订单卡片与原记录不一致');
            const hintedCard = row.card_id ?? boundCard;
            if (hintedCard != null && !positiveId(hintedCard)) { unresolved.push({order_no:orderId,reason:'card_identity_invalid'}); continue; }
            if (hintedCard != null && !cardIds.has(Number(hintedCard))) continue;
            const result = await api.request(cfg, 'getSubscription', { task_no: orderId });
            const data = result.data;
            const cardId = positiveId(data?.card_id ?? hintedCard);
            const expected = { orderId, clientOrderNo: row.client_order_no, cardId };
            if (!result.success || result.requestError || data?.request_error || !validOrder(data, expected)
                || (hintedCard != null && cardId !== Number(hintedCard)) || !verifiedSuccess(data, expected)) {
                unresolved.push({ order_no: orderId, reason: 'result_unconfirmed' }); continue;
            }
            if (!Number.isSafeInteger(cardId) || cardId < 1) { unresolved.push({ order_no: orderId, reason: 'card_identity_missing' }); continue; }
            if (cardIds.has(cardId)) confirmed.push({ cardId, orderId, clientOrderNo: row.client_order_no, snapshot: data });
        }
        let added = 0;
        for (const order of confirmed) if (await methods.recordSuccessfulOrder(order)) added++;
        return { scanned: read, added, unresolved, complete: unresolved.length === 0 };
    }
    return { synchronize };
};
