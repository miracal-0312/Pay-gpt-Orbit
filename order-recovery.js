'use strict';
const { cdkLockKey } = require('./payment-execution-lock');
const { requiresManualHandling } = require('./payment-automation');

// Both interactive refresh and restart recovery query the same durable identity.
module.exports = function createRecovery({ store, query, activeJobs, audit, notify = async () => {}, checkBalance = async () => false, now = Date.now }) {
    async function refreshTask(task) {
        if (activeJobs.has(task.job_key)) return { success: true, querySkipped: true };
        const guard = await store.acquirePaymentLock(cdkLockKey(task.cdk_code));
        if (!guard) return { success: true, querySkipped: true, waitMs: 5000 };
        try {
            await guard.assertOwned();
            // A snapshot obtained before acquiring ownership may already be stale.
            const current = await store.getTaskStatus(task.job_key);
            if (!current) return { success: true, querySkipped: true };
            return await refreshOwnedTask(current, guard);
        } finally { await guard.release(); }
    }
    async function refreshOwnedTask(task, guard) {
        const mutate = async (method, args) => { await guard.assertOwned(); return store[method](...args); };
        const settle = (...args) => mutate('settleOrbitcardTask', args);
        const lockSupport = (...args) => mutate('lockOrbitcardSupport', args);
        const recordFailure = (...args) => mutate('recordOrbitcardPaymentFailure', args);
        if (activeJobs.has(task.job_key)) return { success: true, querySkipped: true };
        if (requiresManualHandling(task) && !['submitting', 'pending', 'manual'].includes(task.orbitcard_state)) {
            return { success: true, querySkipped: true };
        }
        if (task.orbitcard_state === 'retry_waiting') {
            await lockSupport(task.job_key, 'retry_waiting',
                '自动重试已停用，请联系售后QQ 2244527967处理', { legacyRetry: true });
            return { success: true, querySkipped: true };
        }
        if (task.orbitcard_state === 'support_locked') return { success: true, querySkipped: true };
        if(task.orbitcard_state==='balance_blocked') {
            if(!await checkBalance(task)) return {success:true,querySkipped:true,waitMs:60000};
            if (Number(task.orbitcard_retry_attempt_no || 1) > 1) {
                const result=await lockSupport(task.job_key,'balance_blocked',
                    '支付重试期间账户余额不足，CDK 已锁定；请联系人工售后');
                return {success:true,applied:result.applied,querySkipped:true};
            }
            const result=await settle(task.job_key,{status:'retry',progress:0,orbitcardState:'rejected',expectedState:'balance_blocked',
                message:'账户可用余额已补足，CDK 已解除锁定；请重新验证卡密并提交最新 Session 继续充值'});
            audit({jobKey:task.job_key,source:'orbitcard',event:'account_balance_restored',text:'账户余额已补足，等待用户重新提交 Session',data:{applied:result.applied}});
            return {success:true,applied:result.applied,querySkipped:true};
        }
        if (task.orbitcard_state === 'prepared') {
            let preparedIssue = null;
            const preparedFunding=store.getCardFundingForTask?await store.getCardFundingForTask(task.job_key):null;
            if(preparedFunding && !['ready','failed'].includes(preparedFunding.state)) {
                const result=await settle(task.job_key,{status:'manual',progress:10,orbitcardState:'funding_pending',expectedState:'prepared',
                    message:'原卡片补款仍待确认，已转人工处理并停止自动支付；会员充值未提交，保留卡片和 CDK'});
                return {success:true,applied:result.applied,querySkipped:true};
            }
            if (task.orbitcard_issue_key) {
                preparedIssue = await store.getCardIssueForTask(task.job_key);
                if (preparedIssue && !['ready','failed'].includes(preparedIssue.state)) {
                    const result = await settle(task.job_key, { status: 'manual', progress: 10,
                        orbitcardState: 'card_pending', expectedState: 'prepared', message: '原支付卡申请仍待确认，已转人工处理并停止自动支付；会员充值未提交，保留 CDK 和原申请' });
                    return { success: true, applied: result.applied, querySkipped: true };
                }
            }
            if (Number(task.orbitcard_retry_attempt_no || 1) > 1) {
                const result = await lockSupport(task.job_key, 'prepared',
                    '支付重试在订阅提交前中断，CDK 已锁定；请联系人工售后');
                return { success: true, applied: result.applied, querySkipped: true };
            }
            const fundingFailed=preparedFunding?.state==='failed';
            const cardReady = !fundingFailed && (preparedIssue?.state === 'ready' || preparedFunding?.state==='ready');
            const result = await settle(task.job_key, { status: cardReady ? 'retry' : 'failed', progress: 0,
                message: cardReady ? '支付卡已准备，任务在订阅提交前中断；请重新验证 CDK 并提交最新 Session'
                    : fundingFailed?'原卡片补款未成功，会员充值未提交，CDK 已释放':'任务在提交前中断，CDK 已释放', orbitcardState: 'rejected', expectedState: 'prepared' });
            audit({ jobKey: task.job_key, source: 'orbitcard', event: 'recovery_unsubmitted', text: '恢复未提交任务', data: { applied: result.applied } });
            return { success: true, applied: result.applied, querySkipped: true };
        }
        if (['failed', 'rejected'].includes(task.orbitcard_state)) return { success: true, querySkipped: true };
        const result = await query.refresh({ cfg: await store.getGptApiConfig(), task, persist: settle,
            onConfirmedFailure: store.recordOrbitcardPaymentFailure
                ? (original, failure) => recordFailure(original.job_key, failure) : undefined });
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
    function pause(jobKey, waitMs, failed = false) {
        const failures = failed ? Math.min(5, (pausedUntil.get(jobKey)?.failures || 0) + 1) : 0;
        const delay = Math.min(24 * 60 * 60 * 1000, Math.max(Number(waitMs) || 0,
            failed ? Math.min(300000, 30000 * 2 ** (failures - 1)) : 0));
        if (!pausedUntil.has(jobKey) && pausedUntil.size >= 1000) pausedUntil.delete(pausedUntil.keys().next().value);
        pausedUntil.set(jobKey, { until: now() + delay, failures });
    }
    async function recover() {
        if (inProgress) return;
        inProgress = true;
        try {
            for (const [key, state] of pausedUntil) if (state.until + 600000 <= now()) pausedUntil.delete(key);
            const tasks = await store.listRecoverableOrbitcardTasks();
            for (const task of tasks) {
                if ((pausedUntil.get(task.job_key)?.until || 0) > now()) continue;
                try {
                    const result = await refreshTask(task);
                    if(result.waitMs) {
                        await store.noteQueryAttempt(task.job_key);
                        pause(task.job_key, result.waitMs);
                    }
                    if (!result.querySkipped) {
                        await store.noteQueryAttempt(task.job_key);
                        pause(task.job_key, Math.max(10000, result.retryAfterMs || 0), !result.success);
                    }
                } catch (_) {
                    await store.noteQueryAttempt(task.job_key).catch(() => {});
                    pause(task.job_key, 30000, true);
                    audit({ jobKey: task.job_key, source: 'orbitcard', event: 'recovery_error', text: '原单恢复暂时失败，保留订单与 CDK，下次继续查询' });
                }
            }
        } finally { inProgress = false; }
    }
    return { refreshTask, recover };
};
