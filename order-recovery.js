'use strict';
const { cdkLockKey } = require('./payment-execution-lock');

// Both interactive refresh and restart recovery query the same durable identity.
module.exports = function createRecovery({ store, query, activeJobs, audit, notify = async () => {}, reconcileCards = async () => {}, checkBalance = async () => false }) {
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
        if (['retry_waiting','support_locked'].includes(task.orbitcard_state)) return { success: true, querySkipped: true };
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
        if(task.orbitcard_state==='funding_pending') {
            await reconcileCards();
            const funding=await store.getCardFundingForTask(task.job_key);
            if(funding && ['ready','failed'].includes(funding.state)) {
                if (Number(task.orbitcard_retry_attempt_no || 1) > 1) {
                    const result=await lockSupport(task.job_key,'funding_pending',
                        '支付重试期间卡片补款需要人工核对，CDK 已锁定；请联系人工售后');
                    return {success:true,applied:result.applied,querySkipped:true};
                }
                const ready=funding.state==='ready';
                const result=await settle(task.job_key,{status:ready?'retry':'failed',progress:0,orbitcardState:'rejected',expectedState:'funding_pending',
                    message:ready?'原卡片补款已确认，CDK 已释放；请重新验证卡密并提交最新 Session 继续充值':'平台已确认原卡片补款失败，会员充值未提交，CDK 已释放'});
                audit({jobKey:task.job_key,source:'orbitcard',event:'card_funding_resolved',text:ready?'原补款已确认，等待重新提交 Session':'原补款失败，释放本次兑换预占',data:{funding_key:funding.funding_key,applied:result.applied}});
                return {success:true,applied:result.applied,querySkipped:true};
            }
            return {success:true,querySkipped:true,waitMs:60000};
        }
        if (task.orbitcard_state === 'card_pending') {
            await reconcileCards();
            const issue = await store.getCardIssueForTask(task.job_key);
            if (issue && ['ready','failed'].includes(issue.state)) {
                if (Number(task.orbitcard_retry_attempt_no || 1) > 1) {
                    const result=await lockSupport(task.job_key,'card_pending',
                        '支付重试期间新卡申请需要人工核对，CDK 已锁定；请联系人工售后');
                    return {success:true,applied:result.applied,querySkipped:true};
                }
                const ready = issue.state === 'ready';
                const result = await settle(task.job_key, { status: ready ? 'retry' : 'failed', progress: 0,
                    orbitcardState: 'rejected', expectedState: 'card_pending', message: ready
                        ? '支付卡已准备好，CDK 已释放；请重新验证卡密并提交最新 Session 继续充值'
                        : '平台已确认开卡失败，尚未提交会员充值，CDK 已释放' });
                audit({ jobKey: task.job_key, source: 'orbitcard', event: 'card_preparation_resolved', text: ready ? '支付卡已准备，等待重新提交 Session' : '开卡失败，已释放 CDK', data: { issue_key: issue.issue_key, applied: result.applied } });
                return { success: true, applied: result.applied, querySkipped: true };
            }
            return { success: true, querySkipped: true, waitMs:60000 };
        }
        if (task.orbitcard_state === 'prepared') {
            let preparedIssue = null;
            const preparedFunding=store.getCardFundingForTask?await store.getCardFundingForTask(task.job_key):null;
            if(preparedFunding && !['ready','failed'].includes(preparedFunding.state)) {
                const result=await settle(task.job_key,{status:'manual',progress:10,orbitcardState:'funding_pending',expectedState:'prepared',
                    message:'原卡片补款仍待确认，会员充值未提交；已锁定卡片和 CDK'});
                return {success:true,applied:result.applied,querySkipped:true};
            }
            if (task.orbitcard_issue_key) {
                preparedIssue = await store.getCardIssueForTask(task.job_key);
                if (preparedIssue && !['ready','failed'].includes(preparedIssue.state)) {
                    const result = await settle(task.job_key, { status: 'manual', progress: 10,
                        orbitcardState: 'card_pending', expectedState: 'prepared', message: '原支付卡申请仍待确认，会员充值未提交；保留 CDK 并继续确认原申请' });
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
            if (!result.retrying && latest && latest.status !== task.status && ['success','failed'].includes(latest.status)) {
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
                    if(result.waitMs) {
                        await store.noteQueryAttempt(task.job_key);
                        pausedUntil.set(task.job_key,Date.now()+result.waitMs);
                    }
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
