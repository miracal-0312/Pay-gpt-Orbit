require('./config/load-env')();

const express = require('express');
const WebSocket = require('ws');
const proxyAddress = require('proxy-addr');
const { createRequestGuard, limit } = require('./http/request-guard');
const taskSockets = require('./realtime/task-sockets');
const store = require('./db/mysql-store');
const runtimeLog = require('./logging/runtime-log');
const emailNotifications = require('./integrations/email-notifications')({ store,
    mailer: require('./integrations/smtp-mailer').createMailer(), provider: require('./orbitcard/orbitcard-client'),
    audit: entry => runtimeLog.push(entry) });
const adminAuth = require('./http/admin-auth');
const { PLAN_LABELS, PROVIDER_TO_PLAN } = require('./config/plan-registry');
const { projectBusinessOrder } = require('./payments/order-business-status');
const { buildCustomerGuidance } = require('./payments/customer-error-guide');
const { notifyTelegramEvent } = require('./integrations/telegram-notify');
const app = express();
const activeJobs = new Set();
const { createPaymentWaitingQueue, queueFeedback } = require('./payments/payment-waiting-queue');
const waitingQueue = createPaymentWaitingQueue({ store, activeJobs });
const clients = new Map();
const activeChallenges = new Map();
let ready = null, draining = false, recoveryTimer = null, emailTimer = null, stopLogCleanup = null, server, wss;
const port = Number(process.env.PORT || 3000);
function ensureStoreReady() {
    if (!ready) ready = store.ensureReady().catch(error => { ready = null; throw error; });
    return ready;
}
function log(jobKey, text, event = 'task') { runtimeLog.push({ jobKey, source: 'orbitcard', event, text }); }
function broadcast(jobKey, data) {
    for (const ws of clients.get(jobKey) || []) taskSockets.send(ws, { jobKey, ...data });
}
function publicOrder(task) {
    const { business_status, business_result, business_closed_at } = projectBusinessOrder(task);
    const planType = PROVIDER_TO_PLAN[task.orbitcard_plan_type] || task.orbitcard_plan_type || null;
    const manualResult = ['success', 'failed'].includes(task.manual_result) ? task.manual_result : null;
    const manuallyRedeemed = Boolean(task.manual_redeemed_at);
    const status = manualResult || (manuallyRedeemed ? 'success' : task.orbitcard_state === 'retry_waiting' ? 'retry' : task.status);
    const message = manualResult === 'success' ? '订单已由人工售后完成交付' : manualResult === 'failed' ? '订单已由人工确认失败，请联系客服处理'
        : manuallyRedeemed ? '卡密已由人工售后核销' : task.message;
    const cdkState = manualResult === 'success' || manuallyRedeemed ? 'redeemed'
        : manualResult === 'failed' ? task.manual_local_released_at ? 'available' : 'reserved'
            : task.orbitcard_state === 'success' ? 'redeemed' : ['failed','rejected'].includes(task.orbitcard_state) ? 'available' : 'reserved';
    const safeOrder = store.safeOrder(task.gpt_api_raw);
    const guidance = buildCustomerGuidance({ ...task, status }, safeOrder);
    return { provider: task.orbitcard_client_order_no ? 'orbitcard' : 'history',
        jobKey: task.orbitcard_retry_root_job_key || task.job_key,
        attemptJobKey: task.job_key, attempt: Number(task.orbitcard_retry_attempt_no || 1),
        status, message, business_status, business_result, business_closed_at,
        queued: manualResult ? false : waitingQueue.has(task.job_key), ...queueFeedback(manualResult || manuallyRedeemed ? '' : task.message),
        progress: manualResult === 'success' || !manualResult && manuallyRedeemed ? 100 : manualResult === 'failed' ? 0 : Number(task.progress || 0),
        target_email: task.orbitcard_email || null,
        plan_type: planType, plan_label: PLAN_LABELS[planType] || planType,
        order_id: task.gpt_api_order_id || null, client_order_no: task.orbitcard_client_order_no || null,
        cdk_state: cdkState,
        guidance,
        order: safeOrder };
}
async function notify(task) {
    if (!['success', 'failed', 'manual'].includes(task.status)) return;
    await notifyTelegramEvent(store, task.status === 'success' ? 'success' : task.status === 'manual' ? 'pending' : 'failure', {
        email: task.orbitcard_email || '', cdk: task.cdk_code, jobKey: task.job_key, message: task.message
    });
}
const cardService = require('./orbitcard/orbitcard-card-service')({ store, audit: entry => runtimeLog.push(entry) });
const manualService = require('./payments/orbitcard-manual-service')({ store, activeJobs, cardService, waitingQueue, audit: entry => runtimeLog.push(entry) });
const recovery = require('./payments/order-recovery')({ store, query: require('./orbitcard/orbitcard-query'), activeJobs,
    audit: entry => runtimeLog.push(entry), notify,
    checkBalance: task => store.getGptApiConfig().then(cfg => cardService.canResumeBalance(cfg,task)),
    confirmFunding: (task, guard) => store.getGptApiConfig().then(cfg => cardService.confirmFunding(
        { ...cfg, auditJobKey: task.job_key, executionGuard: guard }, task.job_key, task.orbitcard_plan_type)) });
let cardRecoveryAt = 0;

const { run: runWorker } = require('./payments/payment-service')({ store, cardService, worker: require('./payments/orbitcard-worker'),
    activeJobs, activeChallenges, waitingQueue, audit: entry => runtimeLog.push(entry), broadcast, log, notify });

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
});
// Only named proxy addresses/subnets may supply the client IP; never trust arbitrary forwarded headers.
if (process.env.TRUST_PROXY?.trim()) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean));
app.use(createRequestGuard());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));
require('./http/admin-http')(app, { store, ensureStoreReady, getTotalActiveJobs: () => waitingQueue.activeCount(), cardService, manualService, emailNotifications });

app.get('/api/public/runtime', async (req, res, next) => {
    try {
        await ensureStoreReady();
        res.json({ success: true, provider: 'orbitcard', runtime: { active_foreground_jobs: waitingQueue.activeCount(),
            waiting_jobs: waitingQueue.count, max_waiting_jobs: 1,
            max_foreground_jobs: await store.getMaxConcurrentActivations() } });
    } catch (error) { next(error); }
});
app.get('/api/health', async (req, res) => {
    try { await store.runQuery('SELECT 1'); res.status(draining ? 503 : 200).json({ success: !draining }); }
    catch (_) { res.status(503).json({ success: false }); }
});
app.get('/api/admin/data', async (req, res, next) => {
    try { res.json({ ...(await store.getAdminData()), runtime: { active_foreground_jobs: waitingQueue.activeCount(), waiting_jobs: waitingQueue.count, max_waiting_jobs: 1 } }); }
    catch (error) { next(error); }
});

const handleActivationRequest = require('./payments/activation-service')({ store, ensureStoreReady, activeJobs, runWorker, log, broadcast, waitingQueue, isDraining: () => draining });
app.post('/api/run-process', handleActivationRequest);

app.post('/api/cdk/orbitcard/status', async (req, res, next) => {
    const cdk = String(req.body?.cdk || '').trim();
    if (!cdk) return res.status(400).json({ success: false, message: '请输入 CDK' });
    try {
        const task = await store.getOrbitcardTaskByCdk(cdk);
        if (!task) return res.status(404).json({ success: false, message: '该 CDK 尚无 Orbitcard 订单' });
        const result = await recovery.refreshTask(task);
        const latest = await store.getOrbitcardTaskByCdk(cdk);
        const same = latest?.job_key === task.job_key;
        const data = publicOrder(latest || task), closed = data.business_status === 'closed';
        res.json({ success: result.success, data, message: result.error,
            retry_after_ms: Math.max(result.retryAfterMs || 0, result.waitMs || 0), stop_tracking: closed || result.stopTracking,
            captcha: !closed && same ? result.applied ? result.captcha : activeChallenges.get(task.job_key) || null : null });
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
    let task = await store.getRunningTaskByCdk(cdk);
    if (code.manual_redeemed_at) {
        const latest = await store.getOrbitcardTaskByCdk(cdk);
        if (latest && String(latest.cdk_code || '').toLowerCase() === String(cdk).toLowerCase()
            && ['success', 'failed'].includes(latest.manual_result)) task = latest;
    }
    const manualResult = ['success', 'failed'].includes(task?.manual_result) ? task.manual_result : null;
    const { business_status, business_result, business_closed_at } = projectBusinessOrder(task || {
        status: code.manual_redeemed_at ? 'success' : code.used_at ? 'used' : 'unused'
    });
    const message = manualResult === 'success' ? '订单已由人工售后完成交付' : manualResult === 'failed' ? '订单已由人工确认失败，请联系客服处理'
        : code.manual_redeemed_at ? '卡密已由人工售后核销' : task?.message || (code.used_at ? 'CDK 已使用' : 'CDK 可兑换');
    return { type: code.type, plan_type: code.plan_type, plan_label: PLAN_LABELS[code.plan_type] || code.plan_type,
        status: manualResult || (code.manual_redeemed_at ? 'success' : task ? task.orbitcard_state === 'retry_waiting' ? 'retry' : task.status === 'running' ? 'processing' : task.status : code.used_at ? 'used' : 'unused'),
        business_status, business_result, business_closed_at,
        cdk_state: manualResult === 'success' || code.manual_redeemed_at || !manualResult && task?.orbitcard_state === 'success' ? 'redeemed'
            : task?.manual_local_released_at && !code.used_at ? 'available' : code.used_at || task ? 'reserved' : 'available',
        provider: task ? task.orbitcard_client_order_no ? 'orbitcard' : 'history' : 'orbitcard',
        jobKey: task?.orbitcard_retry_root_job_key || task?.job_key, message,
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
    require('./integrations/cdk-redemption-webhook').readConfig();
    runtimeLog.initialize();
    await ensureStoreReady();
    server = app.listen(port, process.env.HOST?.trim() || undefined, () => log('', `Orbitcard 服务已启动，端口 ${port}`, 'server_ready'));
    server.maxConnections = limit(process.env.HTTP_MAX_CONNECTIONS, 500, 10000);
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.setTimeout(120000, socket => socket.destroy());
    wss = new WebSocket.Server({ server, maxPayload: 16384 });
    taskSockets.attachTaskSockets(wss, { store, verifyAdminToken: adminAuth.verifyAdminToken, publicOrder, clients,
        getClientIp: req => proxyAddress(req, app.get('trust proxy fn') || (() => false)) });
    const tick = () => {
        store.deliverRedemptionNotifications().catch(() => log('', '商城核销通知暂不可用，将自动重试', 'redemption_notification_error'));
        recovery.recover().catch(() => log('', '后台查单暂不可用，下次继续', 'recovery_error'));
        manualService.recover().catch(() => log('', '管理员订单查单暂不可用，下次继续', 'manual_recovery_error'));
        if (Date.now() >= cardRecoveryAt) {
            cardRecoveryAt = Date.now() + 60000;
            store.getGptApiConfig().then(async cfg => {
                await cardService.recover(cfg);
                if (cfg.enabled) await cardService.synchronize(cfg);
            })
                .catch(() => log('', '原开卡申请恢复暂不可用，下次继续', 'card_recovery_error'));
        }
    };
    tick();
    recoveryTimer = setInterval(tick, 5000);
    recoveryTimer.unref();
    const emailTick = () => emailNotifications.tick().catch(() => log('', '邮件通知暂不可用，下次继续处理', 'email_notification_error'));
    emailTick();
    emailTimer = setInterval(emailTick, 30000);
    emailTimer.unref();
    stopLogCleanup = require('./logging/log-retention').scheduleDailyCleanup(runtimeLog.cleanup, {
        onError: error => console.error('日志保留清理失败：', error.message)
    });
}

async function shutdown() {
    if (draining) return;
    draining = true;
    waitingQueue.close();
    clearInterval(recoveryTimer);
    clearInterval(emailTimer);
    stopLogCleanup?.();
    if (wss) for (const ws of wss.clients) ws.close(1001, 'Restarting');
    server?.close();
    const timer = setTimeout(() => process.exit(0), 60000);
    timer.unref();
    // Existing tasks keep their persisted identity even if the host forces termination.
    while (activeJobs.size) await new Promise(resolve => setTimeout(resolve, 500));
    await emailNotifications.stop();
    await store.close();
    process.exit(0);
}
function run() {
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return start().catch(error => { console.error(error.message); process.exitCode = 1; store.close().catch(() => {}); });
}
if (require.main === module) run();
module.exports = { app, start, run, publicOrder, activeJobs };
