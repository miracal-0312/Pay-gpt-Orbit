'use strict';

const crypto = require('node:crypto');
const { parseSession } = require('./session-input');
const config = require('./orbitcard-config');
const { cdkLockKey } = require('./payment-execution-lock');
const { requiresManualHandling } = require('./payment-automation');

// The only redemption entry point. Reservation is acquired before any remote create.
module.exports = function createActivationHandler({ store, ensureStoreReady, activeJobs, runWorker, log, isDraining = () => false }) {
    return async function handleActivationRequest(req, res) {
        const cdk = String(req.body?.cdk || '').trim();
        if (!/^[a-zA-Z0-9_-]{4,32}$/.test(cdk)) return res.status(400).json({ success: false, message: '请输入有效 CDK' });
        let session;
        try { session = parseSession(req.body?.session || req.body?.token); }
        catch (error) { return res.status(400).json({ success: false, message: error.message }); }
        let slot = null, task = null, dispatched = false, executionGuard = null;
        try {
            await ensureStoreReady();
            const code = await store.verifyCdkDetails(cdk);
            if (code?.manual_redeemed_at) return res.status(403).json({ success: false, message: '该卡密已由人工售后核销，不能再次充值' });
            const existing = code && await store.getRunningTaskByCdk(cdk);
            const resume = existing?.orbitcard_state === 'retry_waiting' && !requiresManualHandling(existing) && !activeJobs.has(existing.job_key);
            if (existing && !resume) return res.json({ success: true,
                jobKey: existing.orbitcard_retry_root_job_key || existing.job_key,
                provider: existing.orbitcard_client_order_no ? 'orbitcard' : 'history',
                status: existing.status, message: existing.message || '已恢复原订单，请查询充值结果' });
            if (!code || (code.used_at && !resume) || code.type !== '自助') return res.status(403).json({ success: false, message: 'CDK 无效、已使用或不支持此类型' });
            const maintenance = await store.getMaintenanceModeState();
            if (isDraining() || maintenance.enabled) return res.status(503).json({ success: false, message: '系统暂停接单，请稍后再试' });
            const cfg = await store.getGptApiConfig();
            if (!cfg.enabled) return res.status(503).json({ success: false, message: 'Orbitcard 充值暂未开放，请联系管理员' });
            config.prepareConfig({}, cfg, Boolean(String(process.env.ORBITCARD_API_SECRET || '').trim()));
            const apiKeyHash = crypto.createHash('sha256').update(String(cfg.api_key || '')).digest('hex');
            if (resume && (!existing.orbitcard_api_key_hash || existing.orbitcard_api_key_hash !== apiKeyHash
                || String(existing.orbitcard_email || '').toLowerCase() !== session.user.email.toLowerCase()
                || String(existing.orbitcard_base_url || '').replace(/\/+$/, '') !== String(cfg.base_url || '').replace(/\/+$/, ''))) {
                return res.status(409).json({ success: false, message: '重试须使用原目标账号和原 Orbitcard 平台；请联系人工售后' });
            }
            executionGuard = await store.acquirePaymentLock(cdkLockKey(cdk));
            if (!executionGuard) return res.status(409).json({ success: false, message: '此 CDK 正在处理，请查询原订单，不要重复提交' });
            await executionGuard.assertOwned();
            const max = await store.getMaxConcurrentActivations();
            if (activeJobs.size >= max) return res.status(429).json({ success: false, message: '当前任务已满，请稍后再试' });
            slot = `accept-${crypto.randomUUID()}`;
            activeJobs.add(slot); // No await between capacity check and reservation.
            if (resume) {
                if (!await store.claimOrbitcardRetryTask(existing.job_key, existing.orbitcard_client_order_no)) {
                    return res.status(409).json({ success: false, message: '支付重试已被处理，请查询原订单' });
                }
                task = { jobKey: existing.job_key, orbitcardClientOrderNo: existing.orbitcard_client_order_no,
                    orbitcardRetryRootJobKey: existing.orbitcard_retry_root_job_key || existing.job_key,
                    orbitcardRetryAttemptNo: existing.orbitcard_retry_attempt_no,
                    orbitcardRetryFirstCardId: existing.orbitcard_retry_first_card_id,
                    orbitcardRetrySecondCardId: existing.orbitcard_retry_second_card_id };
            } else task = await store.createOrbitcardTask({ cdk, planType: code.plan_type || 'plus', email: session.user.email,
                baseUrl: cfg.base_url, apiKeyHash });
            if (!task) return res.status(409).json({ success: false, message: 'CDK 已被占用，请查询原订单' });
            activeJobs.delete(slot);
            slot = task.jobKey;
            activeJobs.add(slot);
            task.apiConfig = { ...cfg, auditJobKey: task.jobKey, executionGuard };
            log(task.jobKey, '已取得 CDK 跨进程执行权，恢复任务将跳过本次处理中订单', 'execution_lock_acquired');
            log(task.jobKey, `Orbitcard 兑换任务已创建，CDK=${cdk}`);
            // Dispatch itself is synchronous; the worker catches asynchronous settlement errors.
            const pending = runWorker({ task, session, cdk, planType: code.plan_type || 'plus' });
            dispatched = true;
            Promise.resolve(pending).catch(() => {}).finally(async () => {
                activeJobs.delete(task.jobKey); await executionGuard.release();
            }).catch(() => {});
            return res.json({ success: true, provider: 'orbitcard', jobKey: task.orbitcardRetryRootJobKey || task.jobKey,
                message: resume ? '已继续原 CDK 的支付重试，请持续查询' : '订单已受理，请持续查询原订单' });
        } catch (_) {
            if (task && !dispatched) {
                try { await executionGuard.assertOwned(); await store.settleOrbitcardTask(task.jobKey, { status: 'failed', progress: 0,
                    orbitcardState: 'rejected', expectedState: 'prepared', message: '任务尚未提交，CDK 已释放' }); } catch (_) { /* startup recovery will reconcile the durable prepared record */ }
            }
            return res.status(503).json({ success: false, message: '充值服务暂不可用，请联系管理员检查配置或查询原订单' });
        } finally {
            if (slot && !dispatched) activeJobs.delete(slot);
            if (executionGuard && !dispatched) await executionGuard.release();
        }
    };
};
