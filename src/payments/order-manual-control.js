'use strict';

const crypto = require('node:crypto');
const { cdkLockKey, manualLockKeys } = require('./payment-execution-lock');
const { cardScope, planFor } = require('../orbitcard/orbitcard-card-policy');
const { PROVIDER_PLANS } = require('../config/plan-registry');
const { confirmedSuccess, confirmedFailure, confirmedRejection } = require('./payment-retry-policy');
const { sanitize } = require('../logging/log-safety');
const { projectBusinessOrder } = require('./order-business-status');

const FINAL_STATES = new Set(['success', 'failed', 'rejected', 'support_locked', 'closed', 'cancelled']);
const PAUSE_STATES = new Set(['preparing', 'prepared', 'funding_waiting', 'funding_review', 'funding_pending',
    'card_pending', 'submitting', 'pending', 'manual', 'retry_waiting', 'balance_blocked']);
const TASK_STATUSES = new Set(['pending', 'queued', 'running', 'manual', 'retry', 'failed', 'success', 'closed', 'cancelled']);
const ACTIONS = [['note', '添加处理备注'], ['pause', '暂停自动处理'], ['success', '人工交付完成'], ['failed', '人工确认失败']];
const MESSAGES = {
    stale: '订单已发生变化，请刷新后重新处理', busy: '订单正在执行支付、排队或查单，请稍后再修改状态；仍可添加备注',
    owner: '订单归属或当前占用不一致，请先核对原订单；仍可添加备注',
    money: '原开卡或补款尚未完成核对，或原记录归属不一致，资金占用仍需保留',
    cardOwner: '原支付卡归属或占用证据不完整，不能自动释放原资金占用',
    success: '已确认成功的订单不能改为失败', unknown: '历史订单状态无法安全自动结算，原资金占用仍需核对'
};

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function positiveId(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0; }
function invalidCardId(value) { return value != null && value !== '' && value !== 0 && value !== '0' && !positiveId(value); }
function safeText(value, length) { return String(sanitize(String(value || ''))).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, length); }
function identity(input) {
    if (!input || !['task', 'admin'].includes(input.kind) || typeof input.id !== 'string'
        || !input.id.trim() || input.id.length > 128 || /[\u0000-\u001f]/.test(input.id)) fail(400, '无效的订单标识');
    return { kind: input.kind, id: input.id };
}
function fields(kind, row) {
    let scope = kind === 'admin' ? row.scope : null, plan = null;
    const cardValue = kind === 'task' ? row.orbitcard_card_id : row.card_id;
    try { if (kind === 'task') scope = cardScope(row.orbitcard_base_url); } catch (_) { /* legacy orders can always be annotated */ }
    try { plan = planFor(kind === 'task' ? row.orbitcard_plan_type : row.plan_type); } catch (_) { /* checked before touching funds */ }
    return {
        status: String(kind === 'task' ? row.status || '' : row.state || ''),
        state: String(kind === 'task' ? row.orbitcard_state || '' : row.state || ''),
        job: kind === 'task' ? row.job_key : row.client_order_no,
        client: kind === 'task' ? row.orbitcard_client_order_no : row.client_order_no,
        cdk: row.cdk_code || null, scope, plan,
        credential: kind === 'task' ? row.orbitcard_api_key_hash : row.api_key_hash,
        cardId: positiveId(cardValue),
        invalidCard: invalidCardId(cardValue),
        issueKey: kind === 'task' ? row.orbitcard_issue_key : row.issue_key
    };
}

module.exports = function createOrderManualControl(store) {
    async function readOrder(kind, id, options, lock = false) {
        const sql = kind === 'task' ? 'SELECT * FROM task_logs WHERE job_key = ?' : 'SELECT * FROM orbitcard_admin_orders WHERE request_id = ?';
        const rows = await store.runQuery(sql + (lock ? ' FOR UPDATE' : ' LIMIT 1'), [id], options);
        if (!rows[0] || (kind === 'task' ? rows[0].job_key : rows[0].request_id) !== id) fail(404, '订单不存在');
        return rows[0];
    }
    async function history(kind, id, options) {
        return store.runQuery('SELECT * FROM order_manual_actions WHERE order_kind = ? AND order_id = ? ORDER BY id DESC LIMIT 100', [kind, id], options);
    }
    function revision(row, actions, ctx) {
        // Hash the complete original row and append-only audit sequence, not the
        // second-resolution updated_at alone. Never return payment credentials.
        const evidence = { code: ctx.code || null, latestTask: ctx.latestTask || null, adminPeers: ctx.adminPeers,
            fundings: ctx.fundings, issues: ctx.issues, uses: ctx.uses, card: ctx.card || null };
        return crypto.createHash('sha256').update(JSON.stringify([row, actions[0]?.id || 0, evidence])).digest('hex');
    }
    async function context(kind, row, options, lock = false, codeAlreadyLocked) {
        const f = fields(kind, row), suffix = lock ? ' FOR UPDATE' : '';
        const ctx = { ...f, row, code: codeAlreadyLocked, latestTask: null, adminPeers: [], fundings: [], issues: [], uses: [], card: null };
        if (f.cdk) {
            if (codeAlreadyLocked === undefined) [ctx.code] = await store.runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ?' + suffix, [f.cdk], options);
            [ctx.latestTask] = await store.runQuery('SELECT * FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1' + suffix, [f.cdk], options);
            ctx.adminPeers = await store.runQuery('SELECT * FROM orbitcard_admin_orders WHERE cdk_code = ? ORDER BY created_at DESC, request_id DESC' + suffix, [f.cdk], options);
        }
        if (f.job) {
            ctx.fundings = await store.runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key = ?' + suffix, [f.job], options);
            ctx.issues = await store.runQuery('SELECT * FROM orbitcard_card_issues WHERE job_key = ? OR issue_key = ? OR replacement_for_job_key = ?' + suffix, [f.job, f.issueKey || null, f.job], options);
        } else if (f.issueKey) {
            ctx.issues = await store.runQuery('SELECT * FROM orbitcard_card_issues WHERE issue_key = ?' + suffix, [f.issueKey], options);
        }
        // Keep the established task -> card -> card-use lock order.
        if (f.scope && f.cardId) [ctx.card] = await store.runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ?' + suffix, [f.scope, f.cardId], options);
        if (kind === 'task') ctx.uses = await store.runQuery('SELECT * FROM orbitcard_card_uses WHERE job_key = ?' + suffix, [row.job_key], options);
        return ctx;
    }
    function predatesOrder(peer, row) {
        const timestamp = value => value ? new Date(value).getTime() : NaN;
        const peerCreated = timestamp(peer.created_at), rowCreated = timestamp(row.created_at);
        // Creation timestamps have second precision. The immutable first local
        // release time can also prove which released flow came first.
        if (Number.isFinite(peerCreated) && Number.isFinite(rowCreated) && peerCreated !== rowCreated) return peerCreated < rowCreated;
        const peerReleased = timestamp(peer.manual_local_released_at), rowReleased = timestamp(row.manual_local_released_at);
        return Number.isFinite(peerReleased) && Number.isFinite(rowReleased) && peerReleased < rowReleased;
    }
    function ownershipProblem(kind, id, ctx) {
        if (ctx.cdk && (!ctx.code || !/^[a-zA-Z0-9_-]{4,32}$/.test(ctx.cdk))) return MESSAGES.owner;
        if (kind === 'task' && ctx.cdk && ctx.latestTask?.job_key !== id) return '历史订单已有后续任务，只能登记备注，不能修改当前卡密的处理结果';
        if (kind === 'admin' && ctx.cdk && (ctx.adminPeers[0]?.request_id !== id || ctx.latestTask
            && (!ctx.latestTask.manual_local_released_at || ctx.row.manual_local_released_at && !predatesOrder(ctx.latestTask, ctx.row)))) return MESSAGES.owner;
        const peers = ctx.adminPeers.filter(peer => !(kind === 'admin' && peer.request_id === id));
        if (ctx.row.manual_local_released_at && peers.some(peer => !predatesOrder(peer, ctx.row))) return MESSAGES.owner;
        if (peers.some(peer => !peer.manual_local_released_at
            && !['failed', 'rejected', 'closed', 'cancelled'].includes(peer.state))) return '该卡密还关联其他管理员订单，请先核对占用；仍可添加备注';
        return null;
    }
    function isReplacement(issue, ctx) { return issue.job_key == null && issue.replacement_for_job_key === ctx.job; }
    function moneyProblem(kind, ctx, { localRelease = false } = {}) {
        const originals = ctx.issues.filter(issue => !isReplacement(issue, ctx)), replacements = ctx.issues.filter(issue => isReplacement(issue, ctx));
        if (ctx.invalidCard || ctx.fundings.length > 1 || originals.length > 1 || replacements.length > 1 || ctx.uses.length > 1
            || (!localRelease && ctx.issueKey && !originals.some(issue => issue.issue_key === ctx.issueKey))
            || (!localRelease && ['funding_waiting', 'funding_review', 'funding_pending'].includes(ctx.state) && ctx.fundings.length !== 1)
            || (!localRelease && ctx.state === 'card_pending' && !ctx.issues.length)) return MESSAGES.money;
        for (const intent of [...ctx.fundings, ...ctx.issues]) {
            if ((!localRelease && !['ready', 'failed'].includes(intent.state)) || !ctx.job || (intent.job_key !== ctx.job && !isReplacement(intent, ctx))
                || !/^[a-f0-9]{64}$/i.test(ctx.scope || '') || intent.scope !== ctx.scope || !ctx.plan || intent.plan_type !== ctx.plan
                || !/^[a-f0-9]{64}$/i.test(ctx.credential || '') || intent.credential_hash !== ctx.credential) return MESSAGES.money;
        }
        const [issue] = originals, [funding] = ctx.fundings, [use] = ctx.uses;
        for (const replacement of replacements) {
            if (!ctx.cardId || positiveId(replacement.replacement_for_card_id) !== ctx.cardId
                || invalidCardId(replacement.card_id) || (replacement.state === 'ready' && !positiveId(replacement.card_id))) return MESSAGES.money;
        }
        if (funding && (!ctx.cardId || positiveId(funding.card_id) !== ctx.cardId)) return MESSAGES.money;
        if (issue && (invalidCardId(issue.card_id) || (ctx.issueKey && issue.issue_key !== ctx.issueKey)
            || (issue.state === 'ready' && !positiveId(issue.card_id))
            || (positiveId(issue.card_id) !== ctx.cardId && (positiveId(issue.card_id) || ctx.cardId)))) return MESSAGES.money;
        if (use && (!ctx.cardId || use.job_key !== ctx.job || use.scope !== ctx.scope || positiveId(use.card_id) !== ctx.cardId
            || use.plan_type !== ctx.plan || !['reserved', 'released', 'consumed'].includes(use.state))) return MESSAGES.cardOwner;
        if (ctx.cardId && (!/^[a-f0-9]{64}$/i.test(ctx.scope || '') || (!localRelease && !/^[a-f0-9]{64}$/i.test(ctx.credential || ''))
            || !ctx.plan || !ctx.card || ctx.card.scope !== ctx.scope || positiveId(ctx.card.card_id) !== ctx.cardId)) return MESSAGES.cardOwner;
        if (use?.state === 'reserved' && ctx.card?.active_job !== ctx.job) return MESSAGES.cardOwner;
        if (kind === 'task' && ctx.cardId && !use) return MESSAGES.cardOwner;
        const adminPreviouslySettled = kind === 'admin' && (['success', 'failed', 'rejected', 'closed', 'cancelled'].includes(ctx.state)
            || Boolean(ctx.row.manual_local_released_at) || subscriptionEvidence(kind, ctx).resolved);
        if (kind === 'admin' && ctx.cardId && ctx.card?.active_job !== ctx.job && !adminPreviouslySettled) return MESSAGES.cardOwner;
        // A settled old use can point at a card already reserved by a new job.
        // It is safe to record a business result, but never to settle that use again.
        if (ctx.card?.active_job && ctx.card.active_job !== ctx.job
            && !(kind === 'task' ? use && ['released', 'consumed'].includes(use.state) : adminPreviouslySettled)) return MESSAGES.cardOwner;
        return null;
    }
    function subscriptionEvidence(kind, ctx) {
        const expected = { clientOrderNo: ctx.client, cardId: ctx.cardId, planType: PROVIDER_PLANS[ctx.plan],
            orderId: kind === 'task' ? ctx.row.gpt_api_order_id : ctx.row.task_no,
            email: kind === 'task' ? ctx.row.orbitcard_email : ctx.row.target_email };
        let snapshot = {}, malformed = false;
        const raw = kind === 'task' ? ctx.row.gpt_api_raw : ctx.row.snapshot;
        try {
            snapshot = raw ? JSON.parse(raw) : {};
            malformed = !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot);
        } catch (_) { malformed = true; }
        const resolved = confirmedSuccess(snapshot, expected) || confirmedFailure(snapshot, expected) || confirmedRejection(snapshot, expected);
        const submitted = ['submitting', 'pending', 'manual'].includes(ctx.state) || Boolean(expected.orderId)
            || malformed || Boolean(snapshot && (snapshot.task_no || snapshot.orderId || snapshot.order_no || snapshot.client_order_no || snapshot.submission_outcome
                || snapshot.upstream_status || snapshot.subscription_succeeded != null || snapshot.task_status || snapshot.stage
                || snapshot.request_error || snapshot.query_source || snapshot.result_source || snapshot.status))
            || ctx.audit?.some(item => ['submitting', 'pending', 'manual'].includes(item.previous_state));
        return { submitted, resolved };
    }
    function alreadySuccessful(kind, ctx) {
        if (ctx.row.manual_result === 'success' || ctx.status === 'success' || ctx.state === 'success' || ctx.uses.some(use => use.state === 'consumed')) return true;
        try {
            return confirmedSuccess(JSON.parse(kind === 'task' ? ctx.row.gpt_api_raw || '{}' : ctx.row.snapshot || '{}'), {
                clientOrderNo: ctx.client, cardId: ctx.cardId, planType: PROVIDER_PLANS[ctx.plan],
                orderId: kind === 'task' ? ctx.row.gpt_api_order_id : ctx.row.task_no,
                email: kind === 'task' ? ctx.row.orbitcard_email : ctx.row.target_email
            });
        } catch (_) { return false; }
    }
    function knownState(kind, ctx) {
        return kind === 'admin' ? PAUSE_STATES.has(ctx.state) || FINAL_STATES.has(ctx.state)
            : TASK_STATUSES.has(ctx.status) && (!ctx.state || PAUSE_STATES.has(ctx.state) || FINAL_STATES.has(ctx.state));
    }
    function settlementProblem(kind, id, ctx) {
        const owner = ownershipProblem(kind, id, ctx);
        if (owner) return owner;
        if (!knownState(kind, ctx)) return MESSAGES.unknown;
        const money = moneyProblem(kind, ctx);
        if (money) return money;
        const subscription = subscriptionEvidence(kind, ctx);
        if (subscription.submitted && !subscription.resolved) return '原订阅的受理或扣款结果尚未确认，仍需核对原平台订单';
        return null;
    }
    function releaseProblem(kind, id, ctx) {
        const owner = ownershipProblem(kind, id, ctx);
        if (owner) return owner;
        return moneyProblem(kind, ctx, { localRelease: true });
    }
    function problem(kind, id, action, ctx) {
        if (action === 'note') return null;
        const owner = ownershipProblem(kind, id, ctx);
        if (owner) return owner;
        if (action === 'failed' && alreadySuccessful(kind, ctx)) return MESSAGES.success;
        if (action === 'pause') {
            if (['success', 'failed'].includes(ctx.row.manual_result)) return '订单已人工结案，不能重新暂停或恢复处理；可添加备注或更正人工结果';
            if (!knownState(kind, ctx)) return MESSAGES.unknown;
            if (alreadySuccessful(kind, ctx) || FINAL_STATES.has(ctx.state) || ['success', 'failed', 'closed', 'cancelled'].includes(ctx.status)) return '订单已结束，可添加处理备注或确认人工处理结果';
        }
        return null;
    }
    function result(kind, id, row, actions, ctx) {
        const f = fields(kind, row);
        ctx.audit = actions;
        const settlementReason = settlementProblem(kind, id, ctx), releaseReason = releaseProblem(kind, id, ctx);
        return { kind, id, status: f.status, state: f.state, revision: revision(row, actions, ctx),
            ...projectBusinessOrder(row),
            manual_result: row.manual_result || null, manual_result_reason: safeText(row.manual_result_reason, 255),
            manual_result_by: safeText(row.manual_result_by, 128), manual_result_at: row.manual_result_at || null,
            manual_local_released_at: row.manual_local_released_at || null,
            manual_local_released_by: safeText(row.manual_local_released_by, 128),
            manual_local_release_reason: safeText(row.manual_local_release_reason, 255),
            settlement: { allowed: !settlementReason, reason: settlementReason || '' },
            release: { allowed: !releaseReason, reason: releaseReason || '仅解除本系统占用，不代表卡台退款；原资金继续核对', released: Boolean(row.manual_local_released_at) },
            actions: ACTIONS.map(([value, label]) => {
                const denied = problem(kind, id, value, ctx);
                const retained = !denied && ['success', 'failed'].includes(value) && settlementReason;
                return { value, label, enabled: !denied, reason: denied || (retained
                    ? `可记录人工结果；${row.manual_local_released_at ? '原资金继续核对' : '默认保留原资金占用'}。${settlementReason}` : '') };
            }), history: actions.map(item => ({ action: item.action, reason: safeText(item.reason, 255),
                admin_email: safeText(item.admin_email, 128), created_at: item.created_at,
                previous_status: item.previous_status, next_status: item.next_status, release_local_hold: Boolean(Number(item.release_local_hold)) })) };
    }
    async function getOrderManualControl(input) {
        const { kind, id } = identity(input);
        const row = await readOrder(kind, id);
        const actions = await history(kind, id);
        return result(kind, id, row, actions, await context(kind, row));
    }
    function pauseState(ctx) {
        if (['submitting', 'pending', 'manual'].includes(ctx.state)) return 'manual';
        if (ctx.state === 'funding_waiting') return 'funding_review';
        if (['funding_review', 'funding_pending', 'card_pending'].includes(ctx.state)) return ctx.state;
        if (ctx.fundings.some(item => !['ready', 'failed'].includes(item.state))) return 'funding_pending';
        if (ctx.issues.some(item => !['ready', 'failed'].includes(item.state)) || (ctx.issueKey && !ctx.issues.length)) return 'card_pending';
        return 'support_locked';
    }
    function reconciliationState(kind, ctx) {
        if (ctx.state === 'funding_waiting') return 'funding_review';
        if (['funding_review', 'funding_pending', 'card_pending'].includes(ctx.state)) return ctx.state;
        if (['submitting', 'pending', 'manual'].includes(ctx.state)) return 'manual';
        if (ctx.fundings.length) return 'funding_pending';
        if (ctx.issues.length || ctx.issueKey) return 'card_pending';
        if (subscriptionEvidence(kind, ctx).submitted) return 'manual';
        return 'support_locked';
    }
    async function markLocalRelease(kind, id, ctx, reason, adminEmail, options) {
        // Only ownership-verified original records can be exempted from local
        // holds. Their remote state, request body and idempotency key stay intact.
        for (const [table, key, intents] of [['orbitcard_card_fundings', 'funding_key', ctx.fundings], ['orbitcard_card_issues', 'issue_key', ctx.issues]]) {
            for (const intent of intents) {
                if (typeof intent[key] !== 'string' || !intent[key]) fail(409, MESSAGES.money);
                if (intent.local_released_at) continue;
                const replacement = table === 'orbitcard_card_issues' && isReplacement(intent, ctx);
                const ownerClause = replacement ? 'job_key IS NULL AND replacement_for_job_key = ? AND replacement_for_card_id = ?' : 'job_key = ?';
                const ownerArgs = replacement ? [ctx.job, ctx.cardId] : [ctx.job];
                const changed = await store.runExecute(`UPDATE ${table} SET local_released_by = ?, local_release_reason = ?, local_released_at = CURRENT_TIMESTAMP(3)
                    WHERE ${key} = ? AND ${ownerClause} AND scope = ? AND credential_hash = ? AND plan_type = ? AND local_released_at IS NULL`,
                [adminEmail, reason, intent[key], ...ownerArgs, ctx.scope, ctx.credential, ctx.plan], options);
                if (changed.affectedRows !== 1) fail(409, MESSAGES.stale);
            }
        }
        if (!ctx.row.manual_local_released_at) {
            const table = kind === 'task' ? 'task_logs' : 'orbitcard_admin_orders', key = kind === 'task' ? 'job_key' : 'request_id';
            const changed = await store.runExecute(`UPDATE ${table} SET manual_local_released_by = ?, manual_local_release_reason = ?, manual_local_released_at = CURRENT_TIMESTAMP(3)
                WHERE ${key} = ? AND manual_local_released_at IS NULL`, [adminEmail, reason, id], options);
            if (changed.affectedRows !== 1) fail(409, MESSAGES.stale);
        }
    }
    async function assertOwned(guard) {
        try { await guard.assertOwned(); } catch (_) { fail(409, MESSAGES.busy); }
    }
    async function applyOrderManualControl(input) {
        const { kind, id } = identity(input);
        const { action, expectedRevision } = input;
        const releaseLocalHold = input.releaseLocalHold ?? input.release_local_hold ?? false;
        if ((input.releaseLocalHold !== undefined && typeof input.releaseLocalHold !== 'boolean')
            || (input.release_local_hold !== undefined && typeof input.release_local_hold !== 'boolean')
            || (input.releaseLocalHold !== undefined && input.release_local_hold !== undefined && input.releaseLocalHold !== input.release_local_hold)) fail(400, '解除本地占用选项必须为布尔值');
        if (releaseLocalHold && !['success', 'failed'].includes(action)) fail(400, '解除本地占用必须与人工确认成功或失败一同提交');
        if (!ACTIONS.some(([value]) => value === action)) fail(400, '请选择有效的人工处理措施');
        if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) fail(400, '缺少有效的订单版本，请刷新后重试');
        if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 255) fail(400, '请填写 1–255 字的处理原因');
        const reason = safeText(input.reason.trim(), 255), adminEmail = safeText(input.adminEmail, 128);
        if (!reason.trim()) fail(400, '请填写有效的处理原因');
        if (!adminEmail.trim()) fail(400, '缺少管理员身份，请重新登录');
        const initial = await readOrder(kind, id), before = fields(kind, initial);
        let guard = null;
        if (action !== 'note') {
            if (before.cdk && !/^[a-zA-Z0-9_-]{4,32}$/.test(before.cdk)) fail(409, MESSAGES.owner);
            const ownerKeys = kind === 'admin' ? manualLockKeys(id, before.cdk) : before.cdk ? cdkLockKey(before.cdk) : `task:${id.toLowerCase()}`;
            const keys = initial.manual_local_released_at && before.job
                ? [...(Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys]), `reconcile:${before.job.toLowerCase()}`] : ownerKeys;
            guard = await store.acquirePaymentLock(keys);
            if (!guard) fail(409, MESSAGES.busy);
        }
        try {
            if (guard) await assertOwned(guard);
            return await store.withTransaction(async connection => {
                const options = { connection };
                let code;
                // Follow the execution lock -> CDK -> task/order -> card -> use
                // ordering. A note only locks its own row and appends an audit.
                if (action !== 'note' && before.cdk) [code] = await store.runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [before.cdk], options);
                const row = await readOrder(kind, id, options, true), actions = await history(kind, id, options);
                const f = fields(kind, row);
                if (action !== 'note' && (f.cdk !== before.cdk || f.job !== before.job)) fail(409, MESSAGES.stale);
                const ctx = await context(kind, row, options, action !== 'note', code);
                ctx.audit = actions;
                if (revision(row, actions, ctx) !== expectedRevision) fail(409, MESSAGES.stale);
                if (action !== 'note') {
                    const denied = problem(kind, id, action, ctx);
                    if (denied) fail(409, denied);
                    if (releaseLocalHold) {
                        const releaseDenied = releaseProblem(kind, id, ctx);
                        if (releaseDenied) fail(409, releaseDenied);
                    }
                    await assertOwned(guard);
                }
                let nextStatus = f.status, nextState = f.state;
                if (action !== 'note') {
                    const canSettle = action !== 'pause' && !settlementProblem(kind, id, ctx);
                    nextState = action === 'pause' ? pauseState(ctx) : !canSettle ? reconciliationState(kind, ctx)
                        : action === 'success' ? 'success' : kind === 'admin' ? 'failed' : 'support_locked';
                    nextStatus = kind === 'admin' ? nextState : action === 'pause' || !canSettle ? 'manual' : action;
                    const resultText = action === 'pause' ? '人工暂停自动处理' : action === 'success' ? '人工交付完成，订单已关闭（非平台成功凭证）' : '人工确认失败，订单已关闭';
                    const retainedText = action !== 'pause' && !canSettle ? (releaseLocalHold || row.manual_local_released_at
                        ? '；本地占用已解除，原资金继续核对（不代表平台退款）' : '；原资金尚待核对，保留占用') : '';
                    const message = `${resultText}${retainedText}：${reason}`.slice(0, 255);
                    if (kind === 'task') await store.runExecute(`UPDATE task_logs SET status = ?, progress = ?, message = ?, orbitcard_state = ?, session_payload = NULL WHERE job_key = ?`,
                        [nextStatus, canSettle && action === 'success' ? 100 : canSettle && action === 'failed' ? 0 : Number(row.progress) || 0, message, nextState, id], options);
                    else await store.runExecute('UPDATE orbitcard_admin_orders SET state = ?, message = ? WHERE request_id = ?', [nextState, message, id], options);
                    if (action !== 'pause') {
                        const table = kind === 'task' ? 'task_logs' : 'orbitcard_admin_orders', key = kind === 'task' ? 'job_key' : 'request_id';
                        await store.runExecute(`UPDATE ${table} SET manual_result = ?, manual_result_reason = ?, manual_result_by = ?, manual_result_at = CURRENT_TIMESTAMP(3) WHERE ${key} = ?`,
                            [action, reason, adminEmail, id], options);
                    }
                    if (f.cdk) {
                        if (action === 'success') await store.runExecute(`UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP),
                            manual_redeemed_by = IF(manual_redeemed_at IS NULL, ?, manual_redeemed_by),
                            manual_redemption_reason = IF(manual_redeemed_at IS NULL, ?, manual_redemption_reason),
                            manual_redeemed_at = COALESCE(manual_redeemed_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?`, [adminEmail, reason, ctx.code.cdk_code], options);
                        else if (action === 'failed' && releaseLocalHold) await store.runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ? AND manual_redeemed_at IS NULL', [ctx.code.cdk_code], options);
                        else if (!row.manual_local_released_at) await store.runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [ctx.code.cdk_code], options);
                    }
                    if (action !== 'pause') {
                        // Manual completion is business evidence, never platform
                        // usage evidence. Do not call recordSuccess/settleCardUse.
                        if (releaseLocalHold) await markLocalRelease(kind, id, ctx, reason, adminEmail, options);
                        if (canSettle || releaseLocalHold) {
                            if (ctx.uses[0]?.state === 'reserved') await store.runExecute("UPDATE orbitcard_card_uses SET state = 'released' WHERE job_key = ? AND state = 'reserved'", [f.job], options);
                            if (ctx.card?.active_job === f.job) await store.runExecute('UPDATE orbitcard_managed_cards SET active_job = NULL WHERE scope = ? AND card_id = ? AND active_job = ?', [f.scope, f.cardId, f.job], options);
                        }
                        if (action === 'success' && f.cdk && !alreadySuccessful(kind, ctx)) {
                            await store.enqueueRedemption({ cdk: ctx.code.cdk_code,
                                orderId: kind === 'task' ? row.orbitcard_retry_root_job_key || id : row.client_order_no }, options);
                        }
                    }
                }
                await store.runExecute(`INSERT INTO order_manual_actions
                    (order_kind, order_id, action, reason, admin_email, previous_status, next_status, previous_state, next_state, release_local_hold)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [kind, id, action, reason, adminEmail, f.status, nextStatus, f.state, nextState, releaseLocalHold ? 1 : 0], options);
                // Return the committed shape from the same transaction. Rendering
                // a response must not run a payment recovery or notification hook.
                const saved = await readOrder(kind, id, options), savedHistory = await history(kind, id, options);
                const response = result(kind, id, saved, savedHistory, await context(kind, saved, options));
                if (guard) await assertOwned(guard);
                return response;
            });
        } finally { if (guard) await guard.release(); }
    }
    async function safeCall(fn, input) {
        try { return await fn(input); } catch (error) {
            if ([400, 404, 409].includes(error.status)) throw error;
            fail(500, '订单人工处理暂时不可用，请稍后重试');
        }
    }
    return { getOrderManualControl: input => safeCall(getOrderManualControl, input),
        applyOrderManualControl: input => safeCall(applyOrderManualControl, input) };
};
