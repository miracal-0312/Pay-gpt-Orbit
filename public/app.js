'use strict';
const $ = id => document.getElementById(id);
let activeCdk = '', activeJob = '', activePlanLabel = '', generation = 0, timer, expiryTimer, trackingStarted = 0, busy = false;
let pollFailures = 0, verifying = false, submitting = false, runtimeBusy = false;
let trackingQueued = false;
function trackingBudget() { return (trackingQueued ? 45 : 15) * 60 * 1000; }
const statusNames = { success: '订阅成功', failed: '充值失败', retry: '请重新提交 Session', manual: '处理中 / 结果待确认', running: '正在充值', processing: '正在充值', used: '卡密已使用', unused: '卡密可使用' };
const QUEUE_FULL_MESSAGE = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';
// Keep provider branding out of customer-facing copy, including stored order
// messages and upstream errors. API identifiers remain unchanged.
function publicText(text) {
    const value = String(text ?? '').replace(/ORBITCARD_[A-Z0-9_]+/gi, '服务配置')
        .replace(/orbit\s*card/gi, '充值服务');
    return /(?:账户(?:可用)?|支付卡)余额不足/.test(value) && !/联系客服/.test(value)
        ? `${value}；请联系客服处理` : value;
}
function message(text, type = '') { $('statusMessage').textContent = publicText(text); $('statusMessage').className = `message ${type}`; }
async function requestJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        let data;
        try { data = await response.json(); }
        catch (_) { throw new Error('服务端响应格式异常，请稍后查询'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务端响应格式异常，请稍后查询');
        if (!response.ok) {
            const error = new Error(data.message || '请求失败，请稍后查询');
            error.httpStatus = response.status;
            error.error_code = data.error_code;
            error.retry_after_seconds = data.retry_after_seconds;
            throw error;
        }
        return data;
    } catch (error) {
        const failure = new Error(controller.signal.aborted ? '请求超时' : error.message || '网络连接异常');
        failure.httpStatus = error.httpStatus;
        failure.error_code = error.error_code;
        failure.retry_after_seconds = error.retry_after_seconds;
        failure.uncertain = error.error_code !== 'PAYMENT_QUEUE_FULL' && (!error.httpStatus || error.httpStatus >= 500);
        throw failure;
    } finally { clearTimeout(timeout); }
}
function post(url, body) {
    return requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
// Confirmation belongs to this exact Session and verified CDK, in page memory only.
let pendingAccount = null, confirmedAccount = null;
function sessionEmail(raw) {
    const session = JSON.parse(raw);
    if (!session || Array.isArray(session) || typeof session !== 'object'
        || !session.user || typeof session.user !== 'object' || Array.isArray(session.user)
        || !session.account || typeof session.account !== 'object' || Array.isArray(session.account)
        || typeof (session.accessToken || session.access_token) !== 'string'
        || !(session.accessToken || session.access_token).trim()) throw new Error('请粘贴包含 user、account 和 accessToken 的完整 Session JSON');
    const email = session.user.email;
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Session 缺少有效的账号邮箱，请重新获取');
    if (session.expires && (!Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= Date.now())) throw new Error('Session 已过期，请重新获取');
    return email;
}
function closeAccountConfirmation() {
    pendingAccount = null;
    if ($('accountConfirmModal').open) $('accountConfirmModal').close();
    $('accountConfirmEmail').textContent = '';
    $('accountConfirmPlan').textContent = '';
}
function resetAccountConfirmation() {
    confirmedAccount = null;
    closeAccountConfirmation();
    $('accountConfirmationState').textContent = '';
}
function accountMatches(value) {
    return value && value.generation === generation && value.cdk === activeCdk
        && activeCdk === $('cdkInput').value.trim() && value.session === $('sessionInput').value;
}
function confirmAccount(raw, submitAfterConfirm = false) {
    const email = sessionEmail(raw);
    confirmedAccount = null;
    pendingAccount = { session: raw, cdk: activeCdk, generation, submitAfterConfirm };
    $('accountConfirmEmail').textContent = email;
    $('accountConfirmPlan').textContent = activePlanLabel;
    $('accountConfirmAccept').textContent = submitAfterConfirm ? '是此账号，确认充值' : '是此账号，确认';
    $('accountConfirmHint').textContent = submitAfterConfirm ? '确认后将为此账号提交充值。' : '确认账号后，请点击页面上的“确认充值”继续。';
    if (!$('accountConfirmModal').open) $('accountConfirmModal').showModal();
    $('accountConfirmCancel').focus();
}
function cancelAccountConfirmation() {
    resetAccountConfirmation();
    $('sessionInput').focus();
}
$('accountConfirmCancel').addEventListener('click', cancelAccountConfirmation);
$('accountConfirmModal').addEventListener('cancel', event => { event.preventDefault(); cancelAccountConfirmation(); });
$('accountConfirmAccept').addEventListener('click', async () => {
    const selected = pendingAccount;
    closeAccountConfirmation();
    if (!accountMatches(selected) || submitting || $('redeemForm').hidden) {
        resetAccountConfirmation();
        return;
    }
    try {
        const email = sessionEmail(selected.session);
        confirmedAccount = selected;
        $('accountConfirmationState').textContent = `已确认目标账号：${email}`;
        if (selected.submitAfterConfirm) return submitRecharge();
        $('startBtn').focus();
    } catch (error) { resetAccountConfirmation(); message(error.message, 'error'); }
});
$('sessionInput').addEventListener('input', event => {
    resetAccountConfirmation();
    if (event.isComposing || submitting || $('redeemForm').hidden || !activeCdk || activeCdk !== $('cdkInput').value.trim()) return;
    try { confirmAccount($('sessionInput').value); } catch (_) { /* Incomplete typing is validated on submit. */ }
});
function showRedeemStep(step) {
    for (const item of document.querySelectorAll('[data-redeem-step]')) {
        if (Number(item.dataset.redeemStep) === step) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
    }
}
function clearChallenge() { clearTimeout(expiryTimer); $('captchaBox').replaceChildren(); }
function challenge(value) {
    clearChallenge();
    if (!value || !Number.isFinite(Date.parse(value.expires_at))) return;
    const remaining = Date.parse(value.expires_at) - Date.now();
    let url; try { url = new URL(value.url); } catch (_) { return; }
    if (url.protocol !== 'https:' || remaining <= 0) return;
    const link = document.createElement('a');
    link.className = 'button'; link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = '打开人机验证'; $('captchaBox').append(link);
    expiryTimer = setTimeout(clearChallenge, remaining);
}
const shownResults = new Set();
let resultReturnFocus;
function closeResult() {
    $('resultModal').hidden = true;
    $('resultAccountInfo').hidden = true;
    $('resultEmail').textContent = '';
    $('resultPlan').textContent = '';
    resultReturnFocus?.focus();
}
$('resultClose').addEventListener('click', closeResult);
$('resultModal').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeResult(); }
    if (event.key === 'Tab') { event.preventDefault(); $('resultClose').focus(); }
});
function showResult(data, repeat = false) {
    if (data.queued) return;
    if (!['success', 'failed', 'manual', 'retry'].includes(data.status)) return;
    const queueFull = data.error_code === 'PAYMENT_QUEUE_FULL';
    const key = `${activeCdk}:${data.attemptJobKey || activeJob}:${data.status}:${data.error_code || ''}`;
    if (!repeat && shownResults.has(key)) return;
    shownResults.add(key);
    const success = data.status === 'success';
    const uncertain = data.status === 'manual';
    $('resultTitle').textContent = queueFull ? '请稍后下单' : success ? '订阅成功' : uncertain ? '充值结果待确认' : '充值未成功';
    const reason = data.order?.failureMessage || data.message || '暂未取得具体错误原因';
    $('resultDescription').textContent = queueFull ? QUEUE_FULL_MESSAGE : success ? '订阅成功，请等待一会刷新账户状态。'
        : publicText(`${uncertain ? '充值结果尚未确认，请勿重复充值。\n' : ''}${reason}`);
    $('resultSupport').textContent = success || queueFull ? '' : '请联系售后QQ 2244527967处理';
    $('resultAccountInfo').hidden = !success;
    $('resultEmail').textContent = success ? data.target_email || '原订单未记录账号' : '';
    $('resultPlan').textContent = success ? publicText(data.plan_label || activePlanLabel || '原订单未记录套餐') : '';
    if ($('resultModal').hidden) resultReturnFocus = document.activeElement;
    $('resultModal').hidden = false;
    $('resultClose').focus();
}
function display(data) {
    if (data.jobKey && activeJob && data.jobKey !== activeJob) return false;
    activeJob = data.jobKey || activeJob;
    if (data.plan_label) activePlanLabel = publicText(data.plan_label);
    const queued = Boolean(data.queued);
    if (queued) trackingQueued = true;
    const label = queued ? '排队等待' : statusNames[data.status] || data.status;
    const retry = !queued && data.status === 'retry';
    const released = data.status === 'failed' && data.cdk_state === 'available';
    $('retryBtn').hidden = !released;
    showRedeemStep(retry ? 2 : 3);
    if (activePlanLabel) $('planInfo').textContent = `${activePlanLabel} · ${label}`;
    $('redeemForm').hidden = !retry;
    if (!retry) resetAccountConfirmation();
    $('refreshBtn').hidden = data.provider !== 'orbitcard';
    $('progressBox').hidden = false;
    const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
    $('progressBox').setAttribute('aria-label', label);
    $('progressBar').parentElement.setAttribute('aria-valuenow', String(data.status === 'success' ? 100 : progress));
    $('progressBar').style.width = `${data.status === 'success' ? 100 : progress}%`;
    $('progressText').textContent = label;
    message(data.message || statusNames[data.status] || '等待查询', data.status === 'success' ? 'success' : data.status === 'failed' ? 'error' : '');
    $('orderInfo').textContent = `订单：${data.order_id || data.client_order_no || activeJob || '待分配'}`;
    showResult(data);
    if (!queued && ['success', 'failed', 'retry'].includes(data.status)) {
        clearTimeout(timer); clearChallenge();
        $('trackingHint').textContent = data.error_code === 'PAYMENT_QUEUE_FULL' ? QUEUE_FULL_MESSAGE : retry ? '请提交原目标账号的最新 Session 继续。'
            : released ? '卡密已释放，请先处理失败原因，再重新验证并继续充值。'
                : data.status === 'failed' ? '卡密暂不可重试，请联系管理员核对原订单。' : '结果已确认，仍可手动查询原订单。';
        return false;
    }
    $('trackingHint').textContent = queued ? '已进入等待队列，系统会自动继续，请勿重复提交。' : '正在自动查询原订单，可随时手动刷新。';
    return true;
}
async function refresh(auto = false, expected = generation) {
    if (!activeCdk || expected !== generation) return;
    if (auto && Date.now() - trackingStarted >= trackingBudget()) {
        $('trackingHint').textContent = '自动查询已暂停，可点击“查询原订单”继续。';
        return;
    }
    if (auto && document.hidden) { clearTimeout(timer); timer = setTimeout(() => refresh(true, expected), 10000); return; }
    if (busy) { if (auto) { clearTimeout(timer); timer = setTimeout(() => refresh(true, expected), 1000); } return; }
    busy = true; $('refreshBtn').disabled = true;
    let delay = 5000;
    try {
        const data = await post('/api/cdk/orbitcard/status', { cdk: activeCdk });
        if (expected !== generation) return;
        const retryAfter = Number(data.retry_after_ms);
        delay = Number.isFinite(retryAfter) ? Math.min(300000, Math.max(5000, retryAfter)) : 5000;
        pollFailures = data.success ? 0 : Math.min(pollFailures + 1, 4);
        if (pollFailures) delay = Math.max(delay, Math.min(60000, 5000 * 2 ** pollFailures));
        if (data.data && !display(data.data)) auto = false;
        if (!data.success) { clearChallenge(); message(data.message || '查询暂不可用，卡密仍保持原状态'); if (data.stop_tracking) auto = false; }
        if (data.success) challenge(data.captcha);
    } catch (error) { if (expected === generation) { clearChallenge(); message(`${error.message}。请保留原卡密并继续查询。`, 'error'); pollFailures = Math.min(pollFailures + 1, 4); } delay = Math.min(60000, 5000 * 2 ** pollFailures); }
    finally {
        busy = false; $('refreshBtn').disabled = false;
        if (expected === generation && auto && Date.now() - trackingStarted < trackingBudget()) {
            clearTimeout(timer); timer = setTimeout(() => refresh(true, expected), delay);
        }
        else if (expected === generation && auto) $('trackingHint').textContent = '自动查询已暂停，可点击“查询原订单”继续。';
    }
}
function startTracking() { clearTimeout(timer); trackingStarted = Date.now(); pollFailures = 0; $('refreshBtn').hidden = false; return refresh(true); }
$('cdkInput').addEventListener('input', () => {
    resetAccountConfirmation();
    showRedeemStep(1);
    closeResult();
    generation++; clearTimeout(timer); clearChallenge(); activeCdk = ''; activeJob = ''; activePlanLabel = ''; trackingQueued = false;
    $('redeemForm').hidden = true; $('refreshBtn').hidden = true; $('retryBtn').hidden = true; $('progressBox').hidden = true;
    $('sessionInput').value = '';
    $('orderInfo').textContent = ''; $('trackingHint').textContent = ''; $('planInfo').textContent = ''; message('');
});
async function verifyCurrentCdk(event) {
    event.preventDefault();
    if (verifying) return;
    resetAccountConfirmation();
    verifying = true;
    const current = ++generation; clearTimeout(timer); clearChallenge(); activeJob = '';
    const cdk = $('cdkInput').value.trim(); $('verifyBtn').disabled = true; $('retryBtn').disabled = true;
    activeCdk = ''; $('redeemForm').hidden = true; $('retryBtn').hidden = true;
    $('refreshBtn').hidden = true; $('progressBox').hidden = true;
    $('orderInfo').textContent = ''; $('trackingHint').textContent = '';
    try {
        const result = await post('/api/verify-cdk', { cdk });
        if (current !== generation) return;
        activeCdk = cdk;
        const data = result.data; activePlanLabel = publicText(data.plan_label || data.plan_type);
        if (!data.jobKey) trackingQueued = false;
        if (data.queued) trackingQueued = true;
        $('planInfo').textContent = `${activePlanLabel} · ${statusNames[data.status] || data.status}`;
        $('redeemForm').hidden = !['unused','retry'].includes(data.status) || data.type !== '自助';
        showRedeemStep($('redeemForm').hidden ? 3 : 2);
        if (!$('redeemForm').hidden) $('sessionGuide').focus();
        message(data.message || statusNames[data.status]);
        if (data.jobKey && data.provider === 'orbitcard') { activeJob = data.jobKey; startTracking(); }
        else if (data.provider === 'history') message(data.message || '历史充值记录需联系管理员人工核对');
    } catch (error) { if (current === generation) message(error.message, 'error'); }
    finally { verifying = false; $('verifyBtn').disabled = false; $('retryBtn').disabled = false; }
}
$('verifyForm').addEventListener('submit', verifyCurrentCdk);
$('retryBtn').addEventListener('click', verifyCurrentCdk);
async function submitRecharge() {
    if (submitting) return;
    if (!activeCdk || activeCdk !== $('cdkInput').value.trim()) return message('请先验证当前卡密', 'error');
    if ($('redeemForm').hidden) return;
    const session = $('sessionInput').value, cdk = activeCdk;
    try {
        sessionEmail(session);
        if (!accountMatches(confirmedAccount)) { confirmAccount(session, true); return; }
    } catch (error) {
        resetAccountConfirmation();
        return message(error instanceof SyntaxError ? 'Session 不是有效的 JSON' : error.message, 'error');
    }
    resetAccountConfirmation();
    submitting = true;
    const current = generation; $('startBtn').disabled = true;
    try {
        const result = await post('/api/run-process', { cdk, session });
        if (current !== generation) return;
        $('sessionInput').value = '';
        activeJob = result.jobKey;
        if (result.queued) trackingQueued = true;
        showRedeemStep(3);
        $('planInfo').textContent = `${activePlanLabel} · ${result.queued ? '排队等待' : '订单已提交'}`;
        $('redeemForm').hidden = true; message(result.message);
        if (result.provider === 'orbitcard') startTracking();
    } catch (error) {
        if (current !== generation) return;
        if (error.error_code === 'PAYMENT_QUEUE_FULL') {
            message(QUEUE_FULL_MESSAGE, 'error');
            showResult({ status: 'failed', error_code: error.error_code }, true);
        } else if (error.uncertain) {
            // An interrupted response cannot prove that the server rejected the order.
            $('sessionInput').value = ''; $('redeemForm').hidden = true; $('retryBtn').hidden = true;
            activeJob = ''; showRedeemStep(3);
            message(`${error.message}，提交结果尚未确认，正在查询原订单，请勿重复充值。`, 'error');
            startTracking();
        } else message(error instanceof SyntaxError ? 'Session 不是有效的 JSON' : error.message, 'error');
    }
    finally { submitting = false; $('startBtn').disabled = false; }
}
$('redeemForm').addEventListener('submit', event => {
    event.preventDefault();
    return submitRecharge();
});
$('refreshBtn').addEventListener('click', startTracking);
async function runtime() {
    if (runtimeBusy || document.hidden) return;
    runtimeBusy = true;
    try { const data = await requestJson('/api/public/runtime'); if (data.success) $('runtimeInfo').textContent = `当前处理任务 ${data.runtime.active_foreground_jobs} / ${data.runtime.max_foreground_jobs} · 排队等待 ${data.runtime.waiting_jobs ?? 0} / ${data.runtime.max_waiting_jobs ?? 1}`; }
    catch (_) { $('runtimeInfo').textContent = '服务状态暂不可用'; }
    finally { runtimeBusy = false; }
}
runtime(); setInterval(runtime, 30000);
