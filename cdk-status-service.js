'use strict';

const { cdkLockKey } = require('./payment-execution-lock');
const { readConfig } = require('./cdk-redemption-webhook');

module.exports = function createCdkStatusService({ runQuery, runExecute, withTransaction,
    acquirePaymentLock, enqueueRedemption, env = process.env }) {
    function fail(status, message) { throw Object.assign(new Error(message), { status }); }

    return async function updateCdkStatus({ cdk, status, reason, adminEmail }) {
        if (typeof cdk !== 'string' || !/^[a-zA-Z0-9_-]{4,32}$/.test(cdk)) fail(400, '请输入有效卡密');
        if (status !== 'redeemed') fail(400, '人工售后仅支持将卡密修改为已核销');
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) {
            fail(400, '请填写 1–255 字的售后处理备注');
        }
        if (!readConfig(env)) fail(409, '请先配置商城核销通知地址、来源和密钥，再进行人工核销');
        const guard = await acquirePaymentLock(cdkLockKey(cdk));
        if (!guard) fail(409, '该卡密正在执行支付或查单，请稍后再修改状态');
        try {
            await guard.assertOwned();
            return await withTransaction(async connection => {
                const options = { connection };
                const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
                if (!code || !code.is_active) fail(404, '卡密不存在或已停用');
                if (code.manual_redeemed_at) return { status: 'redeemed', changed: false };
                const [task] = await runQuery('SELECT * FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [code.cdk_code], options);
                const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE cdk_code = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [code.cdk_code], options);
                if (order?.state === 'success' || (task?.status === 'success' && (!task.orbitcard_state || task.orbitcard_state === 'success'))) {
                    return { status: 'redeemed', changed: false };
                }
                if (!code.used_at && !['running', 'manual'].includes(task?.status)
                    && !['support_locked', 'balance_blocked'].includes(task?.orbitcard_state)) {
                    fail(409, '仅支持对已占用的卡密进行售后核销，请刷新列表');
                }
                // Prepared administrator orders can be resumed with their original request ID.
                if (order && ['preparing', 'prepared'].includes(order.state)) {
                    fail(409, '该卡密的人工交付订单仍在准备支付，请先处理原订单');
                }
                await guard.assertOwned();
                await runExecute(`UPDATE cdk_codes SET manual_redeemed_at = CURRENT_TIMESTAMP,
                    manual_redeemed_by = ?, manual_redemption_reason = ?,
                    used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?`,
                [String(adminEmail || '').slice(0, 255), reason.trim(), code.cdk_code], options);
                await enqueueRedemption({ cdk: code.cdk_code,
                    orderId: task?.orbitcard_retry_root_job_key || task?.job_key || order?.client_order_no || `support-${code.id}` }, options);
                return { status: 'redeemed', changed: true };
            });
        } finally { await guard.release(); }
    };
};
