'use strict';
const { cdkLockKey } = require('./payment-execution-lock');
const { requiresManualHandling, PaymentStoppedError } = require('./payment-automation');
const { FundingAwaitingError, FUNDING_POLL_MS } = require('./orbitcard-card-policy');

// Both interactive refresh and restart recovery query the same durable identity.
module.exports = function createRecovery({ store, query, activeJobs, audit, notify = async () => {}, checkBalance = async () => false,
    confirmFunding = null, now = Date.now }) {
    const fundingCheckAt = new Map();
    function deferFunding(jobKey, delay = FUNDING_POLL_MS) {
        const waitMs = Math.max(FUNDING_POLL_MS, Number(delay) || 0);
        for (const [key, until] of fundingCheckAt) if (until <= now()) fundingCheckAt.delete(key);
        if (!fundingCheckAt.has(jobKey) && fundingCheckAt.size >= 1000) fundingCheckAt.delete(fundingCheckAt.keys().next().value);
        fundingCheckAt.set(jobKey, now() + waitMs);
        return { success: true, querySkipped: true, waitMs };
    }
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
        if (requiresManualHandling(task) && !['submitting', 'pending', 'manual', 'funding_waiting', 'funding_review', 'funding_pending', 'card_pending'].includes(task.orbitcard_state)) {
            return { success: true, querySkipped: true };
        }
        if (task.orbitcard_state === 'retry_waiting') {
            const { confirmedFailure } = require('./payment-retry-policy');
            if (task.gpt_api_order_id && confirmedFailure(JSON.parse(task.gpt_api_raw || '{}'), {
                orderId: task.gpt_api_order_id, clientOrderNo: task.orbitcard_client_order_no, cardId: task.orbitcard_card_id,
                planType: require('./plan-registry').PROVIDER_PLANS[require('./plan-registry').paymentPlan(task.orbitcard_plan_type)], email: task.orbitcard_email
            })) return { success: true, querySkipped: true };
            await lockSupport(task.job_key, 'retry_waiting',
                '自动重试已停用，请联系售后QQ 2244527967处理', { legacyRetry: true });
            return { success: true, querySkipped: true };
        }
        if (task.orbitcard_state === 'support_locked') return { success: true, querySkipped: true };
        if (task.orbitcard_state === 'card_pending') {
            const issue = await store.getCardIssueForTask(task.job_key);
            if (!issue || !['ready','failed'].includes(issue.state)) return deferFunding(task.job_key, 60000);
            const result = await settle(task.job_key, { status: issue.state === 'ready' ? 'retry' : 'failed', progress: 0,
                orbitcardState: 'rejected', expectedState: 'card_pending', expectedClientOrderNo: task.orbitcard_client_order_no,
                message: '原开卡申请已完成核对，会员充值未提交，CDK 与卡片占用已释放；请重新验证卡密并提交最新 Session' });
            if (!result.applied) return { ...deferFunding(task.job_key, 60000), applied: false };
            audit({ jobKey: task.job_key, source: 'orbitcard', event: 'card_preparation_released', text: '原开卡申请已核对，释放未提交任务' });
            return { success: true, querySkipped: true, applied: true };
        }
        if (['funding_waiting', 'funding_review', 'funding_pending'].includes(task.orbitcard_state)) {
            // This process has no original Session. Reconcile funds only, then let
            // the user explicitly submit fresh credentials after releasing the CDK.
            let funding = await store.getCardFundingForTask(task.job_key);
            if (task.orbitcard_state === 'funding_waiting') {
                const result = await settle(task.job_key, { status: 'manual', progress: 10,
                    orbitcardState: 'funding_review', expectedState: task.orbitcard_state,
                    expectedClientOrderNo: task.orbitcard_client_order_no,
                    message: '原 Session 已丢失，补款已转对账工单；后台仅核对原流水，到账后请提交最新 Session' });
                return { ...deferFunding(task.job_key, Number(funding?.retry_at || 0) - now()), applied: result.applied };
            }
            const release = async failed => {
                const result = await settle(task.job_key, { status: failed ? 'failed' : 'retry', progress: 0,
                    orbitcardState: 'rejected', expectedState: task.orbitcard_state,
                    expectedClientOrderNo: task.orbitcard_client_order_no,
                    message: failed ? '原补款已确认失败，订阅尚未提交，CDK 与支付卡已释放'
                        : '原补款已确认到账，CDK 与支付卡已释放；请重新验证卡密并提交最新 Session 继续充值' });
                if (!result.applied) return { ...deferFunding(task.job_key, 60000), applied: false };
                fundingCheckAt.delete(task.job_key);
                audit({ jobKey: task.job_key, source: 'orbitcard', event: 'funding_recovery_released',
                    text: failed ? '原补款失败，释放未提交任务' : '原补款到账，等待用户提交最新 Session', data: { applied: result.applied } });
                return { success: true, applied: result.applied, querySkipped: true };
            };
            if (funding?.state === 'failed') return release(true);
            if (funding?.state === 'ready') return release(false);
            const due = Math.max(fundingCheckAt.get(task.job_key) || 0, Number(funding?.retry_at) || 0);
            if (due > now()) return { success: true, querySkipped: true, waitMs: due - now() };
            if (typeof confirmFunding !== 'function') return deferFunding(task.job_key);
            // Set before calling so interactive refreshes cannot exceed the polling interval.
            deferFunding(task.job_key);
            try {
                if (!funding?.order_no && funding?.state !== 'prepared') throw new Error('原补款缺少平台订单号，禁止自动恢复');
                const cardId = await confirmFunding(task, guard);
                await guard.assertOwned();
                funding = await store.getCardFundingForTask(task.job_key);
                if (funding?.state !== 'ready' || !Number.isSafeInteger(Number(cardId)) || Number(cardId) <= 0
                    || Number(cardId) !== Number(task.orbitcard_card_id) || Number(cardId) !== Number(funding.card_id)) {
                    throw new Error('原补款尚未确认可用或支付卡不匹配');
                }
                return release(false);
            } catch (error) {
                if (error instanceof PaymentStoppedError) return { success: true, querySkipped: true };
                await guard.assertOwned();
                if (error instanceof FundingAwaitingError) {
                    return deferFunding(task.job_key, error.retryAfterMs);
                }
                funding = await store.getCardFundingForTask(task.job_key);
                if (funding?.state === 'failed') return release(true);
                const result = await settle(task.job_key, { status: 'manual', progress: 10,
                    orbitcardState: 'funding_pending', expectedState: task.orbitcard_state,
                    expectedClientOrderNo: task.orbitcard_client_order_no,
                    message: '原补款对账存在异常，已停止自动处理；保留支付卡和 CDK，请人工核对' });
                // Keep checking a known original funding without reopening payment.
                // Missing identity or malformed evidence never authorizes a debit or release.
                return { ...deferFunding(task.job_key, Math.max(60000, Number(funding?.retry_at || 0) - now())), applied: result.applied };
            }
        }
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
        if (['preparing', 'prepared'].includes(task.orbitcard_state)) {
            let preparedIssue = null;
            const preparedFunding=store.getCardFundingForTask?await store.getCardFundingForTask(task.job_key):null;
            if(preparedFunding && !['ready','failed'].includes(preparedFunding.state)) {
                if (preparedFunding.state === 'pending' && preparedFunding.order_no
                    && Number(task.orbitcard_retry_attempt_no || 1) === 1) {
                    const result = await settle(task.job_key, { status: 'manual', progress: 10,
                        orbitcardState: 'funding_review', expectedState: task.orbitcard_state,
                        expectedClientOrderNo: task.orbitcard_client_order_no,
                        message: '原 Session 已丢失，补款已转对账工单；后台仅核对原流水，到账后请提交最新 Session' });
                    return { ...deferFunding(task.job_key, Math.max(FUNDING_POLL_MS, Number(preparedFunding.retry_at || 0) - now())), applied: result.applied };
                }
                const result=await settle(task.job_key,{status:'manual',progress:10,orbitcardState:'funding_pending',expectedState:task.orbitcard_state,
                    expectedClientOrderNo:task.orbitcard_client_order_no,
                    message:'原卡片补款仍待确认，已转人工处理并停止自动支付；会员充值未提交，保留卡片和 CDK'});
                return {success:true,applied:result.applied,querySkipped:true};
            }
            if (store.getCardIssueForTask) {
                preparedIssue = await store.getCardIssueForTask(task.job_key);
                if (preparedIssue && !['ready','failed'].includes(preparedIssue.state)) {
                    const result = await settle(task.job_key, { status: 'manual', progress: 10,
                        orbitcardState: 'card_pending', expectedState: task.orbitcard_state,
                        expectedClientOrderNo: task.orbitcard_client_order_no,
                        message: '原支付卡申请仍待确认，已转人工处理并停止自动支付；会员充值未提交，保留 CDK 和原申请' });
                    return { success: true, applied: result.applied, querySkipped: true };
                }
            }
            if (Number(task.orbitcard_retry_attempt_no || 1) > 1) {
                const result = await lockSupport(task.job_key, task.orbitcard_state,
                    '支付重试在订阅提交前中断，CDK 已锁定；请联系人工售后');
                return { success: true, applied: result.applied, querySkipped: true };
            }
            const fundingFailed=preparedFunding?.state==='failed';
            const cardReady = !fundingFailed && (preparedIssue?.state === 'ready' || preparedFunding?.state==='ready');
            const result = await settle(task.job_key, { status: cardReady ? 'retry' : 'failed', progress: 0,
                message: cardReady ? '支付卡已准备，任务在订阅提交前中断；请重新验证 CDK 并提交最新 Session'
                    : fundingFailed?'原卡片补款未成功，会员充值未提交，CDK 已释放':'任务在提交前中断，CDK 已释放',
                orbitcardState: 'rejected', expectedState: task.orbitcard_state,
                expectedClientOrderNo: task.orbitcard_client_order_no });
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
