'use strict';

const { cdkLockKey } = require('./payment-execution-lock');
const { readConfig } = require('./cdk-redemption-webhook');

module.exports = function createCdkStatusService({ runQuery, runExecute, withTransaction,
    acquirePaymentLock, enqueueRedemption, env = process.env }) {
    function fail(status, message) { throw Object.assign(new Error(message), { status }); }

    return async function updateCdkStatus({ cdk, status, shipped, expectedStatus, expectedShipped, reason, adminEmail }) {
        if (typeof cdk !== 'string' || !/^[a-zA-Z0-9_-]{4,32}$/.test(cdk)) fail(400, '请输入有效卡密');
        if (status !== undefined && status !== 'redeemed') fail(400, '使用状态仅支持修改为已核销，不能重置兑换记录');
        if (shipped !== undefined && typeof shipped !== 'boolean') fail(400, '出库状态必须为布尔值');
        if (status === undefined && shipped === undefined) fail(400, '请选择需要修改的状态');
        if (expectedStatus !== undefined && !['unused', 'processing', 'redeemed'].includes(expectedStatus)) fail(400, '无效的原使用状态');
        if (expectedShipped !== undefined && typeof expectedShipped !== 'boolean') fail(400, '无效的原出库状态');
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 255) {
            fail(400, '请填写 1–255 字的修改备注');
        }
        const guard = await acquirePaymentLock(cdkLockKey(cdk));
        if (!guard) fail(409, '该卡密正在执行支付或查单，请稍后再修改状态');
        try {
            await guard.assertOwned();
            return await withTransaction(async connection => {
                const options = { connection };
                const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
                if (!code || !code.is_active) fail(404, '卡密不存在或已停用');
                const [task] = await runQuery('SELECT * FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [code.cdk_code], options);
                const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE cdk_code = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [code.cdk_code], options);
                const redeemed = Boolean(code.manual_redeemed_at) || order?.state === 'success'
                    || (task?.status === 'success' && (!task.orbitcard_state || task.orbitcard_state === 'success'));
                const occupied = Boolean(code.used_at) || ['running', 'manual'].includes(task?.status)
                    || ['support_locked', 'balance_blocked'].includes(task?.orbitcard_state);
                const currentStatus = redeemed ? 'redeemed' : occupied ? 'processing' : 'unused';
                const currentShipped = Boolean(code.shipped_at);
                if ((expectedStatus !== undefined && expectedStatus !== currentStatus)
                    || (expectedShipped !== undefined && expectedShipped !== currentShipped)) {
                    fail(409, '卡密状态已发生变化，请刷新列表后重新编辑');
                }
                const redemptionChanged = status === 'redeemed' && !redeemed;
                const shippingChanged = shipped !== undefined && shipped !== currentShipped;
                const result = { status: redemptionChanged ? 'redeemed' : currentStatus,
                    shipped: shipped ?? currentShipped, changed: redemptionChanged || shippingChanged, redemptionChanged };
                if (!result.changed) return result;
                // Prepared administrator orders can be resumed with their original request ID.
                if (redemptionChanged && order && ['preparing', 'prepared'].includes(order.state)) {
                    fail(409, '该卡密的人工交付订单仍在准备支付，请先处理原订单');
                }
                await guard.assertOwned();
                if (redemptionChanged) {
                    if (!readConfig(env)) fail(409, '请先配置商城核销通知地址、来源和密钥，再进行人工核销');
                    await runExecute(`UPDATE cdk_codes SET manual_redeemed_at = CURRENT_TIMESTAMP,
                        manual_redeemed_by = ?, manual_redemption_reason = ?,
                        used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?`,
                    [String(adminEmail || '').slice(0, 255), reason.trim(), code.cdk_code], options);
                    await enqueueRedemption({ cdk: code.cdk_code,
                        orderId: task?.orbitcard_retry_root_job_key || task?.job_key || order?.client_order_no || `support-${code.id}` }, options);
                }
                if (shippingChanged) {
                    await runExecute(`UPDATE cdk_codes SET shipped_at = ${shipped ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE cdk_code = ?`, [code.cdk_code], options);
                }
                await runExecute('INSERT INTO admin_login_logs (event, admin_email, detail) VALUES (?, ?, ?)',
                    ['cdk_status_changed', String(adminEmail || '').slice(0, 128),
                        `卡密：${code.cdk_code}；使用状态：${currentStatus} → ${result.status}；出库：${currentShipped} → ${result.shipped}；备注：${reason.trim()}`], options);
                return result;
            });
        } finally { await guard.release(); }
    };
};
