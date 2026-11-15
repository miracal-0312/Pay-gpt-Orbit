'use strict';
// Shared SQL fixture for the persistent order ledger; other SQL stays in the
// existing order/card fixtures so transaction rollback and ownership are tested.
module.exports = function orderUsageDb(db) {
    const cards = () => db.cards || [db.card];
    const ledger = () => db.successfulOrders ||= [];
    return {
        query(q, p) {
            if (q.includes('FROM orbitcard_successful_orders')) return structuredClone(ledger().filter(row => row.scope === p[0]
                && (!q.includes('client_order_no=? OR') || row.client_order_no === p[1] || (p[2] != null && row.order_no === p[2]))));
            if (q.startsWith('SELECT orbitcard_client_order_no AS')) return [
                ...(db.tasks || []).filter(t => t.orbitcard_base_url === p[0] && t.orbitcard_card_id > 0).map(t => ({client_order_no:t.orbitcard_client_order_no,order_no:t.gpt_api_order_id,card_id:t.orbitcard_card_id})),
                ...(db.orders || []).filter(t => t.scope === p[1] && t.card_id > 0).map(t => ({client_order_no:t.client_order_no,order_no:t.task_no,card_id:t.card_id}))];
        },
        execute(q, p) {
            if (q.startsWith('INSERT IGNORE INTO orbitcard_managed_cards (scope,card_id)')) {
                if (!cards().some(card => card.scope === p[0] && card.card_id === Number(p[1]))) db.cards.push({scope:p[0],card_id:Number(p[1]),successful_order_count:0});
                return {affectedRows:1};
            }
            if (q.startsWith('INSERT INTO orbitcard_successful_orders')) {
                if (ledger().some(row => row.scope === p[0] && (row.client_order_no === p[1] || (p[2] != null && row.order_no === p[2])))) throw Error('duplicate order');
                ledger().push({scope:p[0],client_order_no:p[1],order_no:p[2],card_id:Number(p[3])});
                return {affectedRows:1};
            }
            if (q.startsWith('UPDATE orbitcard_successful_orders SET order_no=')) {
                ledger().find(row => row.scope === p[1] && row.client_order_no === p[2]).order_no = p[0];
                return {affectedRows:1};
            }
            if (q.startsWith('UPDATE orbitcard_managed_cards SET successful_order_count=')) {
                const card = cards().find(row => row.scope === p[0] && Number(row.card_id) === Number(p[1]));
                if (!card) return {affectedRows:0};
                card.successful_order_count++; return {affectedRows:1};
            }
        }
    };
};
