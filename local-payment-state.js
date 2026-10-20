'use strict';

function hasConfirmedSuccess(output) {
    return /(?:^|\n)PAYMENT_SUCCESS\s*(?:\r?\n|$)/.test(String(output || ''));
}

function hasConfirmedFailure(output) {
    return /(?:^|\n)PAYMENT_CONFIRMED_FAILED\s*(?:\r?\n|$)/.test(String(output || ''));
}

function mayHaveSubmitted(output) {
    return /PAYMENT_SUBMITTING|\[Stripe\] Step 9:|已点击提交按钮/.test(String(output || ''));
}

function classifyResult(analysis, output) {
    if (hasConfirmedSuccess(output)) return { ...analysis, status: 'success', shouldRetry: false };
    if (mayHaveSubmitted(output) && !hasConfirmedFailure(output)) {
        return { ...analysis, status: 'manual', shouldRetry: false, message: '支付结果待确认，CDK 保持占用，请核对原支付记录，勿重复充值' };
    }
    if (hasConfirmedFailure(output)) return { ...analysis, status: 'failed', shouldRetry: false };
    return analysis.status === 'success'
        ? { ...analysis, status: 'manual', shouldRetry: false, message: '缺少最终支付成功凭据，请核对原订单' }
        : analysis;
}

module.exports = { hasConfirmedSuccess, hasConfirmedFailure, mayHaveSubmitted, classifyResult };
