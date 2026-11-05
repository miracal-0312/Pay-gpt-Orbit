'use strict';

// Only operations used by this application's current business flows belong here.
// Both Orbitcard-Open-API-V1.md and its linked subscription API are authoritative.
const definitions = {
    getAccountBalance: [],
    getProductCode: [],
    getSubscriptionPlans: [],
    getSubscriptionPaymentRegions: ['plan_type'],
    getSubscription: ['task_no', 'client_order_no', 'orderId'],
    getCardList: ['page', 'page_size', 'status', 'product_code', 'card_id', 'card_type', 'search', 'start_time', 'end_time'],
    cardDetail: ['card_id', 'card_ids', 'reveal_sensitive'],
    cardTransaction: ['card_id', 'page', 'page_size', 'transaction_type', 'status', 'merchant', 'start_time', 'end_time'],
    getCardFlow: ['card_id', 'type', 'page', 'page_size'],
    createCard: ['product_code', 'amount', 'quantity'],
    rechargeCard: ['card_id', 'amount'],
    deleteCard: ['card_id'],
    createSubscription: ['client_order_no', 'plan_type', 'card_id', 'session_json', 'authorized', 'payment_region', 'max_service_fee']
};
const writes = new Set(['createCard', 'rechargeCard', 'deleteCard', 'createSubscription']);
const OPERATIONS = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([name, fields]) => [name, Object.freeze({
    path: `/api/open/v1/${name}`, fields: Object.freeze(fields), write: writes.has(name),
    timeout: ['createCard', 'createSubscription'].includes(name) ? 45000 : 30000
})])));

function validateRequest(operation, body, idempotencyKey) {
    if (typeof operation !== 'string' || !Object.hasOwn(OPERATIONS, operation)) throw new Error('未启用或已移除的 Orbitcard 操作，未发送请求');
    const spec = OPERATIONS[operation];
    if (!body || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
        || Object.keys(body).some(key => !spec.fields.includes(key))) throw new Error('Orbitcard 请求包含非现行接口字段，未发送请求');
    if (typeof idempotencyKey !== 'string' || (spec.write && !idempotencyKey)
        || (idempotencyKey && (!/^[\x21-\x7e]+$/.test(idempotencyKey)
            || Buffer.byteLength(idempotencyKey) < 8 || Buffer.byteLength(idempotencyKey) > 128))) {
        throw new Error('Orbitcard 写操作必须保留有效的原幂等键，未发送请求');
    }
    for (const field of ['amount', 'max_service_fee']) {
        if (Object.hasOwn(body, field) && (typeof body[field] !== 'string' || !/^\d+(?:\.\d+)?$/.test(body[field]))) {
            throw new Error('Orbitcard 金额必须是十进制定点字符串，未发送请求');
        }
    }
    return spec;
}

module.exports = { OPERATIONS, validateRequest };
