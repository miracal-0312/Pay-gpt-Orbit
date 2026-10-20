'use strict';

module.exports = function createLocalTaskStore({ withTransaction, runQuery, runExecute, createTaskLog }) {
    async function createLocalTask({ cdk, planType, tokenPreview, sessionPayload }) {
        return withTransaction(async connection => {
            const options = { connection };
            const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            if (!code || !code.is_active || code.used_at || code.type !== '自助' || (code.plan_type || 'plus') !== planType) return null;
            const pending = await runQuery(`SELECT job_key FROM task_logs WHERE cdk_code = ?
                AND (status IN ('running','manual') OR orbitcard_state IN ('prepared','submitting','pending','manual','success')) LIMIT 1`, [cdk], options);
            if (pending.length) return null;
            const task = await createTaskLog({ tokenPreview, sessionPayload, cdkCode: cdk, status: 'running', progress: 3 }, options);
            await runExecute("UPDATE task_logs SET local_payment_state = 'prepared' WHERE job_key = ?", [task.jobKey], options);
            await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ?', [cdk], options);
            return { ...task, localPayment: true };
        });
    }

    async function settleLocalTask(jobKey, { status, message, progress, rawOutput, failureScreenshots, cardLast4, localState, expectedState }) {
        const [initial] = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial) throw new Error('充值任务不存在');
        return withTransaction(async connection => {
            const options = { connection };
            await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [initial.cdk_code], options);
            const [task] = await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options);
            if (!task || task.orbitcard_client_order_no) throw new Error('任务不属于本地充值');
            const [latest] = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [initial.cdk_code], options);
            if (latest?.job_key !== jobKey || (expectedState && task.local_payment_state !== expectedState)) return { applied: false };
            if (task.status === 'success' && status !== 'success') return { applied: false };
            if (task.local_payment_state === 'failed' && status !== 'success') return { applied: false };
            const state = localState || status;
            await runExecute(`UPDATE task_logs SET status = ?, local_payment_state = ?, message = ?,
                progress = GREATEST(progress, ?), raw_output = COALESCE(?, raw_output),
                failure_screenshots = COALESCE(?, failure_screenshots), card_last4 = COALESCE(?, card_last4) WHERE job_key = ?`,
            [status, state, message || '', Number(progress || 0), rawOutput || null,
                Array.isArray(failureScreenshots) ? JSON.stringify(failureScreenshots) : null, cardLast4 || null, jobKey], options);
            if (state === 'failed') {
                await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ?', [initial.cdk_code], options);
            } else {
                await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [initial.cdk_code], options);
            }
            return { applied: true };
        });
    }

    async function recoverLocalTasks() {
        // Only one application instance owns local browser workers.
        const rows = await runQuery(`SELECT job_key, local_payment_state FROM task_logs
            WHERE status = 'running' AND cdk_code IS NOT NULL AND orbitcard_client_order_no IS NULL
              AND cdk_code NOT LIKE 'ADMIN_%'`);
        for (const task of rows) {
            const unstarted = task.local_payment_state === 'prepared';
            await settleLocalTask(task.job_key, {
                status: unstarted ? 'failed' : 'manual',
                localState: unstarted ? 'failed' : 'manual',
                expectedState: task.local_payment_state || undefined,
                message: unstarted ? '服务重启，任务尚未启动，CDK 已释放' : '服务重启，本地支付结果待核对，CDK 保持占用'
            });
        }
        return rows;
    }

    return { createLocalTask, settleLocalTask, recoverLocalTasks };
};
