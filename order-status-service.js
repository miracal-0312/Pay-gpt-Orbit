'use strict';
const { cdkLockKey } = require('./payment-execution-lock');

module.exports = function createOrderStatusService(store) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    return async function updateOrderStatus({ jobKey, status, expectedStatus, reason, adminEmail }) {
        if (!['success', 'failed'].includes(status)) fail(400, '请选择成功或失败');
        if (typeof expectedStatus !== 'string' || !expectedStatus) fail(400, '缺少原订单状态，请刷新后重试');
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) fail(400, '请填写 1–255 字的修改原因');
        const initial = await store.getTaskStatus(jobKey);
        if (!initial?.orbitcard_client_order_no) fail(404, '未找到 Orbitcard 订单');
        const guard = await store.acquirePaymentLock(cdkLockKey(initial.cdk_code));
        if (!guard) fail(409, '订单正在支付或查单，请稍后重试');
        try {
            await guard.assertOwned();
            return await store.withTransaction(async connection => {
                const options = { connection };
                const [code] = await store.runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [initial.cdk_code], options);
                const [task] = await store.runQuery('SELECT * FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [initial.cdk_code], options);
                if (!code || task?.job_key !== jobKey) fail(409, '只能修改该卡密的最新订单，请刷新列表');
                if (task.status !== expectedStatus) fail(409, '订单状态已变化，请刷新后重试');
                if (status === 'failed' && task.status === 'success') fail(409, '已确认成功的订单不能改为失败');
                await guard.assertOwned();
                const message = `人工确认${status === 'success' ? '成功' : '失败'}：${reason.trim()}`;
                await store.runExecute(`UPDATE task_logs SET status = ?, progress = ?, message = ?, orbitcard_state = ?, session_payload = NULL WHERE job_key = ?`,
                    [status, status === 'success' ? 100 : 0, message, status === 'success' ? 'success' : 'support_locked', jobKey], options);
                // Order failure preserves any manual redemption and keeps the CDK unavailable for another payment.
                await store.runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [initial.cdk_code], options);
                await store.settleCardUse(jobKey, status, options);
                if (status === 'success' && task.status !== 'success') await store.enqueueRedemption({ cdk: initial.cdk_code, orderId: task.orbitcard_retry_root_job_key || jobKey }, options);
                await store.runExecute('INSERT INTO admin_login_logs (event, admin_email, detail) VALUES (?, ?, ?)',
                    ['order_status_changed', String(adminEmail || '').slice(0, 128), `订单：${jobKey}；${task.status} → ${status}；原因：${reason.trim()}`], options);
                return { status };
            });
        } finally { await guard.release(); }
    };
};
