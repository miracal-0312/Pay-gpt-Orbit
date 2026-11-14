'use strict';
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'plus_admin_token', SECONDARY_KEY = 'plus_admin_secondary_token';
const cardPlans = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
let cdkPlans = {};
let loginUrl = '/admin-login', selected = 'overview', savedBaseUrl = '';
let selectedDiagnostic = 'api';
let cdkPlanFilter = '', cdkLoadSequence = 0, cdkLoadedFilter = null, cdkLoadedCount = 0;
let cdkExporting = false;
let cdkEditing = null, cdkStatusSaving = false;
let manualCatalog = { plans: [] }, manualOrders = [];
let paymentRegionLoadSequence = 0;
let autoRefreshStarted = Date.now(), autoRefreshBusy = false, autoRefreshFailures = 0;
let noticeTimer = null;
function notice(text, type = '') {
    clearTimeout(noticeTimer);
    const content = String(text ?? '');
    $('notice').className = `message notice-banner ${type}`;
    $('notice').hidden = !content;
    $('noticeText').textContent = content;
    noticeTimer = content ? setTimeout(() => notice(''), 5000) : null;
}
$('closeNotice').addEventListener('click', () => {
    const wasFocused = document.activeElement === $('closeNotice');
    notice('');
    if (wasFocused) $('viewTitle').focus({ preventScroll: true });
});
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function logout() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SECONDARY_KEY); location.assign(loginUrl); }
const pendingRequests = new Map();
function request(url, body, method = body === undefined ? 'GET' : 'POST') {
    const key = JSON.stringify([method, url, body]);
    if (pendingRequests.has(key)) return pendingRequests.get(key);
    if (pendingRequests.size >= 8) return Promise.reject(new Error('当前请求较多，请等待已有操作完成'));
    const pending = requestOnce(url, body, method).finally(() => pendingRequests.delete(key));
    pendingRequests.set(key, pending);
    return pending;
}
async function requestOnce(url, body, method) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { logout(); throw new Error('请先登录'); }
    const headers = { Authorization: `Bearer ${token}`, 'x-admin-secondary-token': localStorage.getItem(SECONDARY_KEY) || '' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
    const response = await fetch(url, { method, headers, signal: controller.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let data;
    if (response.status === 401) { logout(); throw new Error('登录已失效'); }
    try { data = await response.json(); }
    catch (_) { throw new Error(`服务端响应格式异常（HTTP ${response.status}）`); }
    if (!data || typeof data !== 'object') throw new Error(`服务端响应格式异常（HTTP ${response.status}）`);
    if (!response.ok || data.success === false) {
        if (data.secondaryRequired) { localStorage.removeItem(SECONDARY_KEY); $('unlockState').textContent = '请重新验证二级密码'; }
        const error = new Error(data.message || `请求失败（${response.status}）`);
        error.httpStatus = response.status;
        error.checks = Array.isArray(data.checks) ? data.checks : [];
        error.target = data.target || '';
        throw error;
    }
    return data;
    } catch (error) {
        if (controller.signal.aborted) throw new Error('请求超时；操作可能仍在处理，请查询原结果后再决定是否重试');
        throw error;
    } finally { clearTimeout(timeout); }
}
async function perform(action, success) {
    try { const result = await action(); if (success) notice(success, 'success'); return result; }
    catch (error) { notice(error.message, 'error'); return null; }
}
function status(value) { const text = { success: '成功', failed: '失败', rejected: '未受理（已释放）', retry: '待重新提交 Session', retry_waiting: '等待换卡重试', running: '处理中', preparing: '准备支付', funding_waiting: '等待补款到账', funding_review: '补款对账工单（后台跟进）', funding_pending: '补款待核对（支付已停止）', card_pending: '原开卡待确认（支付已停止）', prepared: '资金已就绪', submitting: '提交中', manual: '人工处理（支付已停止）', support_locked: '人工售后（支付已停止）', pending: '待确认', unused: '未使用', used: '已使用', redeemed: '已核销', processing: '占用中' }[value] || value; return `<span class="pill ${escapeHtml(value)}">${escapeHtml(text)}</span>`; }
function renderTasks(tasks) {
    $('tasks').innerHTML = tasks.map(task => {
        const order = task.order || {}, fee = order.fee_status ? `${order.service_fee ?? '—'} ${order.currency || 'USDT'} / ${order.fee_status}` : '—';
        const payment = order.payment ? `${order.payment.amount} ${order.payment.currency}` : '—';
        const preparing = ['preparing','prepared','funding_waiting','funding_review','card_pending','funding_pending','balance_blocked'].includes(task.orbitcard_state);
        const refresh = task.provider === 'orbitcard' ? `<button class="secondary" data-refresh-order="${escapeHtml(task.jobKey)}">${['funding_waiting','funding_review','funding_pending'].includes(task.orbitcard_state) ? '核对原补款' : '查原单'}</button>${preparing ? '' : ` <button type="button" class="secondary" data-edit-order="${escapeHtml(task.jobKey)}" data-order-status="${escapeHtml(task.status)}">人工修改</button>`}` : '<small>历史记录</small>';
        const cardLabel = task.card_id || (task.provider !== 'orbitcard' ? '历史未绑定'
            : ['preparing','prepared','rejected','balance_blocked','card_pending'].includes(task.orbitcard_state) ? '尚未分配支付卡' : '未记录支付卡');
        return `<tr><td>${escapeHtml(task.time)}<br><code>${escapeHtml(task.cdk)}</code></td><td>${escapeHtml(task.provider === 'orbitcard' ? task.token : '历史账号')}<br><code>${escapeHtml(task.order_id || task.client_order_no || task.jobKey)}</code><br>卡 ID：${escapeHtml(cardLabel)}</td><td>${status(['funding_review','funding_pending','card_pending'].includes(task.orbitcard_state) ? task.orbitcard_state : task.status)}<br>${escapeHtml(task.message)}</td><td>${escapeHtml(fee)}</td><td>${escapeHtml(payment)}</td><td>${refresh} <button class="secondary" data-download-audit="${escapeHtml(task.jobKey)}">下载日志</button> <button class="secondary" data-debug-trace="${escapeHtml(task.jobKey)}">链路日志</button></td></tr>`;
    }).join('') || '<tr><td colspan="6">暂无任务</td></tr>';
}
async function loadOverview() {
    const data = await request('/api/admin/data');
    for (const key of ['total','success','failed','pending']) $(key).textContent = data.stats?.[key] || 0;
    $('maxConcurrent').value = data.config.max_concurrent_activations;
    $('maintenance').checked = data.config.maintenance_mode;
    renderTasks(data.logs || []);
    const telegram = data.telegram || {};
    $('botState').textContent = telegram.bot_token_saved ? '已保存 Bot Token' : '未配置 Bot Token';
    $('adminChat').value = telegram.admin_chat_id || ''; $('groupChat').value = telegram.group_chat_id || '';
    for (const [id, key] of [['notifyAdmin','notify_admin'],['notifyGroup','notify_group'],['onSuccess','on_success'],['onFailure','on_failure']]) $(id).checked = Boolean(telegram[key]);
}
async function loadApi() {
    const { config } = await request('/api/admin/gpt-api');
    savedBaseUrl = config.base_url;
    $('apiEnabled').checked = config.enabled; $('baseUrl').value = config.base_url;
    $('productCode').value = config.orbitcard_product_code || '';
    $('maxInitialAmount').value = config.orbitcard_max_initial_amount || ''; $('maxFee').value = config.orbitcard_max_fee;
    paymentRegionLoadSequence++;
    for (const plan of Object.keys(cardPlans)) {
        $(`planPrice_${plan}`).value = config.orbitcard_plan_prices?.[plan] || '';
        renderPaymentRegionOptions(plan, [], config.orbitcard_payment_regions?.[plan] || '');
        $(`regionHint_${plan}`).textContent = '等待从已保存的平台读取可选地区。';
    }
    $('paymentRegionState').textContent = '选择后点击下方“保存配置”。';
    $('orderState').textContent = config.enabled ? '正在接单' : '已暂停新订单';
    $('orderState').className = `pill ${config.enabled ? 'success' : 'pending'}`;
    $('keyState').textContent = config.api_key_configured ? '环境变量已配置' : '缺少 ORBITCARD_API_KEY';
    $('secretState').textContent = config.orbitcard_secret_configured ? '环境变量已配置' : '缺少 ORBITCARD_API_SECRET';
    $('keyState').dataset.state = config.api_key_configured ? 'configured' : 'missing';
    $('secretState').dataset.state = config.orbitcard_secret_configured ? 'configured' : 'missing';
    if (config.api_key_configured && config.orbitcard_secret_configured) {
        await Promise.all([loadCardIdPreview(), loadPaymentRegions()]);
    } else {
        $('cardIdPreview').textContent = '请先在服务器环境变量中配置配对的 API Key 和 API Secret。';
        $('paymentRegionState').textContent = '请先配置平台凭据；已有地区设置会保留。';
        $('refreshPaymentRegions').disabled = false;
    }
}
function regionLabel(code) {
    try {
        const name = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code);
        return name && name !== code ? `${name} · ${code}` : code;
    } catch (_) { return code; }
}
function renderPaymentRegionOptions(plan, options, selectedValue) {
    const select = $(`paymentRegion_${plan}`), seen = new Set();
    const safeOptions = options.filter(item => /^[A-Z]{2}$/.test(item?.code || '') && !seen.has(item.code) && seen.add(item.code));
    const upstreamDefault = safeOptions.find(item => item.default);
    select.innerHTML = `<option value="">平台默认${upstreamDefault ? `（${escapeHtml(regionLabel(upstreamDefault.code))}）` : ''}</option>`
        + safeOptions.map(item => `<option value="${item.code}">${escapeHtml(regionLabel(item.code))}${item.default ? ' · 平台默认项' : ''}</option>`).join('');
    if (selectedValue && !seen.has(selectedValue)) {
        const option = document.createElement('option'); option.value = selectedValue;
        option.textContent = `${regionLabel(selectedValue)}（已选，待确认可用性）`; select.append(option);
    }
    select.value = selectedValue;
    return safeOptions;
}
async function loadPaymentRegions() {
    const sequence = ++paymentRegionLoadSequence, button = $('refreshPaymentRegions');
    button.disabled = true;
    $('paymentRegionState').textContent = `正在读取 ${savedBaseUrl} 的四档可选地区…`;
    let failures = 0;
    try {
        for (const plan of Object.keys(cardPlans)) {
            if (sequence !== paymentRegionLoadSequence) return;
            const hint = $(`regionHint_${plan}`); hint.textContent = '正在读取…'; hint.className = '';
            try {
                const data = await diagnosticFetch(`/api/admin/orbitcard/payment-regions?plan=${plan}`);
                if (sequence !== paymentRegionLoadSequence) return;
                const result = data.regions?.[plan];
                appendPlatformChecks([result?.trace], savedBaseUrl);
                if (!result || result.error) throw new Error(result?.error || '平台未返回地区');
                const value = $(`paymentRegion_${plan}`).value;
                const options = renderPaymentRegionOptions(plan, result.options || [], value);
                const unavailable = value && !options.some(item => item.code === value);
                hint.textContent = unavailable ? `已选地区 ${value} 当前未开放，请重新选择。`
                    : options.length ? `已读取 ${options.length} 个可选地区` : '平台未提供指定地区，可保留平台默认。';
                hint.className = unavailable ? 'region-unavailable' : '';
                if (unavailable) failures++;
            } catch (error) {
                if (sequence !== paymentRegionLoadSequence) return;
                failures++; hint.className = 'region-unavailable';
                hint.textContent = `读取失败，保留当前选择：${error.message}`;
            }
        }
        $('paymentRegionState').textContent = `${failures ? '部分地区需要核对' : '地区读取完成'} · ${new Date().toLocaleTimeString('zh-CN')}。选择后点击下方“保存配置”；根域名修改后请先保存再刷新。`;
    } finally { if (sequence === paymentRegionLoadSequence) button.disabled = false; }
}
async function loadCardIdPreview() {
    $('cardIdPreview').textContent = '正在从 Orbitcard 读取卡片 ID…';
    try {
        const data = await request('/api/admin/orbitcard/cards/preview');
        const ids = (data.cards || []).map(card => `${card.card_id}${card.status === 'ACTIVE' ? '（可用）' : `（${card.status || '未知状态'}）`}`);
        $('cardIdPreview').textContent = `平台共 ${data.total} 张卡，可用 ${data.active} 张。${ids.length ? `前 ${ids.length} 张：${ids.join('、')}` : '当前没有卡片，自动开卡已禁用，请手动申请卡片。'}`;
    } catch (error) { $('cardIdPreview').textContent = `卡片 ID 读取失败：${error.message}`; }
}
function apiInput() { return { enabled: $('apiEnabled').checked, base_url: $('baseUrl').value.trim(),
    orbitcard_product_code: $('productCode').value.trim(), orbitcard_max_initial_amount: $('maxInitialAmount').value.trim(),
    orbitcard_payment_regions: Object.fromEntries(Object.keys(cardPlans).map(plan => [plan, $(`paymentRegion_${plan}`).value])),
    orbitcard_plan_prices: Object.fromEntries(Object.keys(cardPlans).map(plan => [plan, $(`planPrice_${plan}`).value.trim()])),
    orbitcard_max_fee: $('maxFee').value.trim() }; }
function renderCardRow(card, sync = null) {
    const id = escapeHtml(card.card_id);
    const usage = `${escapeHtml(card.authorization_count ?? '待同步')} / ${escapeHtml(card.authorization_limit)} 次成功消费授权`;
    const history = card.retiring ? '待确认删卡'
        : card.authorization_count != null && Number(card.authorization_count) >= Number(card.authorization_limit) ? '达到上限，停止分配'
            : card.authorization_pending ? '等待授权同步，暂不分配'
            : card.cooling_down ? '支付后冷却中，暂不分配' : '平台成功消费授权自动累计';
    const countedAt = card.authorizations_checked_at ? `授权统计时间：${escapeHtml(card.authorizations_checked_at)}` : '尚未完成授权统计';
    const last4 = card.last4 ? `****${escapeHtml(card.last4)}` : '尾号未提供';
    const confirmed = sync?.synced_ids?.includes(Number(card.card_id));
    const snapshot = confirmed ? `本次同步：${sync.checked_at}` : sync?.failed ? '同步失败 · 以下为旧快照'
        : sync?.failed_ids?.includes(Number(card.card_id)) ? '详情读取失败 · 以下为旧快照'
            : sync?.listed_ids && !sync.listed_ids.includes(Number(card.card_id)) ? '本次平台列表未返回 · 以下为旧快照' : '本地快照 · 未实时查询';
    const labels = { ACTIVE: '正常（ACTIVE）', CANCELLED: '冻结（CANCELLED）', DELETED: '已删除（DELETED）' };
    const active = confirmed && card.provider_status === 'ACTIVE';
    return `<tr><td><strong class="card-id">${id}</strong><span class="card-meta">${last4}</span><span class="card-meta">${escapeHtml(card.product_code || '产品未知')}</span></td><td><span class="card-meta">${escapeHtml(snapshot)}</span><span class="card-provider-status${active ? ' active' : ''}">${escapeHtml(labels[card.provider_status] || card.provider_status || '未知状态')}</span><span class="card-balance">${escapeHtml(card.balance ?? '未知')} ${escapeHtml(card.currency || '')}</span></td><td><div class="card-usage-list">${usage}</div><span class="card-meta">${countedAt}</span></td><td>${card.active_job ? `<code>${escapeHtml(card.active_job)}</code>` : '<span class="card-idle">空闲</span>'}</td><td><div class="card-row-actions">${history}<button type="button" data-card-transactions="${id}" class="secondary">查看交易</button></div></td></tr>`;
}
async function loadCards(sync = null) {
    const data = await request('/api/admin/orbitcard/cards');
    data.cards = data.cards.filter(card => !['DELETED', 'UNAVAILABLE'].includes(card.provider_status));
    const currentCardId = $('transactionCardId').value;
    $('transactionCardId').replaceChildren(new Option('请选择平台卡片', ''));
    for (const card of data.cards) $('transactionCardId').add(new Option(`${card.card_id} / ${card.last4 ? `****${card.last4}` : '尾号未提供'}`, card.card_id));
    if (data.cards.some(card => String(card.card_id) === currentCardId)) $('transactionCardId').value = currentCardId;
    $('cardRows').innerHTML = data.cards.map(card => renderCardRow(card, sync)).join('') || '<tr><td colspan="5">尚无卡片，请同步或申请。</td></tr>';
    $('cardSyncState').textContent = sync?.failed ? `平台同步失败${sync.message ? `：${sync.message}` : ''}。下面显示旧的本地快照，不能用于确认当前状态和余额。`
        : sync?.checked_at ? `查询完成：${sync.checked_at}，同步 ${sync.count} 张，详情读取失败 ${sync.failed_ids.length} 张，已移出列表 ${(sync.removed_ids || []).length} 张。数值为本次查询时的快照。`
            : '状态、余额和授权次数为本地快照，点击“同步平台卡片”读取完整交易记录并维护卡池。“刷新本地记录”不会调用平台；消费授权次数包含接口可见的其他项目历史消费。';
    $('issueRows').innerHTML = data.issues.map(issue => `<tr><td>${escapeHtml(issue.created_at)}<br><code>${escapeHtml(issue.issue_key)}</code></td><td>${escapeHtml(issue.product_code)}<br>${escapeHtml(issue.amount)}</td><td>${issue.job_key ? escapeHtml(cardPlans[issue.plan_type] || issue.plan_type) : '共享卡池'} / ${escapeHtml(issue.state)}<br>${escapeHtml(issue.provider_status || '')}<br>${escapeHtml(issue.message)}</td><td>${escapeHtml(issue.order_no || '待返回')}<br>${escapeHtml(issue.card_id || '待返回')}</td></tr>`).join('') || '<tr><td colspan="4">暂无开卡申请</td></tr>';
    $('fundingRows').innerHTML=(data.fundings || []).map(funding => `<tr><td>${escapeHtml(funding.created_at)}<br><code>${escapeHtml(funding.job_key)}</code></td><td>${escapeHtml(funding.card_id)}<br>${escapeHtml(funding.amount)} USD</td><td>${escapeHtml(funding.state)} / ${escapeHtml(funding.provider_status)}<br>${escapeHtml(funding.order_no || funding.funding_key)}<br>${escapeHtml(funding.message)}</td><td>${escapeHtml(funding.fee_snapshot || '待确认')}<br>目标余额：${escapeHtml(funding.target_balance)}</td></tr>`).join('') || '<tr><td colspan="4">暂无卡片补款</td></tr>';
}
async function loadCardTransactions() {
    const id = Number($('transactionCardId').value), page = Number($('transactionPage').value);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(page) || page < 1) throw new Error('请输入有效卡 ID 和页码');
    $('loadTransactions').disabled = true;
    $('cardTransactions').textContent = '正在读取交易记录并更新成功消费授权次数…';
    let result;
    try {
        result = await request(`/api/admin/orbitcard/cards/${id}/transactions?page=${page}`);
        $('cardTransactions').textContent = JSON.stringify(result.data, null, 2);
        await loadCards();
    } catch (error) {
        if (!result) $('cardTransactions').textContent = `交易查询失败：${error.message}。授权次数未更新，现有次数为旧快照。`;
        throw error;
    } finally { $('loadTransactions').disabled = false; }
}
async function synchronizeCards() {
    $('syncCards').disabled = true;
    $('loadCards').disabled = true;
    $('cardSyncState').textContent = '正在读取平台卡片状态、余额和成功消费授权记录并维护卡池…';
    try {
        const result = await request('/api/admin/orbitcard/cards/sync', {});
        await loadCards(result);
        notice(result.message, result.failed_ids.length ? 'error' : 'success');
    } catch (error) {
        await loadCards({failed: true, message: error.message}).catch(() => {
            $('cardRows').innerHTML = '<tr><td colspan="5">同步及本地记录读取失败，请重新查询。</td></tr>';
            $('cardSyncState').textContent = `平台同步失败：${error.message}。本地记录也读取失败，无法确认当前卡片信息。`;
        });
        throw error;
    } finally {
        $('syncCards').disabled = false;
        $('loadCards').disabled = false;
    }
}
async function loadCdkPlans() {
    const data = await request('/api/admin/cdks/plans');
    const plans = Array.isArray(data.plans) ? data.plans : [];
    cdkPlans = Object.fromEntries(plans.map(plan => [plan.type, plan.name]));
    const current = $('planType').value;
    $('planType').innerHTML = plans.length
        ? plans.map(plan => `<option value="${escapeHtml(plan.type)}">${escapeHtml(plan.name)} (${escapeHtml(plan.type)})</option>`).join('')
        : '<option value="">卡台未开放可兑换套餐</option>';
    if (cdkPlans[current]) $('planType').value = current;
    $('generateForm').querySelector('button').disabled = !plans.length;
    $('importForm').querySelector('button').disabled = !plans.length;
    const filters = Object.entries(cardPlans).map(([type, name]) => [type, cdkPlans[type] || name]);
    $('cdkFilters').innerHTML = `<button type="button" data-cdk-plan="" aria-pressed="${cdkPlanFilter === ''}">全部</button>`
        + filters.map(([type, name]) => `<button type="button" data-cdk-plan="${escapeHtml(type)}" aria-pressed="${cdkPlanFilter === type}">${escapeHtml(name)}</button>`).join('');
    for (const button of $('cdkFilters').querySelectorAll('button')) button.classList.toggle('active', button.dataset.cdkPlan === cdkPlanFilter);
}
function cdkListQuery() {
    return new URLSearchParams({ plan_type: cdkPlanFilter, status: $('cdkStatusFilter').value, shipped: $('cdkShippedFilter').value }).toString();
}
async function loadCdks() {
    const filter = cdkPlanFilter, query = cdkListQuery(), sequence = ++cdkLoadSequence;
    cdkLoadedFilter = null;
    $('exportCdks').disabled = true;
    $('cdkListSummary').textContent = '正在加载卡密…';
    const codes = await request(`/api/admin/cdks?${query}`);
    if (sequence !== cdkLoadSequence) return;
    $('cdkRows').innerHTML = codes.map(code => `<tr><td><code>${escapeHtml(code.code)}</code></td><td>${escapeHtml(code.plan_label || code.plan_type)}</td><td>${status(code.status)}${code.manual_redeemed_at ? `<br>人工售后核销<br>${escapeHtml(code.manual_redeemed_by)} · ${escapeHtml(code.manual_redeemed_at)}<br>${escapeHtml(code.manual_redemption_reason)}` : code.orbitcard_support_locked ? '<br>支付失败，已锁定；请人工售后' : code.orbitcard_balance_blocked ? '<br>账户余额不足，CDK 已锁定' : code.orbitcard_pending_confirmation ? '<br>结果待确认' : ''}</td><td>${code.shipped ? '已出库' : '未出库'}</td><td><button type="button" class="secondary" data-cdk-status="${escapeHtml(code.code)}" data-cdk-state="${escapeHtml(code.status)}" data-cdk-shipped="${code.shipped}">修改状态</button>${!code.shipped && code.status === 'unused' ? `<button class="danger" data-delete-cdk="${escapeHtml(code.code)}">删除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">暂无卡密</td></tr>';
    $('cdkListSummary').textContent = `${filter ? (cdkPlans[filter] || cardPlans[filter] || filter) : '全部套餐'}：显示最近 ${codes.length} 条${codes.length === 2000 ? '（已达页面上限）' : ''}`;
    cdkLoadedFilter = query;
    cdkLoadedCount = codes.length;
    $('exportCdks').disabled = cdkExporting || !codes.length;
}
function editCdkStatus(button) {
    if (cdkStatusSaving) return;
    cdkEditing = { cdk: button.dataset.cdkStatus, status: button.dataset.cdkState, shipped: button.dataset.cdkShipped === 'true' };
    const labels = { unused: '未使用', processing: '占用中', redeemed: '已核销' };
    $('cdkStatusCode').textContent = cdkEditing.cdk;
    $('cdkEditStatus').innerHTML = `<option value="${escapeHtml(cdkEditing.status)}">${labels[cdkEditing.status]}（当前）</option>`
        + (cdkEditing.status !== 'redeemed' ? '<option value="redeemed">已核销</option>' : '');
    $('cdkEditStatus').value = cdkEditing.status;
    $('cdkEditStatus').disabled = cdkEditing.status === 'redeemed';
    $('cdkEditShipped').value = String(cdkEditing.shipped);
    $('cdkStatusReason').value = '';
    $('cdkStatusError').textContent = '';
    $('cdkStatusDialog').showModal();
}
async function saveCdkStatus() {
    if (!cdkEditing || cdkStatusSaving) return;
    const editing = cdkEditing, targetStatus = $('cdkEditStatus').value;
    const shipped = $('cdkEditShipped').value === 'true', reason = $('cdkStatusReason').value.trim();
    $('cdkStatusError').textContent = '';
    if (!reason || reason.length > 255) { $('cdkStatusError').textContent = '请填写 1–255 字的修改备注'; return; }
    const body = { reason, expected_status: editing.status, expected_shipped: editing.shipped };
    if (targetStatus !== editing.status) body.status = targetStatus;
    if (shipped !== editing.shipped) body.shipped = shipped;
    if (body.status === undefined && body.shipped === undefined) { $('cdkStatusError').textContent = '状态未变化，请调整后保存'; return; }
    cdkStatusSaving = true;
    $('cdkStatusFields').disabled = true;
    try {
        const result = await request(`/api/admin/cdks/${encodeURIComponent(editing.cdk)}/status`, body);
        $('cdkStatusDialog').close();
        cdkEditing = null;
        notice(result.message, 'success');
        try { await loadCdks(); }
        catch (error) { notice(`状态已保存，但列表刷新失败：${error.message}`, 'error'); }
    } catch (error) {
        $('cdkStatusError').textContent = error.message;
    } finally { cdkStatusSaving = false; $('cdkStatusFields').disabled = false; }
}
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function downloadAudit(job, prefix = 'task') {
    const response = await fetch(`/api/admin/task-logs/${encodeURIComponent(job)}/audit`, {
        headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}` }
    });
    if (response.status === 401) { logout(); return; }
    if (!response.ok) throw new Error((await response.json()).message || '日志下载失败');
    downloadBlob(await response.blob(), `${prefix}-${job}.jsonl`);
}
async function exportCdks() {
    const button = $('exportCdks'), filter = cdkPlanFilter;
    if (cdkExporting) return;
    const query = cdkListQuery();
    if (cdkLoadedFilter !== query) throw new Error('请先加载当前筛选下的卡密列表');
    const quantity = $('cdkExportQuantity');
    if (!quantity.checkValidity()) { quantity.reportValidity(); throw new Error('导出数量须为 1–100000 的整数或留空'); }
    const format = $('cdkExportFormat').value, markShipped = $('cdkMarkShipped').checked;
    const params = new URLSearchParams(query);
    params.set('quantity', quantity.value);
    params.set('format', format);
    params.set('mark_shipped', String(markShipped));
    const token = localStorage.getItem(TOKEN_KEY), secondary = localStorage.getItem(SECONDARY_KEY);
    if (!token) { logout(); throw new Error('请先登录'); }
    if (!secondary) throw new Error('请先通过二级验证');
    cdkExporting = true;
    button.disabled = true;
    button.textContent = '正在导出…';
    try {
        const response = await fetch(`/api/admin/cdks/export?${params}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'x-admin-secondary-token': secondary }
        });
        if (response.status === 401) { logout(); throw new Error('登录已失效'); }
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            if (data.secondaryRequired) {
                localStorage.removeItem(SECONDARY_KEY);
                $('unlockState').textContent = '请重新验证二级密码';
            }
            throw new Error(data.message || `导出失败（HTTP ${response.status}）`);
        }
        downloadBlob(await response.blob(), `cdks-${filter || 'all'}-${format}-${new Date().toISOString().slice(0, 10)}.csv`);
        notice(`${filter ? (cdkPlans[filter] || cardPlans[filter] || filter) : '全部套餐'}的 CDK 已按配置导出${markShipped ? '并标记出库' : '，出库状态未变更'}`, 'success');
        if (query === cdkListQuery()) {
            try { await loadCdks(); }
            catch (error) { notice(`文件已导出，但列表刷新失败：${error.message}。请重新加载列表。`, 'error'); }
        }
    } finally {
        cdkExporting = false;
        button.textContent = '按配置导出 CSV';
        button.disabled = !localStorage.getItem(SECONDARY_KEY) || !cdkLoadedCount || cdkLoadedFilter !== cdkListQuery();
    }
}
async function loadLogs() {
    const data = await request('/api/admin/runtime-logs?tail=1&limit=500');
    $('runtimeLogs').textContent = (data.entries || []).map(entry => `${new Date(entry.ts).toLocaleString()} [${entry.jobKey || 'system'}] ${entry.text}${entry.data ? ' ' + JSON.stringify(entry.data) : ''}`).join('\n') || '暂无日志';
}
async function loadSecurity() {
    const data = await request('/api/admin/security/status');
    loginUrl = data.loginUrl; $('adminEmail').textContent = data.email;
    $('securityState').textContent = `Authenticator：${data.totpEnabled ? '已启用' : '未启用'}；可用验证方式：${(data.availableMethods || []).join('、') || '密码登录'}`;
    $('setupTotp').disabled = data.totpEnabled;
    $('twofaMode').value = data.login2faMode; $('loginPath').value = data.loginPath; $('panelPath').value = data.panelPath;
}
async function loadLoginLogs() {
    const data = await request('/api/admin/login-logs?limit=100');
    $('loginLogs').textContent = JSON.stringify(data.logs || [], null, 2);
}
async function loadSelected() {
    if (selected === 'overview') await loadOverview();
    if (selected === 'orbitcard' || (selected === 'diagnostics' && ['api','payment'].includes(selectedDiagnostic) && !savedBaseUrl)) await loadApi();
    if (selected === 'cards') await loadCards();
    if (selected === 'diagnostics') {
        if (selectedDiagnostic === 'runtime') await loadLogs();
        if (selectedDiagnostic === 'login') await loadLoginLogs();
        if (selectedDiagnostic === 'trace' && localStorage.getItem(SECONDARY_KEY)) await loadManualOrders();
    }
    if (selected === 'settings') await Promise.all([loadOverview(), loadSecurity()]);
    if (selected === 'cdks' && localStorage.getItem(SECONDARY_KEY)) { await loadCdkPlans().catch(error => { cdkPlans = {}; notice(`套餐目录读取失败：${error.message}`, 'error'); }); await loadCdks(); }
    if (selected === 'manual' && localStorage.getItem(SECONDARY_KEY)) {
        await loadManualCatalog();
    }
}
function selectView(tab) {
    if (tab === 'logs') tab = 'diagnostics/runtime';
    const [view, diagnostic] = tab.split('/');
    tab = view;
    const button = [...$('tabs').querySelectorAll('[data-tab]')].find(item => item.dataset.tab === tab);
    if (!button) return;
    if (tab === 'diagnostics') {
        const sections = ['api','payment','trace','runtime','login'];
        if (diagnostic) selectedDiagnostic = sections.includes(diagnostic) ? diagnostic : 'api';
        for (const panel of document.querySelectorAll('[data-diagnostic-panel]')) panel.hidden = panel.dataset.diagnosticPanel !== selectedDiagnostic;
        for (const item of document.querySelectorAll('[data-diagnostic-tab]')) {
            const active = item.dataset.diagnosticTab === selectedDiagnostic;
            item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
        }
    }
    autoRefreshStarted = Date.now(); autoRefreshFailures = 0;
    selected = tab;
    for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== selected;
    for (const item of $('tabs').querySelectorAll('button')) {
        item.classList.toggle('active', item === button);
        if (item === button) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
    }
    $('viewTitle').textContent = button.textContent.trim();
    $('viewDescription').textContent = button.dataset.description;
    document.title = button.textContent.trim() + ' · YZWAI';
    history.replaceState(null, '', '#' + selected + (selected === 'diagnostics' ? '/' + selectedDiagnostic : ''));
    return perform(loadSelected);
}
document.addEventListener('click', event => {
    const button = event.target.closest('[data-diagnostic-tab],[data-open-diagnostic]');
    if (button) selectView('diagnostics/' + (button.dataset.diagnosticTab || button.dataset.openDiagnostic));
});
window.addEventListener('hashchange', () => selectView(location.hash.slice(1) || 'overview'));
$('tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]'); if (button) selectView(button.dataset.tab);
});
$('logout').onclick = logout; $('reload').onclick = () => { autoRefreshStarted = Date.now(); autoRefreshFailures = 0; return perform(loadSelected); };
function form(id, handler) {
    let submitting = false;
    $(id).addEventListener('submit', async event => {
        event.preventDefault();
        if (submitting) return;
        submitting = true;
        const button = $(id).querySelector('button[type=submit],button:not([type])');
        if (button) button.disabled = true;
        try { await handler(); } catch (error) { notice(error.message, 'error'); }
        finally { submitting = false; if (button) button.disabled = false; }
    });
}
form('unlockForm', async () => {
    const data = await request('/api/admin/verify-secondary', { password: $('secondaryPassword').value });
    $('secondaryPassword').value = ''; localStorage.setItem(SECONDARY_KEY, data.secondaryToken); $('unlockState').textContent = '已验证'; await loadSelected(); notice('二级验证已通过', 'success');
});
form('generateForm', async () => {
    const plan = $('planType').value;
    const data = await request('/api/admin/cdks/generate', { count: Number($('cdkCount').value), plan_type: plan });
    notice(`${data.message}，请在下方卡密列表配置导出。`, 'success'); await loadCdks();
});
form('importForm', async () => {
    const data = await request('/api/admin/cdks/import', { cdks: $('cdkImport').value.split(/[\s,;]+/).filter(Boolean), plan_type: $('planType').value });
    $('cdkImport').value = ''; notice(data.message, 'success'); await loadCdks();
});
async function loadManualCatalog() {
    $('manualCatalogState').textContent = '正在读取 Orbitcard 套餐…';
    const current = $('manualPlan').value;
    manualCatalog = { plans: [] };
    $('manualPlan').innerHTML = '<option value="">正在读取平台套餐</option>';
    let data;
    try { data = await request('/api/admin/manual/catalog'); }
    catch (error) { $('manualCatalogState').textContent = `套餐读取失败：${error.message}`; throw error; }
    manualCatalog = { plans: data.plans || [] };
    $('manualPlan').innerHTML = '<option value="">请选择平台已开放套餐</option>'
        + manualCatalog.plans.map(plan => `<option value="${escapeHtml(plan.type)}">${escapeHtml(plan.name)}（${escapeHtml(plan.type)}）</option>`).join('');
    if (manualCatalog.plans.some(plan => plan.type === current)) $('manualPlan').value = current;
    $('manualCatalogState').textContent = `实时套餐 ${manualCatalog.plans.length} 项；提交时自动读取卡台卡片并准备支付资金。`;
}
function renderManualOrders(orders) {
    $('manualOrderRows').innerHTML = orders.map(order => {
        const outcome = status(order.state);
        const previousAttempts = (order.attempts || []).map((attempt, index) => `<button type="button" class="secondary" data-debug-trace="${escapeHtml(attempt.client_order_no)}">第 ${index + 1} 次 · 卡 ${escapeHtml(attempt.card_id)} 日志</button>`).join('');
        const captcha = order.captcha?.url ? `<br><a href="${escapeHtml(order.captcha.url)}" target="_blank" rel="noopener noreferrer">打开平台验证链接</a>` : '';
        const action = `${['preparing','retry_waiting'].includes(order.state)
            ? `<button type="button" class="secondary" data-retry-manual="${escapeHtml(order.request_id)}">${order.state === 'retry_waiting' ? '提交 Session 换卡重试' : '继续准备'}</button>` : ''}${['submitting','pending','manual'].includes(order.state)
            ? `<button type="button" class="secondary" data-refresh-manual="${escapeHtml(order.request_id)}">查询原订单</button>` : ''}
            <button type="button" class="secondary" data-download-manual="${escapeHtml(order.client_order_no)}">下载日志</button> <button type="button" class="secondary" data-debug-trace="${escapeHtml(order.client_order_no)}">链路日志</button>`;
        return `<tr><td>${escapeHtml(new Date(order.created_at).toLocaleString('zh-CN'))}<br>${escapeHtml(order.target_email)}</td>
            <td>${order.mode === 'fulfillment' ? '人工交付' : '测试开通'}<br>${escapeHtml(order.plan_name || order.plan_type)}<br>${order.card_id ? `卡 ${escapeHtml(order.card_id)}` : '待选卡'}${order.cdk_code ? `<br><code>${escapeHtml(order.cdk_code)}</code>` : ''}</td>
            <td><code>${escapeHtml(order.client_order_no)}</code><br><small>请求 ${escapeHtml(order.request_id)}</small>${order.task_no ? `<br><code>${escapeHtml(order.task_no)}</code>` : ''}</td>
            <td>${outcome}<br>第 ${escapeHtml(order.attempt || 1)} / 3 次尝试<br>${escapeHtml(order.message || '')}${captcha}</td><td>${action}<div class="attempt-links">${previousAttempts}</div></td></tr>`;
    }).join('') || '<tr><td colspan="5">暂无管理员订单</td></tr>';
}
async function loadManualOrders() {
    const data = await request('/api/admin/manual/orders');
    manualOrders = data.orders || [];
    renderManualOrders(manualOrders);
}
$('refreshManualCatalog').onclick = () => perform(loadManualCatalog);
$('refreshManualOrders').onclick = () => perform(loadManualOrders);
$('manualSessionFile').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 200 * 1024) { notice('Session JSON 文件过大（上限 200 KB）', 'error'); return; }
    try { $('manualSession').value = await file.text(); JSON.parse($('manualSession').value); }
    catch (_) { $('manualSession').value = ''; notice('文件不是有效的 JSON', 'error'); }
});
form('manualForm', async () => {
    if (!manualCatalog.plans.some(plan => plan.type === $('manualPlan').value)) throw new Error('请选择当前开放的套餐');
    try { JSON.parse($('manualSession').value); } catch (_) { throw new Error('Session 必须是完整 JSON'); }
    const requestId = $('manualRetryId').value.trim() || crypto.randomUUID();
    $('manualRetryId').value = requestId;
    const data = await request('/api/admin/manual/orders', {
        request_id: requestId, mode: 'fulfillment', plan_type: $('manualPlan').value,
        cdk_code: $('manualCdk').value.trim(),
        session: $('manualSession').value, authorized: $('manualAuthorized').checked
    });
    $('manualRetryId').value = '';
    $('manualSession').value = ''; $('manualSessionFile').value = ''; $('manualAuthorized').checked = false;
    notice(`订单 ${data.order.client_order_no} 已受理；请查询原订单确认结果。`, 'success');
    diagFollow(data.order.client_order_no);
    await selectView('diagnostics/trace');
    await diagReadLogs();
});
form('apiForm', async () => { const result = await request('/api/admin/gpt-api', apiInput()); notice(result.message, 'success'); await loadApi(); });
const diagnosticLines = [];
function appendDiagnosticLog(line) {
    diagnosticLines.unshift(`[${new Date().toLocaleString('zh-CN')}] ${line}`);
    diagnosticLines.length = Math.min(diagnosticLines.length, 100);
    $('diagnosticLog').textContent = diagnosticLines.join('\n') || '尚无调试记录。';
}
function appendPlatformChecks(checks, target = '') {
    for (const check of Array.isArray(checks) ? checks : []) {
        if (!check || typeof check !== 'object') continue;
        const path = /^\/api\/open\/v1\/[A-Za-z]+$/.test(check.path || '') ? check.path : '/api/open/v1/unknown';
        const status = check.http_status == null ? '无响应' : `HTTP ${check.http_status}`;
        const code = check.platform_code == null ? '' : ` / code ${check.platform_code}`;
        const plan = check.plan_type ? ` / ${check.plan_type}` : '';
        appendDiagnosticLog(`平台 ${check.success ? '成功' : '失败'} ${target}${path}${plan} · ${status}${code} · ${check.elapsed_ms ?? '—'} ms${check.error ? ` · ${String(check.error).slice(0, 160)}` : ''}`);
    }
}
async function diagnosticFetch(path, body) {
    const method = body === undefined ? 'GET' : 'POST', started = performance.now();
    appendDiagnosticLog(`请求 ${method} ${path}`);
    try {
        const data = await request(path, body);
        appendDiagnosticLog(`完成 ${method} ${path} · HTTP 200 · ${Math.round(performance.now() - started)} ms`);
        appendPlatformChecks(data.checks, data.target || '');
        return data;
    } catch (error) {
        appendDiagnosticLog(`失败 ${method} ${path} · ${error.httpStatus ? `HTTP ${error.httpStatus}` : '网络/响应异常'} · ${Math.round(performance.now() - started)} ms · ${error.message}`);
        appendPlatformChecks(error.checks, error.target || '');
        throw error;
    }
}
async function runDiagnostic(buttonId, outputId, action) {
    const button = $(buttonId), output = $(outputId);
    button.disabled = true; output.className = 'diagnostic-output'; output.textContent = '正在查询平台接口…';
    try { const result = await action(output); output.innerHTML = typeof result === 'string' ? result : result.html;
        output.className = `diagnostic-output ${typeof result === 'object' && result.warning ? 'warning' : 'success'}`; }
    catch (error) { output.textContent = `查询失败：${error.message}`; output.className = 'diagnostic-output error'; }
    finally { button.disabled = false; }
}
function checkedAt() { return escapeHtml(new Date().toLocaleString('zh-CN')); }
function planItems(plans) {
    return (plans || []).map(plan => `<li>${escapeHtml(plan.name || plan.type)} <code>${escapeHtml(plan.type)}</code></li>`).join('') || '<li>平台未返回已启用套餐</li>';
}
$('testApi').onclick = () => runDiagnostic('testApi', 'testResult', async () => {
    const data = await diagnosticFetch('/api/admin/gpt-api/test', { base_url: $('baseUrl').value.trim() });
    const balance = data.balance?.available_balance;
    return {html:`<strong>连接成功 · ${checkedAt()}</strong><p>目标：<code>${escapeHtml(data.target || '')}</code></p><p>套餐读取成功：${escapeHtml((data.plans || []).length)} 项</p><ul>${planItems(data.plans)}</ul><p>账户可用余额：${balance == null ? escapeHtml(data.balance_error || '查询失败') : `${escapeHtml(balance)} USD`}</p>`,warning:balance == null};
});
$('loadCatalog').onclick = () => runDiagnostic('loadCatalog', 'catalog', async () => {
    const data = await diagnosticFetch('/api/admin/gpt-api/status');
    const balance = data.balance?.available_balance;
    return {html:`<strong>查询完成 · ${checkedAt()}</strong><p>账户可用余额：${balance == null ? escapeHtml(data.balance_error || '查询失败') : `${escapeHtml(balance)} USD`}</p><ul>${planItems(data.plans)}</ul>`,warning:balance == null};
});
$('loadRegions').onclick = () => runDiagnostic('loadRegions', 'regionResult', async output => {
    const regions = {};
    for (const [index, plan] of Object.keys(cardPlans).entries()) {
        output.textContent = `正在查询地区 ${index + 1}/4：${cardPlans[plan]}…`;
        try {
            const data = await diagnosticFetch(`/api/admin/orbitcard/payment-regions?plan=${plan}`);
            regions[plan] = data.regions?.[plan] || { options: [], error: '平台未返回该套餐地区' };
            appendPlatformChecks([regions[plan].trace], savedBaseUrl);
        } catch (error) { regions[plan] = { options: [], error: error.message }; }
    }
    const rows = Object.entries(cardPlans).flatMap(([plan,label]) => {
        const result=regions[plan];
        return (result.options?.length ? result.options : [null]).map(item => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(item ? regionLabel(item.code) : '—')}</td><td>${item?.default ? '是' : '否'}</td><td>${escapeHtml(result.error || '可用')}</td></tr>`);
    }).join('');
    return { html: `<strong>地区查询完成 · ${checkedAt()}</strong><div class="table-wrap"><table><thead><tr><th>套餐</th><th>地区</th><th>平台默认</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>`, warning: Object.values(regions).some(result=>result.error) };
});
$('clearDiagnosticLog').onclick = () => { diagnosticLines.length = 0; $('diagnosticLog').textContent = '尚无调试记录。'; };
$('refreshPaymentRegions').onclick = () => perform(loadPaymentRegions);
for (const plan of Object.keys(cardPlans)) $(`paymentRegion_${plan}`).addEventListener('change', () => {
    $('paymentRegionState').textContent = '地区选择已更改，请点击下方“保存配置”后生效。';
});
$('refreshCardIds').onclick = () => perform(loadCardIdPreview);
$('loadCards').onclick = () => perform(loadCards);
$('loadTransactions').onclick = () => perform(loadCardTransactions);
$('syncCards').onclick = () => perform(synchronizeCards);
$('loadProducts').onclick = () => perform(async () => { const data = await request('/api/admin/orbitcard/products'); $('products').textContent = JSON.stringify({ automatic_application:data.automatic_application, application_error:data.application_error, products:data.products }, null, 2); });
$('refreshIssues').onclick = () => perform(async () => { notice((await request('/api/admin/orbitcard/issues/refresh', {})).message, 'success'); await loadCards(); });
form('applyCardForm', async () => { try { notice((await request('/api/admin/orbitcard/cards/apply', {})).message, 'success'); } finally { await loadCards(); } });
form('configForm', async () => { const result = await request('/api/admin/config', { max_concurrent_activations: Number($('maxConcurrent').value), maintenance_mode: $('maintenance').checked }); notice(result.message, 'success'); });
form('twofaModeForm', async () => { const result = await request('/api/admin/security/2fa-mode', { mode: $('twofaMode').value }); notice(result.message, 'success'); await loadSecurity(); });
$('setupTotp').onclick = () => perform(async () => { const data = await request('/api/admin/2fa/setup', {}); $('totpSecret').hidden = false; $('totpSecret').textContent = `请在 Authenticator 中手工添加密钥：\n${data.secret}\n\n${data.otpauthUrl}`; });
form('confirmTotp', async () => { const data = await request('/api/admin/2fa/confirm', { code: $('totpCode').value }); $('totpSecret').textContent = ''; $('totpSecret').hidden = true; $('totpCode').value = ''; notice(data.message, 'success'); await loadSecurity(); });
form('disableTotp', async () => { const data = await request('/api/admin/2fa/disable', { currentPassword: $('disablePassword').value, code: $('disableCode').value }); $('disablePassword').value = ''; $('disableCode').value = ''; notice(data.message, 'success'); await loadSecurity(); });
form('passwordForm', async () => { await request('/api/admin/change-password', { currentPassword: $('oldPassword').value, newPassword: $('newPassword').value }); logout(); });
form('emailForm', async () => { await request('/api/admin/change-email', { email: $('newEmail').value, currentPassword: $('emailPassword').value }); logout(); });
form('secondaryForm', async () => { const data = await request('/api/admin/change-secondary-password', { currentPassword: $('oldSecondary').value, newPassword: $('newSecondary').value }); $('oldSecondary').value = ''; $('newSecondary').value = ''; localStorage.removeItem(SECONDARY_KEY); $('unlockState').textContent = '请重新解锁'; notice(data.message, 'success'); });
form('pathsForm', async () => { const data = await request('/api/admin/security/paths', { loginPath: $('loginPath').value, panelPath: $('panelPath').value }); location.assign(data.panelUrl); });
form('telegramForm', async () => { const data = await request('/api/admin/telegram', { bot_token: $('botToken').value, admin_chat_id: $('adminChat').value, group_chat_id: $('groupChat').value, notify_admin: $('notifyAdmin').checked, notify_group: $('notifyGroup').checked, on_success: $('onSuccess').checked, on_failure: $('onFailure').checked }); $('botToken').value = ''; notice(data.message, 'success'); await loadOverview(); });
$('testTelegram').onclick = () => runDiagnostic('testTelegram', 'telegramTestResult', async () => (await diagnosticFetch('/api/admin/telegram/test', {})).message);
$('loadLoginLogs').onclick = () => perform(loadLoginLogs);
$('loadCdks').onclick = () => perform(loadCdks); $('loadLogs').onclick = () => perform(loadLogs);
$('exportCdks').onclick = () => perform(exportCdks);
$('cdkStatusForm').addEventListener('submit', event => { event.preventDefault(); perform(saveCdkStatus); });
$('cancelCdkStatus').onclick = () => { if (!cdkStatusSaving) { $('cdkStatusDialog').close(); cdkEditing = null; } };
$('cdkStatusDialog').addEventListener('cancel', event => { if (cdkStatusSaving) event.preventDefault(); else cdkEditing = null; });
for (const id of ['cdkStatusFilter', 'cdkShippedFilter']) $(id).addEventListener('change', () => perform(loadCdks));
$('cdkFilters').addEventListener('click', event => {
    const button = event.target.closest('[data-cdk-plan]');
    if (!button || !(button.dataset.cdkPlan === '' || Object.hasOwn(cdkPlans, button.dataset.cdkPlan) || Object.hasOwn(cardPlans, button.dataset.cdkPlan))) return;
    cdkPlanFilter = button.dataset.cdkPlan;
    for (const item of $('cdkFilters').querySelectorAll('button')) {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
    }
    $('exportCdks').disabled = true;
    perform(loadCdks);
});
$('clearLogs').onclick = () => perform(async () => { await request('/api/admin/runtime-logs/clear', {}); await loadLogs(); notice('显示缓存已清空，磁盘日志保留最近 15 天', 'success'); });
let orderEditing = null, orderStatusSaving = false;
function editOrderStatus(button) {
    if (orderStatusSaving) return;
    orderEditing = { jobKey: button.dataset.editOrder, status: button.dataset.orderStatus };
    $('orderStatusCode').textContent = orderEditing.jobKey;
    $('orderEditStatus').value = ['success', 'failed'].includes(orderEditing.status) ? orderEditing.status : '';
    $('orderStatusReason').value = '';
    $('orderStatusError').textContent = '';
    $('orderStatusDialog').showModal();
}
async function saveOrderStatus() {
    if (!orderEditing || orderStatusSaving) return;
    orderStatusSaving = true;
    $('orderStatusFields').disabled = true;
    $('orderStatusError').textContent = '';
    try {
        const result = await request(`/api/admin/orders/${encodeURIComponent(orderEditing.jobKey)}/status`, {
            status: $('orderEditStatus').value, expected_status: orderEditing.status, reason: $('orderStatusReason').value.trim()
        });
        $('orderStatusDialog').close();
        orderEditing = null;
        notice(result.message, 'success');
        try { await loadOverview(); }
        catch (error) { notice(`结果已保存，但列表刷新失败：${error.message}`, 'error'); }
    } catch (error) { $('orderStatusError').textContent = error.message; }
    finally { orderStatusSaving = false; $('orderStatusFields').disabled = false; }
}
$('orderStatusForm').addEventListener('submit', event => { event.preventDefault(); saveOrderStatus(); });
$('cancelOrderStatus').onclick = () => { if (!orderStatusSaving) $('orderStatusDialog').close(); };
$('orderStatusDialog').addEventListener('cancel', event => { if (orderStatusSaving) event.preventDefault(); });
document.addEventListener('click', event => {
    const editOrder = event.target.closest('[data-edit-order]');
    if (editOrder) editOrderStatus(editOrder);
    const retryManual = event.target.closest('[data-retry-manual]');
    if (retryManual) {
        const order = manualOrders.find(item => item.request_id === retryManual.dataset.retryManual);
        if (order && ['preparing','retry_waiting'].includes(order.state)) {
            perform(async () => {
                if (order.mode === 'test') { await diagResumeOrder(order); return; }
                await selectView('manual');
                $('manualRetryId').value = order.request_id;
                $('manualPlan').value = order.plan_type;
                $('manualCdk').value = order.cdk_code || '';
                $('manualSession').value = ''; $('manualSessionFile').value = ''; $('manualAuthorized').checked = false;
                notice(`已载入原请求 ${order.request_id}；重新上传该账号 Session 后继续，不能创建新的订单。`, 'success');
                $('manualSession').focus();
            });
        }
    }
    const download = event.target.closest('[data-download-manual],[data-download-audit]');
    if (download) perform(() => downloadAudit(download.dataset.downloadManual || download.dataset.downloadAudit,
        download.dataset.downloadManual ? 'manual' : 'task'));
    const refreshManual = event.target.closest('[data-refresh-manual]');
    if (refreshManual) perform(async () => {
        refreshManual.disabled = true;
        try {
            await request(`/api/admin/manual/orders/${encodeURIComponent(refreshManual.dataset.refreshManual)}/refresh`, {});
            await loadManualOrders();
            notice('已查询管理员原订单', 'success');
        } finally { refreshManual.disabled = false; }
    });
    const transactions = event.target.closest('[data-card-transactions]');
    if (transactions) { $('transactionCardId').value = transactions.dataset.cardTransactions; $('transactionPage').value = '1'; $('loadTransactions').click(); }
    const refresh = event.target.closest('[data-refresh-order]');
    if (refresh) perform(async () => { refresh.disabled = true; try { await request(`/api/admin/orders/${encodeURIComponent(refresh.dataset.refreshOrder)}/refresh`, {}); await loadOverview(); notice('已查询原订单', 'success'); } finally { refresh.disabled = false; } });
    const changeStatus = event.target.closest('[data-cdk-status]');
    if (changeStatus) editCdkStatus(changeStatus);
    const remove = event.target.closest('[data-delete-cdk]');
    if (remove && confirm(`确定删除未使用的卡密 ${remove.dataset.deleteCdk}？`)) perform(async () => { await request(`/api/admin/cdks/${encodeURIComponent(remove.dataset.deleteCdk)}`, undefined, 'DELETE'); await loadCdks(); });
});
perform(async () => {
    if (localStorage.getItem(SECONDARY_KEY)) $('unlockState').textContent = '验证已保存';
    const paths = await (await fetch('/api/public/admin-paths')).json(); if (paths.success) loginUrl = paths.loginUrl;
    const session = await request('/api/admin/session'); if (session.token) localStorage.setItem(TOKEN_KEY, session.token);
    await Promise.all([loadOverview(), loadSecurity()]);
    const initialView = location.hash.slice(1);
    if (initialView && initialView !== 'overview') selectView(initialView);
});
setInterval(async () => {
    if (document.hidden || !(selected === 'overview' || (selected === 'diagnostics' && selectedDiagnostic === 'runtime')) || autoRefreshBusy || !autoRefreshStarted) return;
    if (Date.now() - autoRefreshStarted >= 15 * 60 * 1000 || autoRefreshFailures >= 5) {
        autoRefreshStarted = 0;
        notice('自动刷新已暂停，点击刷新按钮可继续。');
        return;
    }
    autoRefreshBusy = true;
    try { await loadSelected(); autoRefreshFailures = 0; }
    catch (_) { autoRefreshFailures++; }
    finally { autoRefreshBusy = false; }
}, 15000);
