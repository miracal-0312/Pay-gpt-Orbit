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
let manualQueuedRequest = '';
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
const PAYMENT_QUEUE_FULL_MESSAGE = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';
const shownQueueFailures = new Set();
function showPaymentQueueFull(data, key = '') {
    if (data?.error_code !== 'PAYMENT_QUEUE_FULL') return false;
    if (key && shownQueueFailures.has(key)) return true;
    if (key) shownQueueFailures.add(key);
    $('paymentQueueMessage').textContent = PAYMENT_QUEUE_FULL_MESSAGE;
    if (!$('paymentQueueDialog').open) $('paymentQueueDialog').showModal();
    return true;
}
function reportError(error) {
    notice(error.error_code === 'PAYMENT_QUEUE_FULL' ? PAYMENT_QUEUE_FULL_MESSAGE : error.message, 'error');
    showPaymentQueueFull(error);
}
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
        if (data.secondaryRequired) {
            localStorage.removeItem(SECONDARY_KEY); $('unlockState').textContent = '请重新验证二级密码';
            if (typeof lockEmailNotificationForm === 'function') lockEmailNotificationForm();
        }
        const error = new Error(data.message || `请求失败（${response.status}）`);
        error.httpStatus = response.status;
        error.error_code = data.error_code;
        error.retry_after_seconds = data.retry_after_seconds;
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
    catch (error) { reportError(error); return null; }
}
function status(value) { const text = { success: '成功', failed: '失败', rejected: '未受理（已释放）', retry: '待重新提交 Session', retry_waiting: '等待换卡重试', running: '处理中', preparing: '准备支付', funding_waiting: '等待补款到账', funding_review: '补款对账工单（后台跟进）', funding_pending: '补款待核对（支付已停止）', card_pending: '原开卡待确认（支付已停止）', prepared: '资金已就绪', submitting: '提交中', manual: '人工处理（支付已停止）', support_locked: '人工售后（支付已停止）', pending: '待确认', unused: '未使用', used: '已使用', redeemed: '已核销', processing: '占用中' }[value] || value; return `<span class="pill ${escapeHtml(value)}">${escapeHtml(text)}</span>`; }
function renderTasks(tasks) {
    $('tasks').innerHTML = tasks.map(task => {
        const order = task.order || {}, fee = order.fee_status ? `${order.service_fee ?? '—'} ${order.currency || 'USDT'} / ${order.fee_status}` : '—';
        const payment = order.payment ? `${order.payment.amount} ${order.payment.currency}` : '—';
        const businessResult = ['success', 'failed'].includes(task.manual_result) ? task.manual_result
            : task.business_status === 'closed' && ['success', 'failed'].includes(task.business_result) ? task.business_result : '';
        const closed = Boolean(businessResult) || task.business_status === 'closed';
        const originalState = !closed && task.queued ? '<span class="pill">排队等待</span>' : status(task.orbitcard_state || task.status);
        const outcome = (closed ? `<div><strong class="pill">已关闭${businessResult ? `（人工${businessResult === 'success' ? '成功' : '失败'}）` : ''}</strong></div><details><summary>原资金核对记录</summary>${originalState}<div>${escapeHtml(task.message)}</div></details>`
            : `<div>原平台／资金状态：${originalState}</div>${escapeHtml(task.message)}`) + (task.manual_local_released_at ? '<div>本地占用：已释放</div>' : '');
        const refresh = (task.provider === 'orbitcard' ? `<button class="secondary" data-refresh-order="${escapeHtml(task.jobKey)}">${closed ? '核对原记录' : ['funding_waiting','funding_review','funding_pending'].includes(task.orbitcard_state) ? '核对原补款' : '查原单'}</button>` : '<small>历史记录</small>')
            + ` <button type="button" class="secondary" data-order-manual="${escapeHtml(task.jobKey)}" data-order-kind="task">人工修改</button>`;
        const cardLabel = task.card_id || (task.provider !== 'orbitcard' ? '历史未绑定'
            : ['preparing','prepared','rejected','balance_blocked','card_pending'].includes(task.orbitcard_state) ? '尚未分配支付卡' : '未记录支付卡');
        return `<tr><td>${escapeHtml(task.time)}<br><code>${escapeHtml(task.cdk)}</code></td><td>${escapeHtml(task.provider === 'orbitcard' ? task.token : '历史账号')}<br><code>${escapeHtml(task.order_id || task.client_order_no || task.jobKey)}</code><br>卡 ID：${escapeHtml(cardLabel)}</td><td>${outcome}</td><td>${escapeHtml(fee)}</td><td>${escapeHtml(payment)}</td><td>${refresh} <button class="secondary" data-download-audit="${escapeHtml(task.jobKey)}">下载日志</button> <button class="secondary" data-debug-trace="${escapeHtml(task.jobKey)}">链路日志</button></td></tr>`;
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
function lockEmailNotificationForm() {
    $('emailNotificationFields').disabled = true;
    $('smtpPassword').value = '';
    $('emailNotificationState').textContent = '请先验证二级密码，再读取邮件配置。';
}
function renderEmailNotificationConfig(config = {}) {
    for (const [id, key] of [['emailEnabled','enabled'],['emailLowBalance','on_low_balance'],['emailSuccess','on_success'],['emailFailure','on_failure']]) {
        $(id).checked = Boolean(config[key]);
    }
    for (const [id, key] of [['smtpHost','smtp_host'],['smtpUser','smtp_user'],['emailFrom','from_email'],['emailTo','to_email']]) $(id).value = config[key] || '';
    $('smtpPort').value = config.smtp_port || 465;
    $('smtpSecurity').value = config.smtp_secure === false ? 'starttls' : 'tls';
    $('smtpPassword').value = ''; $('smtpClearPassword').checked = false;
    $('smtpPasswordState').textContent = config.smtp_password_error ? '已保存密码无法解密，请重新填写后保存'
        : config.smtp_password_saved ? '密码已保存，留空保持不变' : '未配置密码';
    $('emailBalanceThreshold').value = config.balance_threshold ?? '50.00';
    $('emailBalanceCooldown').value = config.balance_cooldown_minutes ?? 360;
    $('emailNotificationFields').disabled = false;
    $('emailNotificationState').textContent = config.enabled ? '自动邮件通知已启用。' : '自动邮件通知未启用。填写配置后可先发送测试邮件。';
}
function renderEmailNotificationHistory(history = []) {
    const names = { low_balance: '账户低余额', order_success: '订阅成功', order_failure: '充值失败', order_review: '充值未完成，需人工处理' };
    const states = { pending: '等待发送', sent: '已发送', failed: '发送失败' };
    $('emailNotificationRows').innerHTML = history.map(row => `<tr><td>${escapeHtml(row.created_at)}<br>${escapeHtml(names[row.event_type] || row.event_type)}</td><td>${escapeHtml(row.target_email)}</td><td>${escapeHtml(states[row.status] || row.status)} / ${escapeHtml(row.attempts)}</td><td>${escapeHtml(row.delivered_at || '—')}<br>${escapeHtml(row.last_error || '')}</td></tr>`).join('')
        || '<tr><td colspan="4">暂无邮件通知记录</td></tr>';
}
async function loadEmailNotifications() {
    if (!localStorage.getItem(SECONDARY_KEY)) { lockEmailNotificationForm(); return; }
    const data = await request('/api/admin/email-notifications');
    renderEmailNotificationConfig(data.config);
    renderEmailNotificationHistory(data.history || []);
}
function emailNotificationInput() {
    return { enabled: $('emailEnabled').checked, smtp_host: $('smtpHost').value.trim(), smtp_port: Number($('smtpPort').value),
        smtp_secure: $('smtpSecurity').value === 'tls', smtp_user: $('smtpUser').value.trim(), smtp_password: $('smtpPassword').value,
        clear_password: $('smtpClearPassword').checked, from_email: $('emailFrom').value.trim(), to_email: $('emailTo').value.trim(),
        on_low_balance: $('emailLowBalance').checked, on_success: $('emailSuccess').checked, on_failure: $('emailFailure').checked,
        balance_threshold: $('emailBalanceThreshold').value.trim(), balance_cooldown_minutes: Number($('emailBalanceCooldown').value) };
}
async function saveEmailNotifications() {
    const result = await request('/api/admin/email-notifications', emailNotificationInput());
    renderEmailNotificationConfig(result.config);
    notice(result.message, 'success');
}
async function testEmailNotifications() {
    const button = $('testEmailNotifications');
    if (button.disabled) return;
    button.disabled = true;
    $('emailTestResult').textContent = '正在向已保存的管理员邮箱发送测试邮件…';
    try {
        const result = await request('/api/admin/email-notifications/test', {});
        $('emailTestResult').textContent = result.message;
        notice(result.message, 'success');
    } catch (error) {
        $('emailTestResult').textContent = error.message;
        reportError(error);
    } finally { button.disabled = false; }
}
async function loadApi() {
    const { config } = await request('/api/admin/gpt-api');
    savedBaseUrl = config.base_url;
    $('apiEnabled').checked = config.enabled; $('baseUrl').value = config.base_url;
    renderOpeningChoices([], config.orbitcard_product_codes ?? (config.orbitcard_product_code ? [config.orbitcard_product_code] : []), config.orbitcard_bins || []);
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
        await Promise.all([loadCardIdPreview(), loadPaymentRegions(), loadOpeningProducts()]);
    } else {
        $('cardIdPreview').textContent = '请先在服务器环境变量中配置配对的 API Key 和 API Secret。';
        $('paymentRegionState').textContent = '请先配置平台凭据；已有地区设置会保留。';
        $('refreshPaymentRegions').disabled = false;
    }
}
let openingProducts = [], openingProductsSequence = 0;
function selectedOpeningValues(id) {
    return Array.from($(id).selectedOptions, option => option.value);
}
function renderOpeningChoices(products, selectedProducts, selectedBins) {
    function fill(id, choices, selectedValues) {
        const select = $(id);
        select.replaceChildren();
        const labels = new Map(choices.map(choice => [choice.value, choice.label]));
        for (const value of selectedValues) if (!labels.has(value)) labels.set(value, `${value}（已选，当前目录未返回）`);
        for (const [value, label] of labels) {
            const option = new Option(label, value);
            option.selected = selectedValues.includes(value);
            select.add(option);
        }
    }
    fill('productCodes', products.map(product => ({ value: product.product_code,
        label: [product.product_code, product.network, product.issuing_area, product.bin ? `BIN ${product.bin}` : ''].filter(Boolean).join(' · ') })), selectedProducts);
    const matching = products.filter(product => !selectedProducts.length || selectedProducts.includes(product.product_code));
    fill('cardBins', [...new Set(matching.map(product => product.bin).filter(Boolean))].sort().map(bin => ({ value: bin, label: bin })), selectedBins);
}
async function loadOpeningProducts() {
    const sequence = ++openingProductsSequence, button = $('refreshOpeningProducts');
    button.disabled = true;
    $('openingProductsState').textContent = '正在从已保存的卡台读取开卡渠道与卡段…';
    try {
        const data = await request('/api/admin/orbitcard/products');
        if (sequence !== openingProductsSequence) return;
        openingProducts = data.products || [];
        const codes = selectedOpeningValues('productCodes'), bins = selectedOpeningValues('cardBins');
        renderOpeningChoices(openingProducts, codes, bins);
        const matching = openingProducts.filter(product => (!codes.length || codes.includes(product.product_code)) && (!bins.length || bins.includes(product.bin)));
        $('openingProductsState').textContent = `已读取 ${openingProducts.length} 个渠道、${data.bins.length} 个卡段；当前匹配 ${matching.length} 个产品。按住 Ctrl 或 Command 可多选，分别留空表示全部，同时选择取交集。选择后点击“保存配置”。`;
    } catch (error) {
        if (sequence === openingProductsSequence) $('openingProductsState').textContent = `读取失败，已保留当前选择：${error.message}`;
    } finally { if (sequence === openingProductsSequence) button.disabled = false; }
}
$('refreshOpeningProducts').onclick = () => perform(loadOpeningProducts);
$('productCodes').addEventListener('change', () => renderOpeningChoices(openingProducts, selectedOpeningValues('productCodes'), selectedOpeningValues('cardBins')));
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
        $('cardIdPreview').textContent = `平台共 ${data.total} 张卡，平台状态正常 ${data.active} 张。${ids.length ? `前 ${ids.length} 张：${ids.join('、')}` : '当前没有卡片，请手动申请或核对停用卡的补开记录。'}`;
    } catch (error) { $('cardIdPreview').textContent = `卡片 ID 读取失败：${error.message}`; }
}
function apiInput() {
    return { enabled: $('apiEnabled').checked, base_url: $('baseUrl').value.trim(),
    orbitcard_product_codes: selectedOpeningValues('productCodes'), orbitcard_bins: selectedOpeningValues('cardBins'),
    orbitcard_max_initial_amount: $('maxInitialAmount').value.trim(),
    orbitcard_payment_regions: Object.fromEntries(Object.keys(cardPlans).map(plan => [plan, $(`paymentRegion_${plan}`).value])),
    orbitcard_plan_prices: Object.fromEntries(Object.keys(cardPlans).map(plan => [plan, $(`planPrice_${plan}`).value.trim()])),
    orbitcard_max_fee: $('maxFee').value.trim() };
}
function renderCardRow(card, sync = null) {
    const id = escapeHtml(card.card_id);
    const usage = `${escapeHtml(card.successful_order_count ?? '待同步')} 笔成功会员订单 / 上限 ${escapeHtml(card.max_successful_orders || 3)} 笔`;
    const history = card.disabled_at ? `已停用 · ${escapeHtml(card.disabled_code || '')}<br>${escapeHtml(card.disabled_reason || '订阅卡片错误')}`
        : card.retiring ? (card.provider_status === 'DELETED' ? '已删卡，补开结果见开卡记录' : '待确认删卡')
            : Number(card.successful_order_count) >= 3 ? '已达三次上限，停止使用，等待删卡补开' : '最多成功支付三次，满额后自动删卡补开';
    const countedAt = '授权流水仅供对账，不影响订单计数';
    const last4 = card.last4 ? `****${escapeHtml(card.last4)}` : '尾号未提供';
    const confirmed = sync?.synced_ids?.includes(Number(card.card_id));
    const snapshot = confirmed ? `本次同步：${sync.checked_at}` : sync?.failed ? '同步失败 · 以下为旧快照'
        : sync?.failed_ids?.includes(Number(card.card_id)) ? '详情读取失败 · 以下为旧快照'
            : sync?.listed_ids && !sync.listed_ids.includes(Number(card.card_id)) ? '本次平台列表未返回 · 以下为旧快照' : '本地快照 · 未实时查询';
    const labels = { ACTIVE: '正常（ACTIVE）', CANCELLED: '冻结（CANCELLED）', DELETED: '已删除（DELETED）' };
    const active = confirmed && card.provider_status === 'ACTIVE' && !card.disabled_at && !card.retiring;
    return `<tr><td><strong class="card-id">${id}</strong><span class="card-meta">${last4}</span><span class="card-meta">${escapeHtml(card.product_code || '产品未知')}</span></td><td><span class="card-meta">${escapeHtml(snapshot)}</span><span class="card-provider-status${active ? ' active' : ''}">${escapeHtml(labels[card.provider_status] || card.provider_status || '未知状态')}</span><span class="card-balance">${escapeHtml(card.balance ?? '未知')} ${escapeHtml(card.currency || '')}</span></td><td><div class="card-usage-list">${usage}</div><span class="card-meta">${countedAt}</span></td><td>${card.active_job ? `<code>${escapeHtml(card.active_job)}</code>` : '<span class="card-idle">空闲</span>'}</td><td><div class="card-row-actions">${history}<button type="button" data-card-availability="${id}" data-disable="${!card.disabled_at}" class="secondary"${card.active_job || card.retiring ? ' disabled' : ''}>${card.disabled_at ? '恢复使用' : '人工停用'}</button><button type="button" data-card-transactions="${id}" class="secondary">查看交易</button></div></td></tr>`;
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
            : '状态、余额和成功会员订单次数为本地快照，点击“同步卡片与订单”更新。“刷新本地记录”不会调用平台；API 不可见的网页订单不计入，授权流水仅供对账。';
    $('issueRows').innerHTML = data.issues.map(issue => `<tr><td>${escapeHtml(issue.created_at)}<br><code>${escapeHtml(issue.issue_key)}</code></td><td>${escapeHtml(issue.product_code)}<br>${escapeHtml(issue.amount)}</td><td>${issue.job_key ? escapeHtml(cardPlans[issue.plan_type] || issue.plan_type) : '共享卡池'} / ${escapeHtml(issue.state)}<br>${escapeHtml(issue.provider_status || '')}<br>${escapeHtml(issue.message)}</td><td>${escapeHtml(issue.order_no || '待返回')}<br>${escapeHtml(issue.card_id || '待返回')}</td></tr>`).join('') || '<tr><td colspan="4">暂无开卡申请</td></tr>';
    $('fundingRows').innerHTML=(data.fundings || []).map(funding => `<tr><td>${escapeHtml(funding.created_at)}<br><code>${escapeHtml(funding.job_key)}</code></td><td>${escapeHtml(funding.card_id)}<br>${escapeHtml(funding.amount)} USD</td><td>${escapeHtml(funding.state)} / ${escapeHtml(funding.provider_status)}<br>${escapeHtml(funding.order_no || funding.funding_key)}<br>${escapeHtml(funding.message)}</td><td>${escapeHtml(funding.fee_snapshot || '待确认')}<br>支付前要求余额：${escapeHtml(funding.target_balance)}</td></tr>`).join('') || '<tr><td colspan="4">暂无卡片补款</td></tr>';
}
async function loadCardTransactions() {
    const id = Number($('transactionCardId').value), page = Number($('transactionPage').value);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(page) || page < 1) throw new Error('请输入有效卡 ID 和页码');
    $('loadTransactions').disabled = true;
    $('cardTransactions').textContent = '正在读取消费授权流水，仅供对账…';
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
    $('cardSyncState').textContent = '正在同步卡片信息和卡台成功会员订单…';
    let result;
    try {
        result = await request('/api/admin/orbitcard/cards/sync', {});
        await loadCards(result);
        notice(result.message, result.failed_ids.length ? 'error' : 'success');
    } catch (error) {
        if (result) {
            const message = `${result.message}；本地列表刷新失败：${error.message}。请点击“刷新本地记录”，当前列表未更新。`;
            $('cardSyncState').textContent = message;
            notice(message, 'error');
            return;
        }
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
async function applyCard() {
    const state = $('cardApplicationState');
    state.textContent = '正在处理开卡申请，请等待原申请结果…';
    let result, applicationError;
    try {
        result = await request('/api/admin/orbitcard/cards/apply', {});
        state.textContent = result.message;
    } catch (error) {
        applicationError = error;
        state.textContent = `开卡申请未确认成功：${error.message}。请先查看开卡申请记录，待确认时使用“确认原开卡 / 补款”查询原申请。`;
    }
    try { await loadCards(); }
    catch (error) {
        state.textContent += ` 本地记录刷新失败：${error.message}。请点击“刷新本地记录”。`;
        $('cardSyncState').textContent = '本地记录刷新失败，当前列表未更新；开卡结果请查看“申请卡片”。';
    }
    if (applicationError) throw applicationError;
    notice(state.textContent, 'success');
    return result;
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
    $('cdkRows').innerHTML = codes.map(code => `<tr><td><code>${escapeHtml(code.code)}</code></td><td>${escapeHtml(code.plan_label || code.plan_type)}</td><td>${status(code.status)}${code.manual_redeemed_at ? `<br>人工售后核销<br>${escapeHtml(code.manual_redeemed_by)} · ${escapeHtml(code.manual_redeemed_at)}<br>${escapeHtml(code.manual_redemption_reason)}` : code.orbitcard_support_locked ? code.order_business_status === 'closed' ? '<br>订单已关闭；CDK保留售后占用' : '<br>支付失败，已锁定；请人工售后' : code.orbitcard_balance_blocked ? '<br>账户余额不足，CDK 已锁定' : code.orbitcard_pending_confirmation ? '<br>结果待确认' : ''}</td><td>${code.shipped ? '已出库' : '未出库'}</td><td><button type="button" class="secondary" data-cdk-status="${escapeHtml(code.code)}" data-cdk-state="${escapeHtml(code.status)}" data-cdk-shipped="${code.shipped}">修改状态</button>${!code.shipped && code.status === 'unused' ? `<button class="danger" data-delete-cdk="${escapeHtml(code.code)}">删除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">暂无卡密</td></tr>';
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
    if (selected === 'settings') await Promise.all([loadOverview(), loadSecurity(), loadEmailNotifications()]);
    if (selected === 'cdks' && localStorage.getItem(SECONDARY_KEY)) { await loadCdkPlans().catch(error => { cdkPlans = {}; notice(`套餐目录读取失败：${error.message}`, 'error'); }); await loadCdks(); }
    if (selected === 'manual' && localStorage.getItem(SECONDARY_KEY)) {
        await Promise.all([loadManualCatalog(), loadManualOrders()]);
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
let cardAvailabilityEditing = null, cardAvailabilitySaving = false;
function editCardAvailability(button) {
    cardAvailabilityEditing = { cardId: button.dataset.cardAvailability, disabled: button.dataset.disable === 'true' };
    $('cardAvailabilityTitle').textContent = cardAvailabilityEditing.disabled ? '人工停用卡片' : '恢复卡片使用';
    $('cardAvailabilityTarget').textContent = `卡片 ${cardAvailabilityEditing.cardId}`;
    $('cardAvailabilityReason').value = '';
    $('cardAvailabilityError').textContent = '';
    $('cardAvailabilityDialog').showModal();
}
$('cardAvailabilityForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!cardAvailabilityEditing || cardAvailabilitySaving) return;
    cardAvailabilitySaving = true;
    $('cardAvailabilityFields').disabled = true;
    $('cardAvailabilityError').textContent = '';
    try {
        const data = await request(`/api/admin/orbitcard/cards/${encodeURIComponent(cardAvailabilityEditing.cardId)}/availability`, {
            disabled: cardAvailabilityEditing.disabled, reason: $('cardAvailabilityReason').value.trim() });
        $('cardAvailabilityDialog').close();
        cardAvailabilityEditing = null;
        notice(data.message, 'success');
        try { await loadCards(); }
        catch (error) { notice(`状态已保存，列表刷新失败：${error.message}`, 'error'); }
    } catch (error) { $('cardAvailabilityError').textContent = error.message; }
    finally { cardAvailabilitySaving = false; $('cardAvailabilityFields').disabled = false; }
});
$('cancelCardAvailability').onclick = () => { if (!cardAvailabilitySaving) $('cardAvailabilityDialog').close(); };
$('cardAvailabilityDialog').addEventListener('cancel', event => { if (cardAvailabilitySaving) event.preventDefault(); });
document.addEventListener('click', event => {
    const availability = event.target.closest('[data-card-availability]');
    if (availability?.dataset.cardAvailability && !availability.disabled) editCardAvailability(availability);
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
        try { await handler(); } catch (error) { reportError(error); }
        finally {
            submitting = false;
            if (button) {
                button.disabled = id === 'manualForm' && Boolean(manualQueuedRequest);
                if (id === 'manualForm') button.textContent = manualQueuedRequest ? '排队等待，请查询原订单' : '确认扣款并开通';
            }
        }
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
        const businessResult = ['success', 'failed'].includes(order.manual_result) ? order.manual_result
            : order.business_status === 'closed' && ['success', 'failed'].includes(order.business_result) ? order.business_result : '';
        const closed = Boolean(businessResult) || order.business_status === 'closed';
        const originalState = !closed && order.queued ? '<span class="pill">排队等待</span>' : status(order.state);
        const outcome = (closed ? `<div><strong class="pill">已关闭${businessResult ? `（人工${businessResult === 'success' ? '成功' : '失败'}）` : ''}</strong></div><details><summary>原资金核对记录</summary>${originalState}<div>${escapeHtml(order.message || '')}</div></details>`
            : `<div>原平台／资金状态：${originalState}</div>${escapeHtml(order.message || '')}`) + (order.manual_local_released_at ? '<div>本地占用：已释放</div>' : '');
        const previousAttempts = (order.attempts || []).map((attempt, index) => `<button type="button" class="secondary" data-debug-trace="${escapeHtml(attempt.client_order_no)}">第 ${index + 1} 次 · 卡 ${escapeHtml(attempt.card_id)} 日志</button>`).join('');
        const captcha = !closed && order.captcha?.url ? `<br><a href="${escapeHtml(order.captcha.url)}" target="_blank" rel="noopener noreferrer">打开平台验证链接</a>` : '';
        const action = `${!closed && !order.manual_result && !order.queued && ['preparing','retry_waiting'].includes(order.state)
            ? `<button type="button" class="secondary" data-retry-manual="${escapeHtml(order.request_id)}">${order.state === 'retry_waiting' ? '提交 Session 换卡重试' : '继续准备'}</button>` : ''}${closed || order.queued || ['submitting','pending','manual','funding_waiting','funding_review','funding_pending','card_pending'].includes(order.state)
            ? `<button type="button" class="secondary" data-refresh-manual="${escapeHtml(order.request_id)}">${closed ? '核对原记录' : ['funding_waiting','funding_review','funding_pending','card_pending'].includes(order.state) ? '核对原资金' : '查询原订单'}</button>` : ''}
            <button type="button" class="secondary" data-order-manual="${escapeHtml(order.request_id)}" data-order-kind="admin">人工修改</button>
            <button type="button" class="secondary" data-download-manual="${escapeHtml(order.client_order_no)}">下载日志</button> <button type="button" class="secondary" data-debug-trace="${escapeHtml(order.client_order_no)}">链路日志</button>`;
        return `<tr><td>${escapeHtml(new Date(order.created_at).toLocaleString('zh-CN'))}<br>${escapeHtml(order.target_email)}</td>
            <td>${order.mode === 'fulfillment' ? '人工交付' : '测试开通'}<br>${escapeHtml(order.plan_name || order.plan_type)}<br>${order.card_id ? `卡 ${escapeHtml(order.card_id)}` : '待选卡'}${order.cdk_code ? `<br><code>${escapeHtml(order.cdk_code)}</code>` : ''}</td>
            <td><code>${escapeHtml(order.client_order_no)}</code><br><small>请求 ${escapeHtml(order.request_id)}</small>${order.task_no ? `<br><code>${escapeHtml(order.task_no)}</code>` : ''}</td>
            <td>${outcome}<br>第 ${escapeHtml(order.attempt || 1)} / 3 次尝试${captcha}</td><td>${action}<div class="attempt-links">${previousAttempts}</div></td></tr>`;
    }).join('') || '<tr><td colspan="5">暂无管理员订单</td></tr>';
}
async function loadManualOrders() {
    const data = await request('/api/admin/manual/orders');
    manualOrders = data.orders || [];
    renderManualOrders(manualOrders);
    if (manualQueuedRequest) {
        const order = manualOrders.find(item => item.request_id === manualQueuedRequest);
        const closed = order && (['success', 'failed'].includes(order.manual_result) || order.business_status === 'closed');
        if (order && (!order.queued || closed)) {
            if (!closed) showPaymentQueueFull(order, order.request_id);
            manualQueuedRequest = '';
        }
        $('manualSubmit').disabled = Boolean(manualQueuedRequest);
        $('manualSubmit').textContent = manualQueuedRequest ? '排队等待，请查询原订单' : '确认扣款并开通';
    }
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
    if (manualQueuedRequest) throw new Error('当前订单正在排队，请在订单链路中查询原订单。');
    if (!manualCatalog.plans.some(plan => plan.type === $('manualPlan').value)) throw new Error('请选择当前开放的套餐');
    try { JSON.parse($('manualSession').value); } catch (_) { throw new Error('Session 必须是完整 JSON'); }
    const requestId = $('manualRetryId').value.trim() || crypto.randomUUID();
    $('manualRetryId').value = requestId;
    const data = await request('/api/admin/manual/orders', {
        request_id: requestId, mode: 'fulfillment', plan_type: $('manualPlan').value,
        cdk_code: $('manualCdk').value.trim(),
        session: $('manualSession').value, authorized: $('manualAuthorized').checked
    });
    manualQueuedRequest = data.order.queued ? requestId : '';
    $('manualRetryId').value = '';
    $('manualSession').value = ''; $('manualSessionFile').value = ''; $('manualAuthorized').checked = false;
    showPaymentQueueFull(data.order, requestId);
    notice(data.order.queued ? '订单已进入等待队列，系统会自动继续，请勿重复提交。' : `订单 ${data.order.client_order_no} 已受理；请查询原订单确认结果。`, 'success');
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
async function runDiagnosticOutput(outputId, action) {
    const output = $(outputId);
    output.className = 'diagnostic-output'; output.textContent = '正在查询平台接口…';
    try {
        const result = await action(output), failed = Boolean(typeof result === 'object' && (result.failed || result.warning));
        output.innerHTML = typeof result === 'string' ? result : result.html;
        output.className = `diagnostic-output ${failed ? 'error' : 'success'}`;
        return !failed;
    } catch (error) {
        output.textContent = `查询失败：${error.message}`; output.className = 'diagnostic-output error';
        return false;
    }
}
async function runDiagnostic(buttonId, outputId, action) {
    const button = $(buttonId);
    button.disabled = true;
    try { return await runDiagnosticOutput(outputId, action); }
    finally { button.disabled = false; }
}
function renderApiInterfaceRows(rows) {
    $('apiInterfaceRows').innerHTML = rows.map(row => {
        const simulated = row.mode === 'local_simulation';
        const label = { waiting: '等待', running: '测试中', failed: '失败', skipped: '跳过',
            passed: simulated ? '模拟通过' : '查询通过' }[row.status];
        const appearance = { passed: 'success', failed: 'failed', skipped: 'pending', running: 'running' }[row.status] || '';
        const metrics = [row.elapsed_ms == null ? '' : `${row.elapsed_ms} ms`,
            row.http_status == null ? '' : `HTTP ${row.http_status}`,
            row.platform_code == null ? '' : `code ${row.platform_code}`].filter(Boolean).join(' · ');
        const details = row.summary !== undefined || row.checks?.length
            ? `<details><summary>查看安全摘要</summary><pre>${escapeHtml(JSON.stringify({ summary: row.summary, checks: row.checks }, null, 2))}</pre></details>` : '';
        return `<tr><td><strong>${escapeHtml(row.label)}</strong><br><code>${escapeHtml(row.path)}</code></td><td>${simulated ? '本地模拟<br><small>未向平台发送</small>' : '真实只读查询'}</td><td><span class="pill ${appearance}">${label}</span>${metrics ? `<br><small>${escapeHtml(metrics)}</small>` : ''}</td><td>${escapeHtml(row.message || '')}${details}</td></tr>`;
    }).join('');
}
let apiDiagnosticsBusy = false;
async function runAllApiDiagnostics() {
    if (apiDiagnosticsBusy) return;
    apiDiagnosticsBusy = true;
    const button = $('testAllApi'), summary = $('apiTestSummary');
    const counts = { live_read: 0, local_simulation: 0, failed: 0, skipped: 0 };
    const totals = () => `真实查询通过 ${counts.live_read} 项，本地模拟通过 ${counts.local_simulation} 项，失败 ${counts.failed} 项，跳过 ${counts.skipped} 项`;
    button.disabled = true; button.textContent = '正在测试…'; summary.className = 'diagnostic-output';
    summary.textContent = '正在读取全部接口清单…';
    $('apiInterfaceTarget').textContent = '正在读取已保存的测试配置…';
    $('apiInterfaceRows').innerHTML = '<tr><td colspan="4">正在读取本轮接口清单…</td></tr>';
    try {
        const manifest = await diagnosticFetch('/api/admin/orbitcard/diagnostics/interfaces');
        const seen = new Set();
        if (!Array.isArray(manifest.operations) || !manifest.operations.length || manifest.operations.some(item =>
            !item || !/^[A-Za-z]+$/.test(item.operation || '') || item.path !== `/api/open/v1/${item.operation}`
            || !['live_read', 'local_simulation'].includes(item.mode) || seen.has(item.operation) || !seen.add(item.operation))) {
            throw new Error('接口清单无效，未执行测试');
        }
        $('apiInterfaceTarget').textContent = `测试目标：${manifest.target || '已保存的平台配置'}。本轮全部真实查询使用已保存配置。`;
        const rows = manifest.operations.map(item => ({ operation: item.operation, path: item.path,
            label: item.label || item.operation, mode: item.mode, status: 'waiting', message: '等待本轮测试' }));
        let cardId = null;
        renderApiInterfaceRows(rows);
        for (const [index, row] of rows.entries()) {
            row.status = 'running'; row.message = row.mode === 'local_simulation' ? '正在本地验证请求规则，不向平台发送…' : '正在查询平台接口…';
            summary.textContent = `正在测试 ${index + 1}/${rows.length}：${row.label} · ${totals()}。`;
            renderApiInterfaceRows(rows);
            try {
                const body = { operation: row.operation };
                if (cardId && ['cardDetail', 'cardTransaction', 'getCardFlow'].includes(row.operation)) body.card_id = cardId;
                const data = await diagnosticFetch('/api/admin/orbitcard/diagnostics/interface-test', body);
                const result = data.result;
                if (!result || result.operation !== row.operation || result.mode !== row.mode || result.path !== row.path
                    || !['passed', 'failed', 'skipped'].includes(result.status)) throw new Error('接口测试结果与请求不匹配，请查看调试日志');
                Object.assign(row, { status: result.status, message: result.message, elapsed_ms: result.elapsed_ms,
                    http_status: result.http_status, platform_code: result.platform_code, summary: result.summary, checks: result.checks });
                if (row.status === 'passed' && Array.isArray(row.checks) && row.checks.some(check => check?.status === 'failed' || check?.success === false)) {
                    row.status = 'failed'; row.message = '部分接口检查失败，请查看安全摘要。';
                }
                if (row.mode === 'live_read') appendPlatformChecks((Array.isArray(result.checks) ? result.checks : []).map(check => ({
                    ...check, path: row.path, success: check.status === 'passed', error: check.status === 'failed' ? check.message : ''
                })), manifest.target || '');
                if (row.operation === 'getCardList' && row.status === 'passed'
                    && Number.isSafeInteger(result.summary?.selected_card_id) && result.summary.selected_card_id > 0) cardId = result.summary.selected_card_id;
            } catch (error) { row.status = 'failed'; row.message = error.message; }
            if (row.status === 'passed') counts[row.mode]++; else counts[row.status]++;
            appendDiagnosticLog(`接口 ${row.operation} · ${row.mode === 'local_simulation' ? '本地模拟（未发送）' : '真实查询'} · ${row.status} · ${row.message || ''}`);
            renderApiInterfaceRows(rows);
        }
        summary.textContent = `全部 ${rows.length} 个接口检查完成：${totals()}。本地模拟不代表真实写入或支付成功。`;
        summary.className = `diagnostic-output ${counts.failed ? 'error' : counts.skipped ? 'warning' : 'success'}`;
        appendDiagnosticLog(`全部接口测试完成 · ${totals()}`);
    } catch (error) {
        summary.textContent = `接口测试未完成：${error.message}。请核对配置后重新运行。`;
        summary.className = 'diagnostic-output error';
        $('apiInterfaceRows').innerHTML = '<tr><td colspan="4">本轮未能读取有效接口清单，请重新运行。</td></tr>';
    } finally {
        apiDiagnosticsBusy = false; button.disabled = false; button.textContent = '一键全部测试';
    }
}
$('testAllApi').onclick = runAllApiDiagnostics;
$('clearDiagnosticLog').onclick = () => { diagnosticLines.length = 0; $('diagnosticLog').textContent = '尚无调试记录。'; };
$('refreshPaymentRegions').onclick = () => perform(loadPaymentRegions);
for (const plan of Object.keys(cardPlans)) $(`paymentRegion_${plan}`).addEventListener('change', () => {
    $('paymentRegionState').textContent = '地区选择已更改，请点击下方“保存配置”后生效。';
});
$('refreshCardIds').onclick = () => perform(loadCardIdPreview);
$('loadCards').onclick = () => perform(loadCards);
$('loadTransactions').onclick = () => perform(loadCardTransactions);
$('syncCards').onclick = () => perform(synchronizeCards);
$('refreshIssues').onclick = () => perform(async () => { notice((await request('/api/admin/orbitcard/issues/refresh', {})).message, 'success'); await loadCards(); });
form('applyCardForm', applyCard);
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
form('emailNotificationForm', saveEmailNotifications);
$('refreshEmailNotifications').onclick = () => perform(loadEmailNotifications);
$('testEmailNotifications').onclick = testEmailNotifications;
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
let orderManualEditing = null, orderManualSaving = false, orderManualLoadSequence = 0;
const orderManualActionLabels = { note: '记录处理备注', pause: '暂停自动处理', success: '人工交付完成', failed: '人工确认失败' };
const orderManualHistoryLabels = { ...orderManualActionLabels, release: '解除本地占用' };
function orderManualUrl(order) {
    return order.kind === 'admin' ? `/api/admin/manual/orders/${encodeURIComponent(order.id)}/manual`
        : `/api/admin/orders/${encodeURIComponent(order.id)}/manual`;
}
function updateOrderManualRelease(data = orderManualEditing?.data) {
    const release = data?.release, resultAction = ['success', 'failed'].includes($('orderManualAction').value);
    const allowed = resultAction && release?.allowed === true && release?.released !== true;
    $('orderManualRelease').disabled = !allowed;
    if (!allowed) $('orderManualRelease').checked = false;
    $('orderManualReleaseState').textContent = release?.released === true
        ? `本地占用：已释放；${data.manual_local_released_by || '管理员'} · ${data.manual_local_released_at || '时间未记录'}；${data.manual_local_release_reason || '未记录原因'}`
        : release?.allowed !== true ? `当前不能释放本地占用：${release?.reason || '请先核对原订单占用归属。'}`
            : !resultAction ? '只有登记人工交付完成或人工确认失败时，才能选择释放本地占用。'
                : '未勾选时，未决占用继续保留；已完成核对的占用按正常结案规则处理。';
}
function renderOrderManualControl(data) {
    const previous = $('orderManualAction').value;
    const actions = data.actions.filter(action => action && Object.hasOwn(orderManualActionLabels, action.value));
    const businessResult = ['success', 'failed'].includes(data.manual_result) ? data.manual_result
        : data.business_status === 'closed' && ['success', 'failed'].includes(data.business_result) ? data.business_result : '';
    const closed = Boolean(businessResult) || data.business_status === 'closed';
    $('orderManualState').textContent = closed ? `业务订单：已关闭${businessResult ? `（人工${businessResult === 'success' ? '成功' : '失败'}）` : ''}`
        : `业务订单：${data.business_status || data.status || '未记录'}`;
    $('orderManualOriginalState').textContent = `原资金核对记录：${data.status || '未记录'} / ${data.state || '未记录'}`;
    const manualResult = businessResult === 'success' ? '人工交付完成' : businessResult === 'failed' ? '人工确认失败' : '';
    $('orderManualResult').textContent = manualResult
        ? `人工结果：${manualResult}；${data.manual_result_by || '管理员'} · ${data.business_closed_at || data.manual_result_at || '时间未记录'}；${data.manual_result_reason || '未记录原因'}`
        : '人工结果：尚未登记';
    $('orderManualSettlement').textContent = data.settlement?.allowed === false
        ? `${data.release?.released === true ? '原资金／订阅仍需核对；本地占用已人工释放，原平台扣款仍可能完成。' : '原资金／订阅仍需核对，默认保留原记录与占用。'}${data.settlement.reason || '人工结果与资金处理分别记录。'}`
        : data.settlement?.allowed === true ? '资金结算：当前校验允许安全结算，保存时会再次核对。'
            : '资金结算：尚未确认，请以当前措施说明为准。';
    $('orderManualAction').innerHTML = '<option value="">请选择处理操作</option>' + actions.map(action =>
        `<option value="${escapeHtml(action.value)}"${action.enabled === true ? '' : ' disabled'}>${escapeHtml(action.label || orderManualActionLabels[action.value])}${action.enabled === true ? '' : '（暂不可执行）'}</option>`).join('');
    const selected = actions.find(action => action.value === previous && action.enabled === true)
        || actions.find(action => action.value === 'note' && action.enabled === true) || actions.find(action => action.enabled === true);
    $('orderManualAction').value = selected?.value || '';
    updateOrderManualRelease(data);
    $('orderManualAvailability').innerHTML = actions.map(action => `<li><strong>${escapeHtml(action.label || orderManualActionLabels[action.value])}</strong>：${escapeHtml(action.reason || (action.enabled === true ? '可以执行' : '当前状态暂不可执行'))}</li>`).join('');
    const history = Array.isArray(data.history) ? data.history.filter(entry => entry && typeof entry === 'object').slice(0, 20) : [];
    $('orderManualHistory').innerHTML = history.length ? history.map(entry =>
        `<p><strong>${escapeHtml(orderManualHistoryLabels[entry.action] || entry.action)}</strong>${entry.release_local_hold === true || entry.release_local_hold === 1 ? ' · 同时释放本地占用' : ''} · ${escapeHtml(entry.created_at)}<br>${escapeHtml(entry.admin_email || '管理员')} · ${escapeHtml(entry.previous_status || '—')} → ${escapeHtml(entry.next_status || '—')}<br>${escapeHtml(entry.reason)}</p>`).join('') : '<p>暂无人工处理记录</p>';
    $('orderManualSave').disabled = !selected;
}
async function loadOrderManualControl() {
    if (!orderManualEditing || orderManualSaving) return;
    const target = orderManualEditing, sequence = ++orderManualLoadSequence;
    target.data = null;
    $('orderManualFields').disabled = true;
    $('orderManualReload').disabled = true;
    $('orderManualError').textContent = '';
    $('orderManualState').textContent = '正在读取订单状态与可执行操作…';
    $('orderManualOriginalState').textContent = '';
    $('orderManualResult').textContent = '正在读取已登记的人工结果…';
    $('orderManualSettlement').textContent = '';
    $('orderManualReleaseState').textContent = '正在读取本地占用信息…';
    try {
        const result = await request(orderManualUrl(target));
        if (target !== orderManualEditing || sequence !== orderManualLoadSequence) return;
        const data = result.data;
        if (!data || data.kind !== target.kind || data.id !== target.id || typeof data.revision !== 'string'
            || !data.revision || !Array.isArray(data.actions)) throw new Error('订单处理信息不完整，请重新读取');
        renderOrderManualControl(data);
        target.data = data;
    } catch (error) {
        if (target !== orderManualEditing || sequence !== orderManualLoadSequence) return;
        $('orderManualState').textContent = '尚未读取到可用的订单处理信息';
        $('orderManualResult').textContent = '尚未读取到人工结果，请重新读取';
        $('orderManualReleaseState').textContent = '尚未读取到本地占用信息，请重新读取';
        $('orderManualError').textContent = error.message;
    } finally {
        if (target === orderManualEditing && sequence === orderManualLoadSequence) {
            $('orderManualFields').disabled = !target.data;
            $('orderManualReload').disabled = false;
        }
    }
}
async function openOrderManualControl(button) {
    if (orderManualSaving) return;
    const kind = button.dataset.orderKind, id = button.dataset.orderManual;
    if (!['task', 'admin'].includes(kind) || !id) return;
    orderManualEditing = { kind, id, data: null };
    $('orderManualCode').textContent = `${kind === 'admin' ? '管理员订单' : '订单'}：${id}`;
    $('orderManualReason').value = '';
    $('orderManualAction').value = '';
    $('orderManualRelease').checked = false;
    $('orderManualRelease').disabled = true;
    $('orderManualReleaseState').textContent = '';
    $('orderManualAvailability').innerHTML = '';
    $('orderManualHistory').innerHTML = '<p>读取后显示处理记录</p>';
    if (!$('orderManualDialog').open) $('orderManualDialog').showModal();
    await loadOrderManualControl();
}
function closeOrderManualControl() {
    if (orderManualSaving) return;
    orderManualLoadSequence++;
    orderManualEditing = null;
    $('orderManualReason').value = '';
    $('orderManualDialog').close();
}
async function saveOrderManualControl() {
    if (!orderManualEditing?.data || orderManualSaving) return;
    const target = orderManualEditing, action = $('orderManualAction').value, reason = $('orderManualReason').value.trim();
    const available = Object.hasOwn(orderManualActionLabels, action)
        && target.data.actions.find(item => item?.value === action && item.enabled === true);
    if (!available) { $('orderManualError').textContent = '请选择当前可执行的操作'; return; }
    const releaseLocalHold = $('orderManualRelease').checked === true;
    if (releaseLocalHold && (!['success', 'failed'].includes(action) || target.data.release?.allowed !== true || target.data.release?.released === true)) {
        $('orderManualError').textContent = '当前操作不能释放本地占用，请重新核对订单'; return;
    }
    if (!reason || reason.length > 255) { $('orderManualError').textContent = '请填写 1–255 字的处理原因'; return; }
    orderManualSaving = true;
    $('orderManualFields').disabled = true;
    $('orderManualReload').disabled = true;
    $('cancelOrderManual').disabled = true;
    $('orderManualError').textContent = '';
    try {
        const result = await request(orderManualUrl(target), { action, expected_revision: target.data.revision, reason, release_local_hold: releaseLocalHold });
        $('orderManualDialog').close();
        orderManualEditing = null;
        $('orderManualReason').value = '';
        notice(result.message || '人工处理已保存', 'success');
        try { await (target.kind === 'admin' ? loadManualOrders() : loadOverview()); }
        catch (error) { notice(`处理已保存，但列表刷新失败：${error.message}`, 'error'); }
    } catch (error) {
        $('orderManualError').textContent = error.httpStatus === 409
            ? `${error.message}；请重新读取订单状态后再处理` : error.message;
        if (error.httpStatus === 409) target.data = null;
    } finally {
        orderManualSaving = false;
        $('orderManualFields').disabled = !orderManualEditing?.data;
        $('orderManualReload').disabled = false;
        $('cancelOrderManual').disabled = false;
    }
}
$('orderManualForm').addEventListener('submit', event => { event.preventDefault(); saveOrderManualControl(); });
$('orderManualAction').addEventListener('change', () => updateOrderManualRelease());
$('orderManualReload').onclick = loadOrderManualControl;
$('cancelOrderManual').onclick = closeOrderManualControl;
$('orderManualDialog').addEventListener('cancel', event => { event.preventDefault(); closeOrderManualControl(); });

document.addEventListener('click', event => {
    const manualControl = event.target.closest('[data-order-manual]');
    if (manualControl) openOrderManualControl(manualControl);
    const retryManual = event.target.closest('[data-retry-manual]');
    if (retryManual) {
        const order = manualOrders.find(item => item.request_id === retryManual.dataset.retryManual);
        if (order && order.business_status !== 'closed' && !order.manual_result && !order.queued && ['preparing','retry_waiting'].includes(order.state)) {
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
            const data = await request(`/api/admin/manual/orders/${encodeURIComponent(refreshManual.dataset.refreshManual)}/refresh`, {});
            showPaymentQueueFull(data.order, refreshManual.dataset.refreshManual);
            await loadManualOrders();
            notice('已查询管理员原订单', 'success');
        } finally { refreshManual.disabled = false; }
    });
    const transactions = event.target.closest('[data-card-transactions]');
    if (transactions) { $('transactionCardId').value = transactions.dataset.cardTransactions; $('transactionPage').value = '1'; $('loadTransactions').click(); }
    const refresh = event.target.closest('[data-refresh-order]');
    if (refresh) perform(async () => { refresh.disabled = true; try { const data = await request(`/api/admin/orders/${encodeURIComponent(refresh.dataset.refreshOrder)}/refresh`, {}); showPaymentQueueFull(data.data, refresh.dataset.refreshOrder); await loadOverview(); notice('已查询原订单', 'success'); } finally { refresh.disabled = false; } });
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
