'use strict';

const crypto = require('node:crypto');
const { parseSession } = require('./session-input');
const config = require('./orbitcard-config');
const { cdkLockKey } = require('./payment-execution-lock');
const { PaymentQueueFullError, queueFeedback } = require('./payment-waiting-queue');

// The only redemption entry point. Reservation is acquired before any remote create.
module.exports = function createActivationHandler({ store, ensureStoreReady, activeJobs, runWorker, log, waitingQueue, broadcast = () => {}, isDraining = () => false }) {
    return async function handleActivationRequest(req, res) {
        const cdk = String(req.body?.cdk || '').trim();
        if (!/^[a-zA-Z0-9_-]{4,32}$/.test(cdk)) return res.status(400).json({ success: false, message: '请输入有效 CDK' });
        let session;
        try { session = parseSession(req.body?.session || req.body?.token); }
        catch (error) { return res.status(400).json({ success: false, message: error.message }); }
        let slot = null, task = null, dispatched = false, executionGuard = null, waitingTicket = null;
        try {
            await ensureStoreReady();
            const code = await store.verifyCdkDetails(cdk);
            if (code?.manual_redeemed_at) return res.status(403).json({ success: false, message: '该卡密已由人工售后核销，不能再次充值' });
            const existing = code && await store.getRunningTaskByCdk(cdk);

            const resumingRetry = existing?.orbitcard_state === 'retry_waiting' && Boolean(existing.gpt_api_order_id);
            if (existing && !resumingRetry) return res.json({ success: true,
                jobKey: existing.orbitcard_retry_root_job_key || existing.job_key,
                provider: existing.orbitcard_client_order_no ? 'orbitcard' : 'history',
                queued: Boolean(waitingQueue?.has(existing.job_key)),
                status: existing.status, message: existing.message || '已恢复原订单，请查询充值结果' });
            if (!code || (code.used_at && !resumingRetry) || code.type !== '自助') return res.status(403).json({ success: false, message: 'CDK 无效、已使用或不支持此类型' });
            const maintenance = await store.getMaintenanceModeState();
            if (isDraining() || maintenance.enabled) return res.status(503).json({ success: false, message: '系统暂停接单，请稍后再试' });
            const cfg = await store.getGptApiConfig();
            if (!cfg.enabled) return res.status(503).json({ success: false, message: 'Orbitcard 充值暂未开放，请联系管理员' });
            config.prepareConfig({}, cfg, Boolean(String(process.env.ORBITCARD_API_SECRET || '').trim()));
            const apiKeyHash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
            executionGuard = await store.acquirePaymentLock(cdkLockKey(cdk));
            if (!executionGuard) return res.status(409).json({ success: false, message: '此 CDK 正在处理，请查询原订单，不要重复提交' });
            await executionGuard.assertOwned();
            const max = await store.getMaxConcurrentActivations();
            if (waitingQueue?.isFull()) throw new PaymentQueueFullError();
            if (activeJobs.size >= max && !waitingQueue) return res.status(429).json({ success: false, message: '当前任务已满，请稍后再试' });
            slot = `accept-${crypto.randomUUID()}`;
            if (activeJobs.size >= max) waitingTicket = await waitingQueue.acquire(slot);
            activeJobs.add(slot); // No await between capacity check and reservation.
            task = resumingRetry ? await store.claimOrbitcardRetry(existing.job_key, { email: session.user.email, baseUrl: cfg.base_url, apiKeyHash })
                : await store.createOrbitcardTask({ cdk, planType: code.plan_type || 'plus', email: session.user.email, baseUrl: cfg.base_url, apiKeyHash });
            if (!task) return res.status(409).json({ success: false, message: 'CDK 已被占用，请查询原订单' });
            activeJobs.delete(slot);
            slot = task.jobKey;
            activeJobs.add(slot);
            waitingTicket?.rename(task.jobKey);
            task.apiConfig = { ...cfg, auditJobKey: task.jobKey, executionGuard,
                paymentGuard: { assertAllowed: () => store.assertPaymentAllowed(task.jobKey) } };
            log(task.jobKey, '已取得 CDK 跨进程执行权，恢复任务将跳过本次处理中订单', 'execution_lock_acquired');
            log(task.jobKey, `Orbitcard 兑换任务已创建，CDK=${cdk}`);
            if (waitingTicket) {
                const saved = await store.settleOrbitcardTask(task.jobKey, { status: 'running', progress: 3,
                    orbitcardState: task.orbitcardState || 'prepared', expectedState: task.orbitcardState || 'prepared',
                    expectedClientOrderNo: task.orbitcardClientOrderNo, message: waitingQueue.waitingMessage });
                if (!saved.applied) throw new Error('排队任务状态已改变');
                log(task.jobKey, waitingQueue.waitingMessage, 'payment_queue_waiting');
            }
            // A queued request returns immediately; its original Session exists only in this continuation.
            const pending = waitingTicket ? (async () => {
                try { await waitingQueue.waitForCapacity(waitingTicket, { session, cfg: task.apiConfig }); }
                catch (error) {
                    await executionGuard.assertOwned();
                    const result = await store.settleOrbitcardTask(task.jobKey, { status: 'failed', progress: 0,
                        orbitcardState: 'rejected', expectedState: task.orbitcardState || 'prepared',
                        expectedClientOrderNo: task.orbitcardClientOrderNo, message: error.message });
                    if (result.applied) broadcast(task.orbitcardRetryRootJobKey || task.jobKey,
                        { type: 'status', status: 'failed', message: error.message, ...queueFeedback(error) });
                    log(task.jobKey, error.message, 'payment_queue_stopped');
                    return;
                }
                return runWorker({ task, session, planType: code.plan_type || 'plus' });
            })() : runWorker({ task, session, planType: code.plan_type || 'plus' });
            dispatched = true;
            Promise.resolve(pending).catch(() => {}).finally(async () => {
                activeJobs.delete(task.jobKey);
                try { await waitingTicket?.release(); }
                finally { await executionGuard.release(); }
            }).catch(() => {});
            return res.json({ success: true, provider: 'orbitcard', jobKey: task.orbitcardRetryRootJobKey || task.jobKey,
                queued: Boolean(waitingTicket), message: waitingTicket ? waitingQueue.waitingMessage : '订单已受理，请持续查询原订单' });
        } catch (error) {
            if (task && !dispatched) {
                try { await executionGuard.assertOwned(); await store.settleOrbitcardTask(task.jobKey, { status: 'failed', progress: 0,
                    orbitcardState: 'rejected', expectedState: task.orbitcardState || 'prepared',
                    expectedClientOrderNo: task.orbitcardClientOrderNo, message: '任务尚未提交，CDK 已释放' }); } catch (_) { /* startup recovery will reconcile the durable preparation record */ }
            }
            if (error instanceof PaymentQueueFullError) {
                res.set?.('Retry-After', '600');
                return res.status(429).json({ success: false, message: error.message, ...queueFeedback(error) });
            }
            return res.status(503).json({ success: false, message: '充值服务暂不可用，请联系管理员检查配置或查询原订单' });
        } finally {
            if (slot && !dispatched) activeJobs.delete(slot);
            if (waitingTicket && !dispatched) await waitingTicket.release();
            if (executionGuard && !dispatched) await executionGuard.release();
        }
    };
};
