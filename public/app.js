'use strict';
const $ = id => document.getElementById(id);
let activeCdk = '', activeJob = '', activePlanLabel = '', generation = 0, timer, expiryTimer, trackingStarted = 0, busy = false;
const statusNames = { success: '订阅成功', failed: '充值失败', retry: '请重新提交 Session', manual: '处理中 / 结果待确认', running: '正在充值', processing: '正在充值', used: '卡密已使用', unused: '卡密可使用' };
function message(text, type = '') { $('statusMessage').textContent = text; $('statusMessage').className = `message ${type}`; }
async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '请求失败，请稍后查询');
    return data;
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
    showRedeemStep(3);
    if (activePlanLabel) $('planInfo').textContent = `${activePlanLabel} · ${statusNames[data.status] || data.status}`;
    $('redeemForm').hidden = true;
    $('refreshBtn').hidden = data.provider !== 'orbitcard';
    $('progressBox').hidden = false;
    const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
    $('progressBox').setAttribute('aria-label', statusNames[data.status] || data.status);
    $('progressBar').parentElement.setAttribute('aria-valuenow', String(data.status === 'success' ? 100 : progress));
    $('progressBar').style.width = `${data.status === 'success' ? 100 : progress}%`;
    $('progressText').textContent = statusNames[data.status] || data.status;
    message(data.message || statusNames[data.status] || '等待查询', data.status === 'success' ? 'success' : data.status === 'failed' ? 'error' : '');
    $('orderInfo').textContent = `订单：${data.order_id || data.client_order_no || activeJob || '待分配'}`;
    if (['success', 'failed', 'retry'].includes(data.status)) { clearTimeout(timer); clearChallenge(); $('trackingHint').textContent = data.status === 'retry' ? '请点击“验证卡密”，再提交最新 Session 继续。' : '结果已确认，仍可手动查询原订单。'; return false; }
    return true;
}
async function refresh(auto = false, expected = generation) {
    if (!activeCdk) return;
    if (busy) { if (auto && expected === generation) timer = setTimeout(() => refresh(true, expected), 1000); return; }
    busy = true; $('refreshBtn').disabled = true;
    let delay = 5000;
    try {
        const data = await post('/api/cdk/orbitcard/status', { cdk: activeCdk });
        if (expected !== generation) return;
        delay = Math.max(5000, Number(data.retry_after_ms) || 0);
        if (data.data && !display(data.data)) auto = false;
        if (!data.success) { message(data.message || '查询暂不可用，卡密仍保持原状态'); if (data.stop_tracking) auto = false; }
        if (data.success) challenge(data.captcha);
    } catch (error) { if (expected === generation) message(`${error.message}。请保留原卡密并继续查询。`, 'error'); delay = 10000; }
    finally {
        busy = false; $('refreshBtn').disabled = false;
        if (expected === generation && auto && Date.now() - trackingStarted < 15 * 60 * 1000) timer = setTimeout(() => refresh(true, expected), delay);
        else if (expected === generation && auto) $('trackingHint').textContent = '自动查询已暂停，可点击“查询原订单”继续。';
    }
}
function startTracking() { clearTimeout(timer); trackingStarted = Date.now(); $('refreshBtn').hidden = false; refresh(true); }
$('cdkInput').addEventListener('input', () => {
    showRedeemStep(1);
    generation++; clearTimeout(timer); clearChallenge(); activeCdk = ''; activeJob = ''; activePlanLabel = '';
    $('redeemForm').hidden = true; $('refreshBtn').hidden = true; $('progressBox').hidden = true;
    $('orderInfo').textContent = ''; $('trackingHint').textContent = ''; $('planInfo').textContent = ''; message('');
});
$('verifyForm').addEventListener('submit', async event => {
    event.preventDefault(); const current = ++generation; clearTimeout(timer); clearChallenge(); activeJob = '';
    const cdk = $('cdkInput').value.trim(); $('verifyBtn').disabled = true;
    try {
        const result = await post('/api/verify-cdk', { cdk });
        if (current !== generation) return;
        activeCdk = cdk;
        const data = result.data; activePlanLabel = data.plan_label || data.plan_type;
        $('planInfo').textContent = `${activePlanLabel} · ${statusNames[data.status] || data.status}`;
        $('redeemForm').hidden = !['unused','retry'].includes(data.status) || data.type !== '自助';
        showRedeemStep($('redeemForm').hidden ? 3 : 2);
        if (!$('redeemForm').hidden) $('sessionInput').focus();
        message(data.message || statusNames[data.status]);
        if (data.jobKey && data.provider === 'orbitcard') { activeJob = data.jobKey; startTracking(); }
        else if (data.provider === 'history') message(data.message || '历史充值记录需联系管理员人工核对');
    } catch (error) { if (current === generation) message(error.message, 'error'); }
    finally { $('verifyBtn').disabled = false; }
});
$('redeemForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!activeCdk || activeCdk !== $('cdkInput').value.trim()) return message('请先验证当前卡密', 'error');
    const current = generation; $('startBtn').disabled = true;
    try {
        JSON.parse($('sessionInput').value);
        const result = await post('/api/run-process', { cdk: activeCdk, session: $('sessionInput').value });
        $('sessionInput').value = '';
        if (current !== generation) return;
        activeJob = result.jobKey;
        showRedeemStep(3);
        $('planInfo').textContent = `${activePlanLabel} · 订单已提交`;
        $('redeemForm').hidden = true; message(result.message);
        if (result.provider === 'orbitcard') startTracking();
    } catch (error) { if (current === generation) message(error instanceof SyntaxError ? 'Session 不是有效的 JSON' : error.message, 'error'); }
    finally { $('startBtn').disabled = false; }
});
$('refreshBtn').addEventListener('click', () => { clearTimeout(timer); refresh(false); });
async function runtime() {
    try { const data = await (await fetch('/api/public/runtime')).json(); if (data.success) $('runtimeInfo').textContent = `当前处理任务 ${data.runtime.active_foreground_jobs} / ${data.runtime.max_foreground_jobs}`; }
    catch (_) { $('runtimeInfo').textContent = '服务状态暂不可用'; }
}
runtime(); setInterval(runtime, 30000);
