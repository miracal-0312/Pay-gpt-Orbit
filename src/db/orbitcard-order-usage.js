'use strict';

const { CardPreparationError, cardScope } = require('../orbitcard/orbitcard-card-policy');
const { outcome, terminalUpstreamSnapshot } = require('../orbitcard/orbitcard-client');
const { validOrder } = require('../payments/orbitcard-cdk');

function verifiedSuccess(snapshot, expected) {
    return Boolean(snapshot && !snapshot.request_error && validOrder(snapshot, expected)
        && (snapshot.query_source === 'upstream' || terminalUpstreamSnapshot(snapshot))
        && outcome(snapshot, true) === 'success');
}

// Called after confirmation, inside the order settlement/release transaction.
module.exports = function createOrderUsage({ runQuery, runExecute, withTransaction }) {
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
        if (!card || card.successful_order_count == null || !Number.isSafeInteger(Number(card.successful_order_count)) || Number(card.successful_order_count) < 0) {
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
        return true;
    }
    async function backfill() {
        // Import only saved verified platform responses, irrespective of local
        // task/CDK state. Missing evidence is left for a fresh platform query.
        for (const source of ['tasks', 'manual']) {
            let cursor = source === 'tasks' ? 0 : '';
            for (;;) {
                const rows = source === 'tasks'
                    ? await runQuery(`SELECT t.id AS cursor_id, t.orbitcard_base_url AS base_url,
                        t.orbitcard_card_id AS card_id, t.orbitcard_client_order_no AS client_order_no,
                        t.gpt_api_order_id AS order_no, t.gpt_api_raw AS snapshot FROM task_logs t
                        WHERE t.orbitcard_client_order_no IS NOT NULL
                        AND t.orbitcard_card_id > 0 AND t.id > ? ORDER BY t.id LIMIT 200`, [cursor])
                    : await runQuery(`SELECT request_id AS cursor_id, scope, card_id, client_order_no, task_no AS order_no, snapshot
                        FROM orbitcard_admin_orders WHERE card_id > 0
                        AND request_id > ? ORDER BY request_id LIMIT 200`, [cursor]);
                if (!rows.length) break;
                for (const row of rows) {
                    let snapshot;
                    try { snapshot = JSON.parse(row.snapshot); } catch { continue; }
                    if (!verifiedSuccess(snapshot, { orderId: row.order_no, clientOrderNo: row.client_order_no, cardId: row.card_id })) continue;
                    const scope = row.scope || cardScope(row.base_url);
                    await withTransaction(async connection => {
                        const options = { connection };
                        await runExecute('INSERT IGNORE INTO orbitcard_managed_cards (scope,card_id) VALUES (?,?)', [scope, row.card_id], options);
                        await recordSuccess({ scope, cardId: row.card_id, clientOrderNo: row.client_order_no, orderId: row.order_no || null, snapshot }, options);
                    });
                }
                cursor = rows[rows.length - 1].cursor_id;
            }
        }
    }
    return { recordSuccess, backfill };
};
module.exports.verifiedSuccess = verifiedSuccess;
