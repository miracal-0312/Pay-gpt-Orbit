'use strict';

// Both interactive refresh and restart recovery query the same durable identity.
module.exports = function createRecovery({ store, query, activeJobs, audit, notify = async () => {} }) {
    async function refreshTask(task) {
        if (activeJobs.has(task.job_key)) return { success: true, querySkipped: true };
        if (task.orbitcard_state === 'prepared') {
            const result = await store.settleOrbitcardTask(task.job_key, { status: 'failed', progress: 0,
                message: '任务在提交前中断，CDK 已释放', orbitcardState: 'rejected', expectedState: 'prepared' });
            audit({ jobKey: task.job_key, source: 'orbitcard', event: 'recovery_unsubmitted', text: '恢复未提交任务', data: { applied: result.applied } });
            return { success: true, applied: result.applied, querySkipped: true };
        }
        if (['failed', 'rejected'].includes(task.orbitcard_state)) return { success: true, querySkipped: true };
        const result = await query.refresh({ cfg: await store.getGptApiConfig(), task, persist: store.settleOrbitcardTask });
        if (result.success && result.applied) {
            const latest = await store.getTaskStatus(task.job_key);
            if (latest && latest.status !== task.status && ['success','failed'].includes(latest.status)) {
                try { await notify(latest); } catch (_) { /* the order is already settled; notifications must never reverse it */ }
            }
        }
        return result;
    }
    let inProgress = false;
    const pausedUntil = new Map();
    async function recover() {
        if (inProgress) return;
        inProgress = true;
        try {
            const tasks = await store.listRecoverableOrbitcardTasks();
            for (const task of tasks) {
                if ((pausedUntil.get(task.job_key) || 0) > Date.now()) continue;
                try {
                    const result = await refreshTask(task);
                    if (!result.querySkipped) {
                        await store.noteQueryAttempt(task.job_key);
                        pausedUntil.set(task.job_key, Date.now() + Math.max(result.success ? 10000 : 30000, result.retryAfterMs || 0));
                    }
                } catch (_) {
                    await store.noteQueryAttempt(task.job_key).catch(() => {});
                    pausedUntil.set(task.job_key, Date.now() + 30000);
                    audit({ jobKey: task.job_key, source: 'orbitcard', event: 'recovery_error', text: '原单恢复暂时失败，保留订单与 CDK，下次继续查询' });
                }
            }
            for (const [key, until] of pausedUntil) if (until <= Date.now()) pausedUntil.delete(key);
        } finally { inProgress = false; }
    }
    return { refreshTask, recover };
};
