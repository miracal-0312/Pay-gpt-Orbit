require('./load-env')();

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');
const store = require('./mysql-store');
const runtimeLog = require('./runtime-log');
const adminAuth = require('./admin-auth');
const api = require('./orbitcard-client');
const { PLAN_LABELS } = require('./plan-registry');
const { notifyTelegramEvent } = require('./telegram-notify');
const app = express();
const activeJobs = new Set();
const clients = new Map();
const activeChallenges = new Map();
let ready = null, draining = false, recoveryTimer = null, server, wss;
const port = Number(process.env.PORT || 3000);
function ensureStoreReady() {
    if (!ready) ready = store.ensureReady().catch(error => { ready = null; throw error; });
    return ready;
}
function log(jobKey, text, event = 'task') { runtimeLog.push({ jobKey, source: 'orbitcard', event, text }); }
function broadcast(jobKey, data) {
    for (const ws of clients.get(jobKey) || []) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jobKey, ...data }));
}
function publicOrder(task) {
    return { provider: task.orbitcard_client_order_no ? 'orbitcard' : 'history',
        jobKey: task.orbitcard_retry_root_job_key || task.job_key,
        attemptJobKey: task.job_key, attempt: Number(task.orbitcard_retry_attempt_no || 1),
        status: task.orbitcard_state === 'retry_waiting' ? 'retry' : task.status,
        message: task.message, progress: Number(task.progress || 0),
        order_id: task.gpt_api_order_id || null, client_order_no: task.orbitcard_client_order_no || null,
        cdk_state: task.orbitcard_state === 'success' ? 'redeemed' : ['failed','rejected'].includes(task.orbitcard_state) ? 'available' : 'reserved',
        order: store.safeOrder(task.gpt_api_raw) };
}
async function notify(task) {
    if (!['success', 'failed', 'manual'].includes(task.status)) return;
    await notifyTelegramEvent(store, task.status === 'success' ? 'success' : task.status === 'manual' ? 'pending' : 'failure', {
        email: task.orbitcard_email || '', cdk: task.cdk_code, jobKey: task.job_key, message: task.message
    });
}
const cardService = require('./orbitcard-card-service')({ store, audit: entry => runtimeLog.push(entry) });
const manualService = require('./orbitcard-manual-service')({ store, activeJobs, cardService, audit: entry => runtimeLog.push(entry) });
const recovery = require('./order-recovery')({ store, query: require('./orbitcard-query'), activeJobs,
    audit: entry => runtimeLog.push(entry), notify,
    reconcileCards: async () => cardService.recover(await store.getGptApiConfig()),
    checkBalance: task => store.getGptApiConfig().then(cfg => cardService.canResumeBalance(cfg,task)) });
let cardRecoveryAt = 0;

const { run: runWorker } = require('./payment-service')({ store, cardService, worker: require('./orbitcard-worker'),
    activeJobs, activeChallenges, audit: entry => runtimeLog.push(entry), broadcast, log, notify });

app.disable('x-powered-by');
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));
app.use((req, res, next) => { if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store'); next(); });
require('./admin-http')(app, { store, ensureStoreReady, getTotalActiveJobs: () => activeJobs.size, cardService, manualService });

app.get('/api/public/runtime', async (req, res, next) => {
    try {
        await ensureStoreReady();
        res.json({ success: true, provider: 'orbitcard', runtime: { active_foreground_jobs: activeJobs.size,
            max_foreground_jobs: await store.getMaxConcurrentActivations() } });
    } catch (error) { next(error); }
});
app.get('/api/health', async (req, res) => {
    try { await store.runQuery('SELECT 1'); res.status(draining ? 503 : 200).json({ success: !draining }); }
    catch (_) { res.status(503).json({ success: false }); }
});
app.get('/api/admin/data', async (req, res, next) => {
    try { res.json({ ...(await store.getAdminData()), runtime: { active_foreground_jobs: activeJobs.size } }); }
    catch (error) { next(error); }
});

const handleActivationRequest = require('./activation-service')({ store, ensureStoreReady, activeJobs, runWorker, log, isDraining: () => draining });
app.post('/api/run-process', handleActivationRequest);
app.post('/api/admin/trigger-activation', handleActivationRequest);

app.post('/api/cdk/orbitcard/status', async (req, res, next) => {
    const cdk = String(req.body?.cdk || '').trim();
    if (!cdk) return res.status(400).json({ success: false, message: '请输入 CDK' });
    try {
        const task = await store.getOrbitcardTaskByCdk(cdk);
        if (!task) return res.status(404).json({ success: false, message: '该 CDK 尚无 Orbitcard 订单' });
        const result = await recovery.refreshTask(task);
        const latest = await store.getOrbitcardTaskByCdk(cdk);
        const same = latest?.job_key === task.job_key;
        res.json({ success: result.success, data: publicOrder(latest || task), message: result.error,
            retry_after_ms: Math.max(result.retryAfterMs || 0, result.waitMs || 0), stop_tracking: result.stopTracking,
            captcha: same ? result.applied ? result.captcha : activeChallenges.get(task.job_key) || null : null });
    } catch (error) { next(error); }
});
app.post('/api/admin/orders/:jobKey/refresh', async (req, res, next) => {
    try {
        const task = await store.getTaskStatus(req.params.jobKey);
        if (!task?.orbitcard_client_order_no) return res.status(404).json({ success: false, message: '未找到 Orbitcard 订单' });
        const result = await recovery.refreshTask(task);
        res.json({ success: result.success, message: result.error || '已查询原订单', data: publicOrder(await store.getTaskStatus(task.job_key)), retry_after_ms: result.retryAfterMs });
    } catch (error) { next(error); }
});

async function describeCdk(cdk) {
    const code = await store.verifyCdkDetails(cdk);
    if (!code || code.type !== '自助') return null;
    const task = await store.getRunningTaskByCdk(cdk);
    return { type: code.type, plan_type: code.plan_type, plan_label: PLAN_LABELS[code.plan_type] || code.plan_type,
        status: task ? task.orbitcard_state === 'retry_waiting' ? 'retry' : task.status === 'running' ? 'processing' : task.status : code.used_at ? 'used' : 'unused',
        provider: task ? task.orbitcard_client_order_no ? 'orbitcard' : 'history' : 'orbitcard',
        jobKey: task?.orbitcard_retry_root_job_key || task?.job_key, message: task?.message || (code.used_at ? 'CDK 已使用' : 'CDK 可兑换'),
        shipped: Boolean(code.shipped_at), usedAt: code.used_at };
}
app.post('/api/cdk/status', async (req, res, next) => {
    const cdk = typeof req.body?.cdk === 'string' ? req.body.cdk.trim() : '';
    if (!/^[a-zA-Z0-9_-]{4,32}$/.test(cdk)) return res.status(400).json({ success: false, message: '请输入有效 CDK' });
    try {
        await ensureStoreReady();
        const data = await store.getCdkRedemptionStatus(cdk);
        if (!data) return res.status(404).json({ success: false, message: 'CDK 不存在或已停用' });
        const messages = { redeemed: 'CDK 已核销', processing: 'CDK 已占用，尚未确认核销', unused: 'CDK 未使用' };
        res.json({ success: true, data, message: messages[data.status] });
    } catch (error) { next(error); }
});
app.post('/api/verify-cdk', async (req, res, next) => {
    try {
        const data = await describeCdk(String(req.body?.cdk || '').trim());
        if (!data) return res.status(404).json({ success: false, message: 'CDK 不存在' });
        res.json({ success: true, data });
    } catch (error) { next(error); }
});
app.get('/api/cdk/query', async (req, res, next) => {
    try {
        const data = await describeCdk(String(req.query.cdk || '').trim());
        if (!data) return res.status(404).json({ success: false, message: 'CDK 不存在' });
        res.json({ success: true, data });
    } catch (error) { next(error); }
});
app.use((req, res) => res.status(404).json({ success: false, message: '接口不存在' }));
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 503;
    res.status(status).json({ success: false, message: status === 413 ? '请求内容过大' : status === 400 ? 'JSON 格式无效' : '服务暂不可用，请稍后查询原订单' });
});

async function start() {
    if (Buffer.byteLength(process.env.ADMIN_TOKEN_SECRET || '') < 32) throw new Error('请配置至少 32 字节的随机 ADMIN_TOKEN_SECRET');
    runtimeLog.initialize();
    await ensureStoreReady();
    server = app.listen(port, () => log('', `Orbitcard 服务已启动，端口 ${port}`, 'server_ready'));
    wss = new WebSocket.Server({ server, maxPayload: 16384 });
    wss.on('connection', ws => {
        let jobKey = null;
        const unsubscribe = () => { if (jobKey) { clients.get(jobKey)?.delete(ws); if (!clients.get(jobKey)?.size) clients.delete(jobKey); } };
        ws.on('message', async raw => {
            try {
                const data = JSON.parse(raw);
                if (data.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', ts: data.ts }));
                if (data.type !== 'subscribe') return;
                if (!await require('./task-subscription').authorize(data, { store, verifyAdminToken: adminAuth.verifyAdminToken })) return ws.close(1008, 'Unauthorized');
                if (ws.readyState !== WebSocket.OPEN) return;
                unsubscribe(); jobKey = data.jobKey;
                if (!clients.has(jobKey)) clients.set(jobKey, new Set());
                clients.get(jobKey).add(ws);
                const task = await store.getTaskStatus(jobKey);
                if (task && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', ...publicOrder(task) }));
            } catch (_) { ws.close(1008, 'Invalid message'); }
        });
        ws.on('close', unsubscribe);
        ws.on('error', unsubscribe);
    });
    const tick = () => {
        recovery.recover().catch(() => log('', '后台查单暂不可用，下次继续', 'recovery_error'));
        manualService.recover().catch(() => log('', '管理员订单查单暂不可用，下次继续', 'manual_recovery_error'));
        if (Date.now() >= cardRecoveryAt) {
            cardRecoveryAt = Date.now() + 60000;
            store.getGptApiConfig().then(cfg => cardService.recover(cfg))
                .catch(() => log('', '原开卡申请恢复暂不可用，下次继续', 'card_recovery_error'));
        }
    };
    tick();
    recoveryTimer = setInterval(tick, 5000);
    recoveryTimer.unref();
}

async function shutdown() {
    if (draining) return;
    draining = true;
    clearInterval(recoveryTimer);
    if (wss) for (const ws of wss.clients) ws.close(1001, 'Restarting');
    server?.close();
    const timer = setTimeout(() => process.exit(0), 60000);
    timer.unref();
    // Existing tasks keep their persisted identity even if the host forces termination.
    while (activeJobs.size) await new Promise(resolve => setTimeout(resolve, 500));
    await store.close();
    process.exit(0);
}
if (require.main === module) {
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    start().catch(error => { console.error(error.message); process.exitCode = 1; store.close().catch(() => {}); });
}
module.exports = { app, start, publicOrder, activeJobs };
