'use strict';

const { outcome } = require('./orbitcard-client');
const { validOrder } = require('./orbitcard-cdk');
const MAX_PAYMENT_ATTEMPTS = 3;

function confirmedFailure(snapshot, expected) {
    return validOrder(snapshot, expected) && !snapshot?.request_error && outcome(snapshot, true) === 'failed';
}

function manualHistory(order) {
    const history = JSON.parse(order.retry_history || '[]');
    if (!Array.isArray(history) || history.length >= MAX_PAYMENT_ATTEMPTS
        || history.some(item => !Number.isSafeInteger(Number(item.card_id)) || Number(item.card_id) < 1)) {
        throw new Error('支付重试历史无效，请人工核对');
    }
    return history;
}

module.exports = { MAX_PAYMENT_ATTEMPTS, confirmedFailure, manualHistory };
