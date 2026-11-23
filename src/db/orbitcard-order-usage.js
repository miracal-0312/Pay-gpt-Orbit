'use strict';

const { CardPreparationError } = require('../orbitcard/orbitcard-card-policy');
const { outcome, terminalUpstreamSnapshot } = require('../orbitcard/orbitcard-client');
const { validOrder } = require('../payments/orbitcard-cdk');
const { MAX_SUCCESSFUL_ORDERS, validCount } = require('../orbitcard/orbitcard-pool');

function verifiedSuccess(snapshot, expected) {
    return Boolean(snapshot && !snapshot.request_error && validOrder(snapshot, expected)
        && (snapshot.query_source === 'upstream' || terminalUpstreamSnapshot(snapshot))
        && outcome(snapshot, true) === 'success');
}

// Called after confirmation, inside the order settlement/release transaction.
module.exports = function createOrderUsage({ runQuery, runExecute }) {
    async function disableExhaustedCards(scope, { cardId, connection } = {}) {
        const result = await runExecute(`UPDATE orbitcard_managed_cards SET disabled_at=UTC_TIMESTAMP(3),
            disabled_code='success_limit_reached', disabled_reason=?, disabled_job_key=NULL
            WHERE scope=? AND disabled_at IS NULL AND successful_order_count>=?${cardId == null ? '' : ' AND card_id=?'}`,
        [`已达到 ${MAX_SUCCESSFUL_ORDERS} 笔成功会员订单上限`, scope, MAX_SUCCESSFUL_ORDERS, ...(cardId == null ? [] : [cardId])], { connection });
        return result.affectedRows;
    }
    function identity(value) {
        return typeof value === 'string' && value.length > 0 && value.length <= 128
            && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
    }
    async function recordSuccess({ scope, cardId, clientOrderNo, orderId = null, snapshot }, options) {
        if (!options?.connection) throw new CardPreparationError('成功订单计数必须在结算事务中完成');
        // A local success flag (including manual fulfillment) is not evidence.
        if (!verifiedSuccess(snapshot, { orderId, clientOrderNo, cardId })) return false;
        orderId = snapshot.task_no || snapshot.orderId;
        if (!/^[a-f0-9]{64}$/.test(scope) || !Number.isSafeInteger(Number(cardId)) || Number(cardId) < 1
            || !identity(clientOrderNo) || (orderId != null && !identity(orderId))) {
            throw new CardPreparationError('成功订单缺少有效的原订单或卡片身份，不能计数');
        }
        const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope, cardId], options);
        if (!validCount(card)) {
            throw new CardPreparationError('卡片成功订单计数未初始化，不能结算');
        }
        const existing = await runQuery(`SELECT * FROM orbitcard_successful_orders WHERE scope=?
            AND (client_order_no=? OR order_no=?) FOR UPDATE`, [scope, clientOrderNo, orderId], options);
        if (existing.length) {
            if (existing.length !== 1 || Number(existing[0].card_id) !== Number(cardId)
                || existing[0].client_order_no !== clientOrderNo
                || (orderId && existing[0].order_no && existing[0].order_no !== orderId)) {
                throw new CardPreparationError('成功订单已关联其他卡片或订单身份，禁止重复计数');
            }
            if (orderId && !existing[0].order_no) await runExecute(`UPDATE orbitcard_successful_orders SET order_no=?
                WHERE scope=? AND client_order_no=? AND order_no IS NULL`, [orderId, scope, clientOrderNo], options);
            return false;
        }
        // Unique keys protect both identities across processes. A conflict aborts
        // the transaction, so another card cannot receive the same success.
        const proof = JSON.stringify({ status: snapshot.status, upstream_status: snapshot.upstream_status,
            subscription_succeeded: snapshot.subscription_succeeded, query_source: snapshot.query_source, result_source: snapshot.result_source });
        await runExecute(`INSERT INTO orbitcard_successful_orders (scope,client_order_no,order_no,card_id,result_snapshot)
            VALUES (?,?,?,?,?)`, [scope, clientOrderNo, orderId, cardId, proof], options);
        const updated = await runExecute(`UPDATE orbitcard_managed_cards SET successful_order_count=successful_order_count+1
            WHERE scope=? AND card_id=?`, [scope, cardId], options);
        if (updated.affectedRows !== 1) throw new CardPreparationError('成功订单计数未保存，结算已回滚');
        if (!card.disabled_at && Number(card.successful_order_count) + 1 >= MAX_SUCCESSFUL_ORDERS) {
            const disabled = await disableExhaustedCards(scope, { cardId, connection: options.connection });
            if (disabled !== 1) throw new CardPreparationError('满额卡片停用标记未保存，结算已回滚');
        }
        return true;
    }
    return { recordSuccess, disableExhaustedCards };
};
module.exports.verifiedSuccess = verifiedSuccess;
