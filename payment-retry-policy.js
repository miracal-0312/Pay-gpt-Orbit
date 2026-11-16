'use strict';

const { outcome } = require('./orbitcard-client');
const { validOrder } = require('./orbitcard-cdk');
const MAX_PAYMENT_ATTEMPTS = 3;

function consistentSnapshot(snapshot) {
    return Boolean(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
        && (snapshot.subscription_succeeded == null || typeof snapshot.subscription_succeeded === 'boolean')
        && !snapshot.request_error
        && (!snapshot.result_source || snapshot.result_source === 'upstream'));
}

// Rejection is a fact about this bound submission, not a generic HTTP error.
// A known platform record may exist, but any upstream result contradicts a
// pre-execution rejection and must be reconciled before releasing ownership.
function confirmedRejection(snapshot, expected = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || snapshot.submission_outcome !== 'rejected' || !expected.clientOrderNo
        || snapshot.client_order_no !== expected.clientOrderNo
        || !Number.isSafeInteger(Number(expected.cardId)) || Number(expected.cardId) < 1
        || Number(snapshot.card_id) !== Number(expected.cardId)
        || !expected.planType || snapshot.plan_type !== expected.planType
        || (snapshot.request_error && snapshot.request_error.submission_outcome !== 'rejected')
        || snapshot.upstream_status || snapshot.subscription_succeeded != null
        || snapshot.query_source || snapshot.result_source
        || (snapshot.status && snapshot.status !== 'failed')
        || snapshot.captcha || (snapshot.stage && !['failed', 'rejected'].includes(snapshot.stage))
        || (snapshot.task_status && !['failed', 'rejected'].includes(snapshot.task_status))
        || (snapshot.targetEmail && expected.email && String(snapshot.targetEmail).toLowerCase() !== String(expected.email).toLowerCase())) return false;
    const id = snapshot.task_no || snapshot.orderId;
    if (id != null && (typeof id !== 'string' || !id || id.length > 128)) return false;
    if (snapshot.task_no && snapshot.orderId && snapshot.task_no !== snapshot.orderId) return false;
    if (expected.orderId && id !== expected.orderId) return false;
    if (snapshot.platform_code === 59005 && (expected.orderId || id)) return false;
    return snapshot.platform_code === 59005 || snapshot.request_error?.submission_outcome === 'rejected';
}

function confirmedFailure(snapshot, expected) {
    const rejectedCard = snapshot?.platform_code === 59005 && confirmedRejection(snapshot, expected);
    return rejectedCard || consistentSnapshot(snapshot) && validOrder(snapshot, expected) && outcome(snapshot, true) === 'failed';
}

function confirmedSuccess(snapshot, expected) {
    return consistentSnapshot(snapshot) && validOrder(snapshot, expected) && outcome(snapshot, true) === 'success';
}

function retryableFailure(snapshot, expected) {
    return confirmedFailure(snapshot, expected) && require('./orbitcard-error-policy').classifyFailure(snapshot).automaticRetry === true;
}

function retryableTask(task) {
    try {
        const attempt = Number(task?.orbitcard_retry_attempt_no);
        return task?.status === 'running' && !task.manual_redeemed_at && task.orbitcard_state === 'retry_waiting'
            && Number.isSafeInteger(attempt) && attempt >= 1 && attempt < MAX_PAYMENT_ATTEMPTS
            && retryableFailure(JSON.parse(task.gpt_api_raw || '{}'), {
            orderId: task.gpt_api_order_id, clientOrderNo: task.orbitcard_client_order_no, cardId: task.orbitcard_card_id,
            planType: require('./plan-registry').PROVIDER_PLANS[require('./plan-registry').paymentPlan(task.orbitcard_plan_type)],
            email: task.orbitcard_email
        });
    } catch (_) { return false; }
}

function manualHistory(order) {
    const history = JSON.parse(order.retry_history || '[]');
    if (!Array.isArray(history) || history.length >= MAX_PAYMENT_ATTEMPTS
        || history.some(item => !Number.isSafeInteger(Number(item.card_id)) || Number(item.card_id) < 1)) {
        throw new Error('支付重试历史无效，请人工核对');
    }
    return history;
}

module.exports = { MAX_PAYMENT_ATTEMPTS, confirmedFailure, confirmedSuccess, confirmedRejection, retryableFailure, retryableTask, manualHistory };
