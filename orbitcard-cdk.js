'use strict';
const crypto = require('node:crypto');
const api = require('./orbitcard-client');

function clientOrderNo(cdk, attemptKey) {
    if (!cdk || !attemptKey) throw new Error('CDK 和兑换尝试编号不能为空');
    return `cdk-${crypto.createHash('sha256').update(JSON.stringify([String(cdk), String(attemptKey)])).digest('hex')}`;
}

function validOrder(data, { orderId, clientOrderNo: identity, planType, email, cardId }) {
    const id = data?.orderId || data?.task_no;
    if (typeof id !== 'string' || !id || id.length > 128
        || (data.orderId && data.task_no && data.orderId !== data.task_no)) return false;
    if (orderId && id !== orderId) return false;
    // Both fields are part of the documented subscription order. Missing values
    // cannot establish ownership when a task number came from an uncertain POST.
    if (!identity || data.client_order_no !== identity) return false;
    if (planType && data.plan_type !== planType) return false;
    if (data.card_id != null && cardId && Number(data.card_id) !== Number(cardId)) return false;
    if (data.targetEmail && email && String(data.targetEmail).toLowerCase() !== String(email).toLowerCase()) return false;
    return true;
}

function progressFor(data) {
    const result = api.outcome(data, true);
    if (result === 'success') return { status: 'success', state: 'success', progress: 100, message: 'Orbitcard 订阅成功，CDK 已核销' };
    if (result === 'failed') return { status: 'failed', state: 'failed', progress: 99, message: 'Orbitcard 已确认订阅失败，CDK 已释放，可更新 Session 后重试' };
    return { status: 'manual', state: 'pending', progress: 95, message: data?.stage === 'awaiting_captcha'
        ? '请完成人机验证，然后继续查询原订单' : 'Orbitcard 订单仍在处理中，CDK 已保留，请继续查询原订单' };
}

module.exports = { clientOrderNo, validOrder, progressFor };
