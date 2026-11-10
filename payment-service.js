'use strict';
const { CardPreparationError, CardSelectionError, FundingAwaitingError, FUNDING_POLL_MS, FUNDING_WAIT_MS } = require('./orbitcard-card-policy');
const { PaymentStoppedError } = require('./payment-automation');
const { parseSession } = require('./session-input');
class FundingContinuationDeferred extends Error {}

// CDK orchestration: submits one payment and owns settlement.
// HTTP/WebSocket registration stays in server.js.
module.exports = function createPaymentService({ store, cardService, worker, activeJobs, activeChallenges,
    audit, broadcast, log, notify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
    async function runWorker({ task, session, planType }) {
        const jobKey = task.jobKey;
        const rootJobKey = task.orbitcardRetryRootJobKey || task.jobKey;
        let submitted = false;
        let preparationState = task.orbitcardState || 'prepared';
        const setProgress = async (status, progress, message, extra = {}) => {
            await task.apiConfig.executionGuard?.assertOwned();
            const saved = await store.settleOrbitcardTask(jobKey, { status, progress, message, ...extra });
            if (!saved.applied) throw new Error('任务已结束或被替换');
            if (saved.status === 'manual' && status !== 'manual') throw new PaymentStoppedError('任务已转人工处理');
            audit({ jobKey, source: 'orbitcard', event: 'task_state', text: message,
                data: { status, progress, orbitcard_state: extra.orbitcardState } });
            broadcast(rootJobKey, { type: 'status', status, progress, message });
        };
        async function prepareCard() {
            await setProgress('running', 10, '正在准备支付...', {
                orbitcardState: preparationState, expectedState: preparationState, expectedClientOrderNo: task.orbitcardClientOrderNo
            });
            async function ready(cardId) {
                await setProgress('running', 15, '卡片资金已就绪，准备提交原订阅订单', {
                    orbitcardState: 'prepared', expectedState: preparationState, expectedClientOrderNo: task.orbitcardClientOrderNo
                });
                preparationState = 'prepared';
                return cardId;
            }
            let pending;
            try { return await ready(await cardService.allocate(task.apiConfig, jobKey, planType)); }
            catch (error) { if (!(error instanceof FundingAwaitingError)) throw error; pending = error; }
            await setProgress('running', 10, '正在补款，每 5 秒核对，最多等待 120 秒；足额后继续订阅', {
                orbitcardState: 'funding_waiting', expectedState: preparationState, expectedClientOrderNo: task.orbitcardClientOrderNo
            });
            preparationState = 'funding_waiting';
            // Session remains only in this bounded in-memory continuation. On
            // restart or expiry, recovery can reconcile funds but needs a fresh Session.
            const deadline = now() + FUNDING_WAIT_MS;
            while (now() < deadline) {
                const delay = Math.max(FUNDING_POLL_MS, pending.retryAfterMs || 0);
                if (now() + delay > deadline) break;
                await task.apiConfig.executionGuard?.assertOwned();
                await task.apiConfig.paymentGuard.assertAllowed();
                try { parseSession(session); } catch (_) { break; }
                // allocate()/confirmFunding() have released the global card lock.
                await sleep(delay);
                await task.apiConfig.executionGuard?.assertOwned();
                await task.apiConfig.paymentGuard.assertAllowed();
                if (now() >= deadline) break;
                let cardId;
                try { cardId = await cardService.confirmFunding(task.apiConfig, jobKey, planType); }
                catch (error) { if (!(error instanceof FundingAwaitingError)) throw error; pending = error; continue; }
                if (now() >= deadline) break;
                try { parseSession(session); } catch (_) { break; }
                return ready(cardId);
            }
            await setProgress('manual', 10, '补款等待已结束，已创建人工对账工单；后台继续查原补款，确认后释放并提示重新提交 Session', {
                orbitcardState: 'funding_review', expectedState: 'funding_waiting', expectedClientOrderNo: task.orbitcardClientOrderNo
            });
            preparationState = 'funding_review';
            throw new FundingContinuationDeferred();
        }
        try {
            task.apiConfig = { ...task.apiConfig, auditJobKey: jobKey,
                paymentGuard: { assertAllowed: () => store.assertPaymentAllowed(jobKey) } };
            await task.apiConfig.paymentGuard.assertAllowed();
            await worker.run({ cfg: task.apiConfig, planType, session,
                clientOrderNo: task.orbitcardClientOrderNo, setProgress,
                selectCard: prepareCard,
                onSubmission: () => { submitted = true; }, sleep,
                onConfirmedFailure: async failure => {
                    await task.apiConfig.executionGuard?.assertOwned();
                    const recorded = await store.recordOrbitcardPaymentFailure(jobKey, failure);
                    if (!recorded.applied) throw new Error('支付失败记录已被其他执行者处理，保留原订单核对');
                    try { log(jobKey, `支付已明确失败，不再重试，卡 ID ${failure.cardId}`, 'payment_attempt_failed'); }
                    catch (_) { /* Failure settlement is already committed. */ }
                    return recorded;
                },
                broadcast: captcha => {
                    if (captcha) activeChallenges.set(jobKey, captcha); else activeChallenges.delete(jobKey);
                    broadcast(rootJobKey, { type: 'orbitcard-captcha', captcha });
                } });
            const settled = await store.getTaskStatus(jobKey);
            if (settled) await notify(settled).catch(() => log(jobKey, '任务已结算，通知发送失败', 'notification_failed'));
            if (settled?.status === 'success' && settled.orbitcard_card_id) {
                await cardService.reconcile(task.apiConfig,settled.orbitcard_card_id,jobKey)
                    .catch(() => log(jobKey,'订阅已成功，卡片资金只读核对暂不可用，请稍后在后台查询','payment_reconciliation_pending'));
            }
        } catch (error) {
            if (error instanceof FundingContinuationDeferred) {
                log(jobKey, '原补款交由后台只读对账，订阅尚未提交', 'funding_continuation_deferred');
                return;
            }
            if (error instanceof PaymentStoppedError) {
                log(jobKey, '任务已退出自动支付，保留原记录供人工处理', 'payment_automation_stopped');
                return;
            }
            if (task.apiConfig.executionGuard) {
                try { await task.apiConfig.executionGuard.assertOwned(); }
                catch (_) { log(jobKey, '支付执行权已失效，保留原订单由恢复任务核对', 'execution_lock_lost'); return; }
            }
            if (!submitted && error instanceof CardSelectionError) {
                try {
                    const locked=await store.lockOrbitcardSupport(jobKey,preparationState,error.message,{cardSelectionExhausted:true});
                    if(locked.applied) {
                        audit({jobKey,source:'orbitcard',event:'card_selection_support_locked',text:error.message});
                        broadcast(rootJobKey,{type:'status',status:'failed',message:error.message});
                        const latest=await store.getTaskStatus(jobKey);
                        if(latest) await notify(latest).catch(()=>{});
                    }
                } catch (_) {
                    log(jobKey,'异常卡片售后锁定待数据库恢复确认','card_selection_lock_pending');
                }
                return;
            }
            let cardPending = false, fundingPending = false, preparationUnknown = false;
            if (!submitted) {
                try {
                    const issue = await store.getCardIssueForTask(jobKey);
                    cardPending = Boolean(issue && !['ready','failed'].includes(issue.state));
                    const funding=await store.getCardFundingForTask(jobKey);
                    fundingPending=Boolean(funding && !['ready','failed'].includes(funding.state));
                } catch (_) { preparationUnknown = true; }
            }
            const message = submitted ? 'Orbitcard 提交结果待确认，后台将按原订单号持续查询；请勿重复充值' : preparationUnknown
                ? '支付准备记录暂时无法核对，已保留 CDK 与支付卡并停止自动支付；请人工核对原任务' : fundingPending
                ? '原支付卡补款仍待核对，已转人工处理并停止自动支付；会员充值尚未提交，保留卡片和 CDK'
                : cardPending ? '支付卡申请仍待核对，已转人工处理并停止自动支付；会员充值尚未提交，保留 CDK 和原申请'
                : error instanceof CardPreparationError
                    ? `${error.message}；本次会员充值未提交，CDK 已释放` : 'Orbitcard 提交前异常，请检查配置或查询原订单';
            // Persist before logging: a logging error must not prevent preservation of order ownership.
            try {
                const nextStatus = submitted ? 'running' : preparationUnknown || cardPending || fundingPending ? 'manual' : 'failed';
                const result = await store.settleOrbitcardTask(jobKey, { status: nextStatus, progress: 0,
                        message, orbitcardState: submitted ? 'pending' : preparationUnknown ? preparationState : fundingPending ? 'funding_pending' : cardPending ? 'card_pending' : 'rejected',
                        ...(submitted ? {} : { expectedState: preparationState, expectedClientOrderNo: task.orbitcardClientOrderNo }) });
                if (result.applied) {
                    broadcast(rootJobKey, { type: 'status', status: nextStatus, message });
                    const latest = await store.getTaskStatus(jobKey);
                    if (latest) await notify(latest).catch(() => {});
                }
            } catch (_) { /* durable identity remains reserved; recovery only queries this identity */ }
            log(jobKey, message, 'worker_error');
        } finally { activeChallenges.delete(jobKey); activeJobs.delete(jobKey); }
    }

    return { run: runWorker };
};
