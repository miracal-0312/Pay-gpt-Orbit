'use strict';

// Only request identifiers persist in the tab. Session remains in the textarea until submission.
const DIAG_REQUEST_KEY = 'orbitcard_debug_request_id';
let diagLogCursor = 0, diagLogKey = '', diagLogLines = [], diagLogSequence = 0, diagReading = false;
let diagOrder = null, diagPayBusy = false, diagQueryBusy = false;
try { $('diagRequestId').value = sessionStorage.getItem(DIAG_REQUEST_KEY) || ''; } catch (_) { /* storage unavailable */ }
function diagSetRequestId(id) {
    $('diagRequestId').value = id;
    try { if (id) sessionStorage.setItem(DIAG_REQUEST_KEY, id); else sessionStorage.removeItem(DIAG_REQUEST_KEY); } catch (_) { /* keep current page identity */ }
}
function diagFollow(key) {
    $('diagTraceId').value = key; diagLogSequence++; diagLogKey = key; diagLogCursor = 0; diagLogLines = [];
    $('diagTraceLog').textContent = '正在读取持久化日志…';
    $('diagLogState').textContent = `${key} · 等待读取`;
}
async function diagReadLogs(reset = false) {
    const key = $('diagTraceId').value.trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('请填写有效的预检编号或任务日志编号');
    if (reset || key !== diagLogKey) diagFollow(key);
    const sequence = diagLogSequence;
    if (diagReading) return;
    diagReading = true;
    try {
        const data = await request(`/api/admin/orbitcard/diagnostics/logs/${encodeURIComponent(key)}?cursor=${diagLogCursor}`);
        if (sequence !== diagLogSequence) return;
        diagLogCursor = data.next_cursor;
        for (const entry of data.entries || []) {
            diagLogLines.push(`[${new Date(entry.ts).toLocaleString('zh-CN')}] ${entry.event || 'log'} · ${entry.text || ''}${entry.data ? '\n' + JSON.stringify(entry.data, null, 2) : ''}`);
        }
        if (diagLogLines.length > 1000) diagLogLines.splice(0, diagLogLines.length - 1000);
        $('diagTraceLog').textContent = diagLogLines.join('\n\n') || '尚无持久化记录。';
        $('diagLogState').textContent = `${key} · ${data.has_more ? '还有后续记录，点击“读取后续记录”或等待自动跟踪' : data.exists ? '已读到当前末尾' : '日志尚未生成'} · 页面最多显示最近 1000 条，完整历史可下载`;
    } catch (error) { if (sequence === diagLogSequence) $('diagLogState').textContent = `日志读取失败：${error.message}`; throw error; }
    finally { diagReading = false; }
}
function diagPlanRequired() {
    const plan = $('diagPlan').value;
    if (!plan) throw new Error('请先读取并选择卡台开放的套餐');
    return plan;
}
async function diagPreflight(stage) {
    const input = { stage, request_id: crypto.randomUUID() };
    if (!['plans','balance','session'].includes(stage)) input.plan_type = diagPlanRequired();
    if (['session','full'].includes(stage)) input.session = $('diagSession').value;
    const buttons = [...document.querySelectorAll('[data-diag-stage]')];
    buttons.forEach(button => { button.disabled = true; });
    diagFollow(`debug-${input.request_id}`);
    $('diagSteps').textContent = '预检进行中，只调用读取接口…';
    $('diagResult').textContent = '等待本次预检结果…';
    try {
        const data = await diagnosticFetch('/api/admin/orbitcard/diagnostics/preflight', input);
        diagFollow(data.trace_id);
        $('diagSteps').innerHTML = data.steps.map(step => `<li class="${step.state === 'passed' ? 'debug-passed' : 'debug-failed'}"><strong>${step.state === 'passed' ? '通过' : '未通过'}</strong> · ${escapeHtml(step.message)} <small>${step.elapsed_ms} ms</small></li>`).join('');
        $('diagResult').textContent = JSON.stringify({ read_only: data.read_only, ready: data.ready, ...data.result }, null, 2);
        if (Array.isArray(data.result.plans)) {
            const selectedPlan = $('diagPlan').value;
            $('diagPlan').replaceChildren(new Option('请选择平台已开放套餐', ''));
            for (const plan of data.result.plans) $('diagPlan').add(new Option(`${plan.name}（${plan.type}）`, plan.type));
            if (data.result.plans.some(plan => plan.type === selectedPlan)) $('diagPlan').value = selectedPlan;
        }
        notice(data.passed ? '只读预检完成；未创建订单或扣款。' : '预检未通过，请查看具体步骤及日志。', data.passed ? 'success' : 'error');
        await diagReadLogs();
    } catch (error) { $('diagSteps').textContent = `预检失败：${error.message}`; await diagReadLogs().catch(() => {}); throw error; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
}
document.querySelectorAll('[data-diag-stage]').forEach(button => {
    button.onclick = () => perform(() => diagPreflight(button.dataset.diagStage));
});
$('diagSessionFile').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 200 * 1024) { notice('Session 文件超过 200 KB', 'error'); return; }
    try { const text = await file.text(); JSON.parse(text); $('diagSession').value = text; }
    catch (_) { $('diagSession').value = ''; notice('Session 文件不是有效 JSON', 'error'); }
});
function diagShowOrder(order) {
    diagOrder = order;
    const terminal = ['success','failed'].includes(order.state);
    $('diagNewTest').disabled = !terminal;
    $('diagPay').disabled = !['preparing','prepared'].includes(order.state);
    $('diagPay').textContent = ['preparing','prepared'].includes(order.state) ? '继续原测试订单准备 · 可能真实扣款' : '当前订单已提交，请查询原单';
    $('diagOrderState').textContent = `${order.client_order_no} · ${order.plan_name || order.plan_type} · ${order.card_id ? `卡 ${order.card_id}` : '待选卡'} · ${order.state} · ${order.message || ''}`;
    $('diagCaptcha').replaceChildren();
    if (order.captcha?.url) {
        try {
            const url = new URL(order.captcha.url);
            if (url.protocol === 'https:') { const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开平台验证页面'; $('diagCaptcha').append(link); }
        } catch (_) { /* malformed challenge */ }
    }
}
async function diagQueryOrder(refresh = true) {
    const id = $('diagRequestId').value.trim();
    if (!id) throw new Error('尚无测试请求编号');
    if (diagQueryBusy) return;
    diagQueryBusy = true;
    try {
        const data = await request(`/api/admin/manual/orders/${encodeURIComponent(id)}${refresh ? '/refresh' : ''}`, refresh ? {} : undefined);
        diagShowOrder(data.order);
        return data.order;
    } finally { diagQueryBusy = false; }
}
$('diagPay').onclick = () => perform(async () => {
    if (diagPayBusy) return;
    if (!$('diagAuthorized').checked) throw new Error('请确认目标账号授权及真实扣款');
    const plan = diagPlanRequired();
    try { JSON.parse($('diagSession').value); } catch (_) { throw new Error('请填写完整 Session JSON'); }
    let id = $('diagRequestId').value.trim();
    if (!id) { id = crypto.randomUUID(); diagSetRequestId(id); }
    diagPayBusy = true; $('diagPay').disabled = true;
    diagFollow(`manual-${id}`);
    $('diagOrderState').textContent = '正在处理原请求；请勿创建新的付款请求。';
    try {
        const data = await diagnosticFetch('/api/admin/manual/orders', {
            request_id: id, mode: 'test', plan_type: plan, cdk_code: '', session: $('diagSession').value, authorized: true
        });
        $('diagSession').value = ''; $('diagSessionFile').value = ''; $('diagAuthorized').checked = false;
        diagShowOrder(data.order);
        notice('测试订单已保存；请查看链路日志及原订单结果。', 'success');
    } catch (error) {
        $('diagOrderState').textContent = `请求结果待核对：${error.message}。保留原编号；如继续提交，仍使用同一请求。`;
        await diagQueryOrder(false).catch(() => {});
        throw error;
    } finally {
        diagPayBusy = false;
        if (!diagOrder || ['preparing','prepared'].includes(diagOrder.state)) $('diagPay').disabled = false;
        await diagReadLogs().catch(() => {});
    }
});
$('diagQueryOrder').onclick = () => perform(async () => {
    const id = $('diagRequestId').value.trim(); if (id) diagFollow(`manual-${id}`);
    await diagQueryOrder(); await diagReadLogs();
});
$('diagNewTest').onclick = () => {
    if (!diagOrder || !['success','failed'].includes(diagOrder.state)) return;
    diagSetRequestId(''); diagOrder = null; $('diagNewTest').disabled = true;
    $('diagPay').disabled = false; $('diagPay').textContent = '真实扣款测试开通';
    $('diagAuthorized').checked = false; $('diagSession').value = ''; $('diagSessionFile').value = '';
    $('diagOrderState').textContent = '已结束上一笔测试；新的测试需要重新上传 Session 并确认授权。';
};
$('diagReadLogs').onclick = () => perform(() => diagReadLogs(true));
$('diagMoreLogs').onclick = () => perform(() => diagReadLogs());
$('diagDownload').onclick = () => perform(async () => {
    const key = $('diagTraceId').value.trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('请填写有效的任务日志编号');
    const response = await fetch(`/api/admin/task-logs/${encodeURIComponent(key)}/audit`, { headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}` } });
    if (!response.ok) throw new Error('日志下载失败，请检查登录状态及日志编号');
    const url=URL.createObjectURL(await response.blob()), link=document.createElement('a');
    link.href=url; link.download=`trace-${key}.jsonl`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.addEventListener('click', event => {
    const button = event.target.closest('[data-debug-trace]'); if (!button) return;
    document.querySelector('[data-tab="orbitcard"]').click();
    diagFollow(button.dataset.debugTrace);
    perform(async () => { await diagReadLogs(); $('diagTraceId').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
});
setInterval(async () => {
    if (document.hidden || selected !== 'orbitcard' || !$('diagAutoLogs').checked || !localStorage.getItem(SECONDARY_KEY)) return;
    if ($('diagTraceId').value.trim()) await diagReadLogs().catch(() => {});
    if ($('diagRequestId').value && !diagPayBusy && (!diagOrder || ['submitting','pending','manual'].includes(diagOrder.state))) {
        await diagQueryOrder().catch(() => {});
    }
}, 10000);
