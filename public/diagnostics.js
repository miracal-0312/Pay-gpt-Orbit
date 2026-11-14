'use strict';

// Only request identifiers persist in the tab. Session remains in the textarea until submission.
const DIAG_REQUEST_KEY = 'orbitcard_debug_request_id';
let diagLogCursor = 0, diagLogKey = '', diagLogLines = [], diagLogSequence = 0, diagReading = false;
let diagLogChars = 0;
let diagLogRevision = '';
let diagFollowCurrentOrder = false;
const DIAG_LOG_CHAR_LIMIT = 1024 * 1024;
let diagOrder = null, diagPayBusy = false, diagQueryBusy = false;
let diagTrackingStarted = 0, diagPollFailures = 0, diagNextPollAt = 0, diagPolling = false, diagPreflightBusy = false;
try { $('diagRequestId').value = sessionStorage.getItem(DIAG_REQUEST_KEY) || ''; } catch (_) { /* storage unavailable */ }
function diagSetRequestId(id) {
    $('diagRequestId').value = id;
    try { if (id) sessionStorage.setItem(DIAG_REQUEST_KEY, id); else sessionStorage.removeItem(DIAG_REQUEST_KEY); } catch (_) { /* keep current page identity */ }
}
function diagFollow(key, followOrder = false) {
    diagFollowCurrentOrder = followOrder;
    diagTrackingStarted = Date.now(); diagPollFailures = 0; diagNextPollAt = 0;
    diagLogRevision = '';
    $('diagTraceId').value = key; diagLogSequence++; diagLogKey = key; diagLogCursor = 0; diagLogLines = []; diagLogChars = 0;
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
        const data = await request(`/api/admin/orbitcard/diagnostics/logs/${encodeURIComponent(key)}?cursor=${diagLogCursor}&revision=${encodeURIComponent(diagLogRevision)}`);
        if (sequence !== diagLogSequence) return;
        diagLogCursor = data.next_cursor;
        diagLogRevision = data.revision || '';
        if (data.reset) { diagLogLines = []; diagLogChars = 0; }
        for (const entry of data.entries || []) {
            const full = `[${new Date(entry.ts).toLocaleString('zh-CN')}] ${entry.event || 'log'} · ${entry.text || ''}${entry.data ? '\n' + JSON.stringify(entry.data, null, 2) : ''}`;
            const line = full.length > 32768 ? full.slice(0, 32768) + '\n[预览已缩短，完整内容请下载日志]' : full;
            diagLogLines.push(line); diagLogChars += line.length;
            while (diagLogLines.length > 1000 || diagLogChars > DIAG_LOG_CHAR_LIMIT) diagLogChars -= diagLogLines.shift().length;
        }
        $('diagTraceLog').textContent = diagLogLines.join('\n\n') || '尚无持久化记录。';
        $('diagLogState').textContent = `${key} · ${data.has_more ? '还有后续记录，点击“读取后续记录”或等待自动跟踪' : data.exists ? '已读到当前末尾' : '日志尚未生成'} · 页面保留容量范围内最近 1000 条预览，完整历史可下载`;
    } catch (error) { if (sequence === diagLogSequence) $('diagLogState').textContent = `日志读取失败：${error.message}`; throw error; }
    finally { diagReading = false; }
}
function diagShowConcurrency(simulation) {
    $('diagConcurrency').hidden = !simulation;
    $('diagConcurrencyRows').replaceChildren();
    if (!simulation) return;
    const summary = simulation.summary;
    const contention = simulation.initial_contention;
    $('diagConcurrencySummary').textContent = `${simulation.task_count} 个任务：分配现有卡 ${summary.assigned} 个（直接支付 ${summary.pay}、需补款 ${summary.fund}），等待 ${summary.waiting} 个，无可用卡或预算不足 ${summary.blocked} 个。模型内重复分配 ${summary.duplicate_assignments} 次。${contention ? `初始有 ${contention.tasks} 个任务同时首选卡 ${contention.card_id}，分配时会重新检查占用。` : ''}`;
    $('diagConcurrencyBudget').textContent = `账户快照 ${simulation.budget.available} USD；模拟预留预算 ${simulation.budget.reserved} USD；剩余 ${simulation.budget.remaining} USD。预算仅包含预计补款，不含平台额外费用；自动开卡已禁用。仅为快照模拟结果，不代表真实并发压测通过。`;
    const actions = { pay: '可直接支付', fund: '分配后需补款', wait: '等待', blocked: '未分配' };
    const reasons = { reserved_in_simulation: '仅在模拟中占用', busy: '卡片已被其他任务占用', cooldown: '支付后冷却中',
        authorizations_unconfirmed: '授权次数未确认', status_unconfirmed: '卡片状态未确认', account_balance: '共享账户预算不足',
        automatic_opening_disabled: '无可用现有卡，自动开卡已禁用', multiple_waiting: '多项等待条件' };
    $('diagConcurrencyRows').innerHTML = simulation.tasks.map(row => {
        const reason = row.reasons?.map(value => reasons[value] || value).join('、') || row.message || reasons[row.reason] || row.reason;
        return `<tr><td>${escapeHtml(row.task)}</td><td>${escapeHtml(row.initial_card_id ?? '—')}</td><td>${escapeHtml(actions[row.action] || row.action)}</td><td>${escapeHtml(row.card_id ?? '—')}</td><td>${escapeHtml(row.funding_amount)}</td><td>${escapeHtml(reason)}</td></tr>`;
    }).join('');
}
function diagPlanRequired() {
    const plan = $('diagPlan').value;
    if (!plan) throw new Error('请先读取并选择卡台开放的套餐');
    return plan;
}
async function diagPreflight(stage) {
    if (diagPreflightBusy) return;
    const input = { stage, request_id: crypto.randomUUID() };
    if (!['plans','balance','session'].includes(stage)) input.plan_type = diagPlanRequired();
    if (stage === 'concurrency') {
        input.concurrent_tasks = Number($('diagConcurrentTasks').value);
        if (!Number.isSafeInteger(input.concurrent_tasks) || input.concurrent_tasks < 2 || input.concurrent_tasks > 100) {
            throw new Error('并发模拟任务数必须为 2 到 100 的整数');
        }
    }
    if (['session','full'].includes(stage)) input.session = $('diagSession').value;
    const buttons = [...document.querySelectorAll('[data-diag-stage]')];
    diagPreflightBusy = true;
    buttons.forEach(button => { button.disabled = true; });
    diagFollow(`debug-${input.request_id}`);
    diagShowConcurrency(null);
    $('diagSteps').textContent = '预检进行中，只调用读取接口…';
    $('diagResult').textContent = '等待本次预检结果…';
    try {
        const data = await diagnosticFetch('/api/admin/orbitcard/diagnostics/preflight', input);
        diagFollow(data.trace_id);
        $('diagSteps').innerHTML = data.steps.map(step => `<li class="${step.state === 'passed' ? 'debug-passed' : 'debug-failed'}"><strong>${step.state === 'passed' ? step.step === 'concurrency' ? '完成模拟' : '通过' : '未通过'}</strong> · ${escapeHtml(step.message)} <small>${step.elapsed_ms} ms</small></li>`).join('');
        $('diagResult').textContent = JSON.stringify({ read_only: data.read_only, ready: data.ready, ...data.result }, null, 2);
        diagShowConcurrency(data.result.concurrency);
        if (Array.isArray(data.result.plans)) {
            const selectedPlan = $('diagPlan').value;
            $('diagPlan').replaceChildren(new Option('请选择平台已开放套餐', ''));
            for (const plan of data.result.plans) $('diagPlan').add(new Option(`${plan.name}（${plan.type}）`, plan.type));
            if (data.result.plans.some(plan => plan.type === selectedPlan)) $('diagPlan').value = selectedPlan;
        }
        notice(data.passed ? stage === 'concurrency' ? '模拟完成，请查看分配与等待结果；未创建订单或扣款。' : '只读预检完成；未创建订单或扣款。' : '预检未通过，请查看具体步骤及日志。', data.passed ? 'success' : 'error');
        await diagReadLogs();
    } catch (error) { $('diagSteps').textContent = `预检失败：${error.message}`; await diagReadLogs().catch(() => {}); throw error; }
    finally { diagPreflightBusy = false; buttons.forEach(button => { button.disabled = false; }); }
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
    if (diagFollowCurrentOrder && order.client_order_no && diagLogKey !== order.client_order_no) {
        diagFollow(order.client_order_no, true);
    }
    const terminal = ['success','failed','rejected'].includes(order.state);
    $('diagNewTest').disabled = !terminal;
    $('diagPay').disabled = !['preparing','prepared','retry_waiting'].includes(order.state);
    $('diagPay').textContent = order.state === 'retry_waiting' ? '提交 Session 换卡重试 · 真实扣款' : ['preparing','prepared'].includes(order.state) ? '继续原测试订单准备 · 可能真实扣款'
        : ['funding_waiting','funding_review'].includes(order.state) ? '补款正在核对，请查询原任务' : '当前订单已结束或已提交，请查询原单';
    $('diagOrderState').textContent = `${order.client_order_no} · 第 ${order.attempt || 1} / 3 次尝试 · ${order.plan_name || order.plan_type} · ${order.card_id ? `卡 ${order.card_id}` : '待选卡'} · ${order.state} · ${order.message || ''}`;
    $('diagCaptcha').replaceChildren();
    if (order.captcha?.url) {
        try {
            const url = new URL(order.captcha.url);
            if (url.protocol === 'https:') { const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开平台验证页面'; $('diagCaptcha').append(link); }
        } catch (_) { /* malformed challenge */ }
    }
}
async function diagResumeOrder(order) {
    await selectView('diagnostics/payment');
    diagSetRequestId(order.request_id);
    // Resume the persisted plan even before the optional catalog preflight has run.
    if (![...$('diagPlan').options].some(option => option.value === order.plan_type)) {
        $('diagPlan').add(new Option(order.plan_name || order.plan_type, order.plan_type));
    }
    $('diagPlan').value = order.plan_type;
    $('diagSession').value = ''; $('diagSessionFile').value = ''; $('diagAuthorized').checked = false;
    diagFollow(order.client_order_no, true); diagShowOrder(order);
    notice(`已载入原测试请求 ${order.request_id}；重新上传该账号 Session 后继续。`, 'success');
    $('diagSession').focus();
}
async function diagQueryOrder(refresh = true) {
    const id = $('diagRequestId').value.trim();
    if (!id) throw new Error('尚无测试请求编号');
    if (diagQueryBusy) return;
    diagQueryBusy = true;
    try {
        const data = await request(`/api/admin/manual/orders/${encodeURIComponent(id)}${refresh ? '/refresh' : ''}`, refresh ? {} : undefined);
        if (!diagLogKey && selectedDiagnostic === 'payment') diagFollowCurrentOrder = true;
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
    diagFollow(`manual-${id}`, true);
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
        if (!diagOrder || ['preparing','prepared','retry_waiting'].includes(diagOrder.state)) $('diagPay').disabled = false;
        await diagReadLogs().catch(() => {});
    }
});
$('diagQueryOrder').onclick = () => perform(async () => {
    const id = $('diagRequestId').value.trim(); if (id) diagFollow(`manual-${id}`, true);
    await diagQueryOrder(); await diagReadLogs();
});
$('diagNewTest').onclick = () => {
    if (!diagOrder || !['success','failed','rejected'].includes(diagOrder.state)) return;
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
    await downloadAudit(key, 'trace');
});
document.addEventListener('click', event => {
    const button = event.target.closest('[data-debug-trace]'); if (!button) return;
    selectView('diagnostics/trace');
    diagFollow(button.dataset.debugTrace);
    perform(async () => { await diagReadLogs(); $('diagTraceId').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
});
$('diagAutoLogs').addEventListener('change', () => {
    diagTrackingStarted = Date.now(); diagPollFailures = 0; diagNextPollAt = 0;
});
setInterval(async () => {
    if (document.hidden || selected !== 'diagnostics' || !['payment','trace'].includes(selectedDiagnostic) || !$('diagAutoLogs').checked || !localStorage.getItem(SECONDARY_KEY) || diagPolling) return;
    if (!diagTrackingStarted) diagTrackingStarted = Date.now();
    if (Date.now() - diagTrackingStarted >= 15 * 60 * 1000 || diagPollFailures >= 5) {
        $('diagAutoLogs').checked = false;
        $('diagLogState').textContent = '自动跟踪已暂停；需要继续时，请重新勾选自动跟踪。';
        return;
    }
    if (Date.now() < diagNextPollAt) return;
    diagPolling = true;
    try {
        if ($('diagTraceId').value.trim()) await diagReadLogs();
        if ($('diagRequestId').value && !diagPayBusy && (!diagOrder || ['retry_waiting','funding_waiting','funding_review','submitting','pending','manual'].includes(diagOrder.state))) await diagQueryOrder();
        diagPollFailures = 0;
    } catch (_) { diagPollFailures++; }
    finally {
        diagNextPollAt = Date.now() + Math.min(60000, 10000 * 2 ** diagPollFailures);
        diagPolling = false;
    }
}, 10000);
