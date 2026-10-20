'use strict';

const crypto = require('node:crypto');
const { parseSession } = require('./session-input');
const config = require('./orbitcard-config');

// The only redemption entry point. Reservation is acquired before any remote create.
module.exports = function createActivationHandler({ store, ensureStoreReady, activeJobs, runWorker, log, isDraining = () => false }) {
    return async function handleActivationRequest(req, res) {
        const cdk = String(req.body?.cdk || '').trim();
        if (!/^[a-zA-Z0-9_-]{4,32}$/.test(cdk)) return res.status(400).json({ success: false, message: '请输入有效 CDK' });
        let session;
        try { session = parseSession(req.body?.session || req.body?.token); }
        catch (error) { return res.status(400).json({ success: false, message: error.message }); }
        let slot = null, task = null, dispatched = false;
        try {
            await ensureStoreReady();
            const code = await store.verifyCdkDetails(cdk);
            const existing = code && await store.getRunningTaskByCdk(cdk);
            if (existing) return res.json({ success: true, jobKey: existing.job_key,
                provider: existing.orbitcard_client_order_no ? 'orbitcard' : 'history',
                status: existing.status, message: existing.message || '已恢复原订单，请查询充值结果' });
            if (!code || code.used_at || code.type !== '自助') return res.status(403).json({ success: false, message: 'CDK 无效、已使用或不支持此类型' });
            const maintenance = await store.getMaintenanceModeState();
            if (isDraining() || maintenance.enabled) return res.status(503).json({ success: false, message: '系统暂停接单，请稍后再试' });
            const cfg = await store.getGptApiConfig();
            if (!cfg.enabled) return res.status(503).json({ success: false, message: 'Orbitcard 充值暂未开放，请联系管理员' });
            config.prepareConfig({}, cfg, Boolean(process.env.ORBITCARD_API_SECRET));
            const max = await store.getMaxConcurrentActivations();
            if (activeJobs.size >= max) return res.status(429).json({ success: false, message: '当前任务已满，请稍后再试' });
            slot = `accept-${crypto.randomUUID()}`;
            activeJobs.add(slot); // No await between capacity check and reservation.
            task = await store.createOrbitcardTask({ cdk, planType: code.plan_type || 'plus', email: session.user.email, baseUrl: cfg.base_url });
            if (!task) return res.status(409).json({ success: false, message: 'CDK 已被占用，请查询原订单' });
            activeJobs.delete(slot);
            slot = task.jobKey;
            activeJobs.add(slot);
            task.apiConfig = { ...cfg, auditJobKey: task.jobKey };
            log(task.jobKey, `Orbitcard 兑换任务已创建，CDK=${cdk}`);
            // Dispatch itself is synchronous; the worker catches asynchronous settlement errors.
            const pending = runWorker({ task, session, cdk, planType: code.plan_type || 'plus' });
            dispatched = true;
            Promise.resolve(pending).catch(() => {}).finally(() => activeJobs.delete(task.jobKey));
            return res.json({ success: true, provider: 'orbitcard', jobKey: task.jobKey, message: '订单已受理，请持续查询原订单' });
        } catch (_) {
            if (task && !dispatched) {
                try { await store.settleOrbitcardTask(task.jobKey, { status: 'failed', progress: 0,
                    orbitcardState: 'rejected', expectedState: 'prepared', message: '任务尚未提交，CDK 已释放' }); } catch (_) { /* startup recovery will reconcile the durable prepared record */ }
            }
            return res.status(503).json({ success: false, message: '充值服务暂不可用，请联系管理员检查配置或查询原订单' });
        } finally {
            if (slot && !dispatched) activeJobs.delete(slot);
        }
    };
};
