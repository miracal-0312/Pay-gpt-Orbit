'use strict';

// Compatibility for existing clients: both entrances use the same financial guards.
module.exports = function createOrderStatusService({ getOrderManualControl, applyOrderManualControl }) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    return async function updateOrderStatus({ jobKey, status, expectedStatus, reason, adminEmail }) {
        if (!['success', 'failed'].includes(status)) fail(400, '请选择成功或失败');
        if (typeof expectedStatus !== 'string' || !expectedStatus) fail(400, '缺少原订单状态，请刷新后重试');
        const current = await getOrderManualControl({ kind: 'task', id: jobKey });
        if (current.status !== expectedStatus) fail(409, '订单状态已变化，请刷新后重试');
        return applyOrderManualControl({ kind: 'task', id: jobKey, action: status,
            expectedRevision: current.revision, reason, adminEmail });
    };
};
