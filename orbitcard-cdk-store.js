'use strict';

// Transaction boundaries keep task creation, order linkage and CDK ownership consistent.
module.exports = function createOrbitcardCdkStore({ withTransaction, runQuery, runExecute, createTaskLog }) {
    async function createOrbitcardTask({ cdk, planType, email, baseUrl }) {
        return withTransaction(async connection => {
            const options = { connection };
            const rows = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const code = rows[0];
            if (!code || !code.is_active || code.used_at || code.type !== '自助') return null;
            if (String(code.plan_type || 'plus') !== String(planType)) return null;
            const unfinished = await runQuery(`SELECT job_key FROM task_logs WHERE cdk_code = ?
                AND orbitcard_state IN ('prepared','submitting','pending','manual','success') LIMIT 1`, [cdk], options);
            if (unfinished.length) return null;
            const task = await createTaskLog({ tokenPreview: email || 'Orbitcard', cdkCode: cdk, status: 'running', progress: 3 }, options);
            const identity = require('./orbitcard-cdk').clientOrderNo(cdk, task.jobKey);
            await runExecute(`UPDATE task_logs SET orbitcard_client_order_no = ?, orbitcard_state = 'prepared',
                orbitcard_plan_type = ?, orbitcard_email = ?, orbitcard_base_url = ? WHERE job_key = ?`,
            [identity, planType, email || '', baseUrl, task.jobKey], options);
            await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ?', [cdk], options);
            return { ...task, orbitcardClientOrderNo: identity };
        });
    }

    async function getOrbitcardTaskByCdk(cdk) {
        const rows = await runQuery(`SELECT t.* FROM task_logs t JOIN cdk_codes c ON c.cdk_code = t.cdk_code
            WHERE t.cdk_code = ? AND c.is_active = 1 AND t.orbitcard_client_order_no IS NOT NULL
            ORDER BY t.id DESC LIMIT 1`, [cdk]);
        return rows[0] || null;
    }

    async function settleOrbitcardTask(jobKey, { status, progress, message, orbitcardState, gptApiOrderId, gptApiRaw, expectedState }) {
        const initial = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial[0]) throw new Error('兑换任务不存在');
        return withTransaction(async connection => {
            const options = { connection };
            const cdk = initial[0].cdk_code;
            // Every transaction takes CDK then task locks in the same order.
            await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const rows = await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options);
            const task = rows[0];
            if (!task?.orbitcard_client_order_no) throw new Error('兑换任务未绑定 Orbitcard 订单');
            if (expectedState && task.orbitcard_state !== expectedState) return { applied: false, status: task.status };
            const latest = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            if (latest[0]?.job_key !== jobKey) return { applied: false, status: task.status };
            // Stale reads must never release a code after confirmed success, nor reopen a failed attempt.
            if (task.orbitcard_state === 'success' && orbitcardState !== 'success') return { applied: false, status: 'success' };
            if (['failed', 'rejected'].includes(task.orbitcard_state) && !['success','failed','rejected'].includes(orbitcardState)) return { applied: false, status: task.status };
            await runExecute(`UPDATE task_logs SET status = ?, progress = GREATEST(progress, ?), message = ?,
                orbitcard_state = ?, gpt_api_order_id = COALESCE(?, gpt_api_order_id),
                gpt_api_raw = COALESCE(?, gpt_api_raw), session_payload = NULL WHERE job_key = ?`,
            [status, Number(progress || 0), message, orbitcardState, gptApiOrderId || null, gptApiRaw || null, jobKey], options);
            if (['failed', 'rejected'].includes(orbitcardState)) {
                await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ?', [cdk], options);
            } else {
                await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [cdk], options);
            }
            return { applied: true, status };
        });
    }

    return { createOrbitcardTask, getOrbitcardTaskByCdk, settleOrbitcardTask };
};
