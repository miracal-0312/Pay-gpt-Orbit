'use strict';
const $ = id => document.getElementById(id);
let activeCdk = '', activeJob = '', activePlanLabel = '', generation = 0, timer, expiryTimer, trackingStarted = 0, busy = false;
const statusNames = { success: '订阅成功', failed: '充值失败', retry: '请重新提交 Session', manual: '处理中 / 结果待确认', running: '正在充值', processing: '正在充值', used: '卡密已使用', unused: '卡密可使用' };
function message(text, type = '') { $('statusMessage').textContent = text; $('statusMessage').className = `message ${type}`; }
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
            throw error;
        }
        return data;
    } catch (error) {
        const failure = new Error(controller.signal.aborted ? '请求超时' : error.message || '网络连接异常');
        failure.httpStatus = error.httpStatus;
        failure.uncertain = !error.httpStatus || error.httpStatus >= 500;
        throw failure;
    } finally { clearTimeout(timeout); }
}
function post(url, body) {
    return requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
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
function display(data) {
    if (data.jobKey && activeJob && data.jobKey !== activeJob) return false;
    activeJob = data.jobKey || activeJob;
    const retry = data.status === 'retry';
    const released = data.status === 'failed' && data.cdk_state === 'available';
    $('retryBtn').hidden = !released;
    showRedeemStep(retry ? 2 : 3);
    if (activePlanLabel) $('planInfo').textContent = `${activePlanLabel} · ${statusNames[data.status] || data.status}`;
    $('redeemForm').hidden = !retry;
    $('refreshBtn').hidden = data.provider !== 'orbitcard';
    $('progressBox').hidden = false;
    const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
    $('progressBox').setAttribute('aria-label', statusNames[data.status] || data.status);
    $('progressBar').parentElement.setAttribute('aria-valuenow', String(data.status === 'success' ? 100 : progress));
    $('progressBar').style.width = `${data.status === 'success' ? 100 : progress}%`;
    $('progressText').textContent = statusNames[data.status] || data.status;
    message(data.message || statusNames[data.status] || '等待查询', data.status === 'success' ? 'success' : data.status === 'failed' ? 'error' : '');
    $('orderInfo').textContent = `订单：${data.order_id || data.client_order_no || activeJob || '待分配'}`;
    if (['success', 'failed', 'retry'].includes(data.status)) {
        clearTimeout(timer); clearChallenge();
        $('trackingHint').textContent = retry ? '请提交原目标账号的最新 Session 继续。'
            : released ? '卡密已释放，请先处理失败原因，再重新验证并继续充值。'
                : data.status === 'failed' ? '卡密暂不可重试，请联系管理员核对原订单。' : '结果已确认，仍可手动查询原订单。';
        return false;
    }
    $('trackingHint').textContent = '正在自动查询原订单，可随时手动刷新。';
    return true;
}
async function refresh(auto = false, expected = generation) {
    if (!activeCdk || expected !== generation) return;
    if (busy) { if (auto) { clearTimeout(timer); timer = setTimeout(() => refresh(true, expected), 1000); } return; }
    busy = true; $('refreshBtn').disabled = true;
    let delay = 5000;
    try {
        const data = await post('/api/cdk/orbitcard/status', { cdk: activeCdk });
        if (expected !== generation) return;
        delay = Math.max(5000, Number(data.retry_after_ms) || 0);
        if (data.data && !display(data.data)) auto = false;
        if (!data.success) { clearChallenge(); message(data.message || '查询暂不可用，卡密仍保持原状态'); if (data.stop_tracking) auto = false; }
        if (data.success) challenge(data.captcha);
    } catch (error) { if (expected === generation) { clearChallenge(); message(`${error.message}。请保留原卡密并继续查询。`, 'error'); } delay = 10000; }
    finally {
        busy = false; $('refreshBtn').disabled = false;
        if (expected === generation && auto && Date.now() - trackingStarted < 15 * 60 * 1000) {
            clearTimeout(timer); timer = setTimeout(() => refresh(true, expected), delay);
        }
        else if (expected === generation && auto) $('trackingHint').textContent = '自动查询已暂停，可点击“查询原订单”继续。';
    }
}
function startTracking() { clearTimeout(timer); trackingStarted = Date.now(); $('refreshBtn').hidden = false; return refresh(true); }
$('cdkInput').addEventListener('input', () => {
    showRedeemStep(1);
    generation++; clearTimeout(timer); clearChallenge(); activeCdk = ''; activeJob = ''; activePlanLabel = '';
    $('redeemForm').hidden = true; $('refreshBtn').hidden = true; $('retryBtn').hidden = true; $('progressBox').hidden = true;
    $('sessionInput').value = '';
    $('orderInfo').textContent = ''; $('trackingHint').textContent = ''; $('planInfo').textContent = ''; message('');
});
async function verifyCurrentCdk(event) {
    event.preventDefault(); const current = ++generation; clearTimeout(timer); clearChallenge(); activeJob = '';
    const cdk = $('cdkInput').value.trim(); $('verifyBtn').disabled = true; $('retryBtn').disabled = true;
    activeCdk = ''; $('redeemForm').hidden = true; $('retryBtn').hidden = true;
    $('refreshBtn').hidden = true; $('progressBox').hidden = true;
    $('orderInfo').textContent = ''; $('trackingHint').textContent = '';
    try {
        const result = await post('/api/verify-cdk', { cdk });
        if (current !== generation) return;
        activeCdk = cdk;
        const data = result.data; activePlanLabel = data.plan_label || data.plan_type;
        $('planInfo').textContent = `${activePlanLabel} · ${statusNames[data.status] || data.status}`;
        $('redeemForm').hidden = !['unused','retry'].includes(data.status) || data.type !== '自助';
        showRedeemStep($('redeemForm').hidden ? 3 : 2);
        if (!$('redeemForm').hidden) $('sessionGuide').focus();
        message(data.message || statusNames[data.status]);
        if (data.jobKey && data.provider === 'orbitcard') { activeJob = data.jobKey; startTracking(); }
        else if (data.provider === 'history') message(data.message || '历史充值记录需联系管理员人工核对');
    } catch (error) { if (current === generation) message(error.message, 'error'); }
    finally { $('verifyBtn').disabled = false; $('retryBtn').disabled = false; }
}
$('verifyForm').addEventListener('submit', verifyCurrentCdk);
$('retryBtn').addEventListener('click', verifyCurrentCdk);
$('redeemForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!activeCdk || activeCdk !== $('cdkInput').value.trim()) return message('请先验证当前卡密', 'error');
    const current = generation; $('startBtn').disabled = true;
    try {
        JSON.parse($('sessionInput').value);
        const result = await post('/api/run-process', { cdk: activeCdk, session: $('sessionInput').value });
        if (current !== generation) return;
        $('sessionInput').value = '';
        activeJob = result.jobKey;
        showRedeemStep(3);
        $('planInfo').textContent = `${activePlanLabel} · 订单已提交`;
        $('redeemForm').hidden = true; message(result.message);
        if (result.provider === 'orbitcard') startTracking();
    } catch (error) {
        if (current !== generation) return;
        if (error.uncertain) {
            // An interrupted response cannot prove that the server rejected the order.
            $('sessionInput').value = ''; $('redeemForm').hidden = true; $('retryBtn').hidden = true;
            activeJob = ''; showRedeemStep(3);
            message(`${error.message}，提交结果尚未确认，正在查询原订单，请勿重复充值。`, 'error');
            startTracking();
        } else message(error instanceof SyntaxError ? 'Session 不是有效的 JSON' : error.message, 'error');
    }
    finally { $('startBtn').disabled = false; }
});
$('refreshBtn').addEventListener('click', startTracking);
async function runtime() {
    try { const data = await requestJson('/api/public/runtime'); if (data.success) $('runtimeInfo').textContent = `当前处理任务 ${data.runtime.active_foreground_jobs} / ${data.runtime.max_foreground_jobs}`; }
    catch (_) { $('runtimeInfo').textContent = '服务状态暂不可用'; }
}
runtime(); setInterval(runtime, 30000);
