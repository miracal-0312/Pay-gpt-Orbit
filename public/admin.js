'use strict';
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'plus_admin_token', SECONDARY_KEY = 'plus_admin_secondary_token';
const cardPlans = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
let loginUrl = '/admin-login', selected = 'overview', savedBaseUrl = '';
function notice(text, type = '') { $('notice').textContent = text; $('notice').className = `message ${type}`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function logout() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SECONDARY_KEY); location.assign(loginUrl); }
async function request(url, body, method = body === undefined ? 'GET' : 'POST') {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { logout(); throw new Error('请先登录'); }
    const headers = { Authorization: `Bearer ${token}`, 'x-admin-secondary-token': localStorage.getItem(SECONDARY_KEY) || '' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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
}
async function perform(action, success) {
    try { const result = await action(); if (success) notice(success, 'success'); return result; }
    catch (error) { notice(error.message, 'error'); return null; }
}
function status(value) { const text = { success: '成功', failed: '失败', retry: '待重新提交 Session', running: '处理中', manual: '待确认', pending: '待确认', unused: '未使用', used: '已使用', processing: '占用中' }[value] || value; return `<span class="pill ${escapeHtml(value)}">${escapeHtml(text)}</span>`; }
function renderTasks(tasks) {
    $('tasks').innerHTML = tasks.map(task => {
        const order = task.order || {}, fee = order.fee_status ? `${order.service_fee ?? '—'} ${order.currency || 'USDT'} / ${order.fee_status}` : '—';
        const payment = order.payment ? `${order.payment.amount} ${order.payment.currency}` : '—';
        const refresh = task.provider === 'orbitcard' ? `<button class="secondary" data-refresh-order="${escapeHtml(task.jobKey)}">查原单</button>` : '<small>历史记录</small>';
        return `<tr><td>${escapeHtml(task.time)}<br><code>${escapeHtml(task.cdk)}</code></td><td>${escapeHtml(task.provider === 'orbitcard' ? task.token : '历史账号')}<br><code>${escapeHtml(task.order_id || task.client_order_no || task.jobKey)}</code><br>卡 ID：${escapeHtml(task.card_id || '历史未绑定')}</td><td>${status(task.status)}<br>${escapeHtml(task.message)}</td><td>${escapeHtml(fee)}</td><td>${escapeHtml(payment)}</td><td>${refresh} <button class="secondary" data-download-audit="${escapeHtml(task.jobKey)}">下载日志</button></td></tr>`;
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
    $('orderState').textContent = config.enabled ? '正在接单' : '已暂停新订单';
    $('orderState').className = `pill ${config.enabled ? 'success' : 'pending'}`;
    $('keyState').textContent = config.api_key_configured ? '环境变量已配置' : '缺少 ORBITCARD_API_KEY';
    $('secretState').textContent = config.orbitcard_secret_configured ? '环境变量已配置' : '缺少 ORBITCARD_API_SECRET';
    $('keyState').dataset.state = config.api_key_configured ? 'configured' : 'missing';
    $('secretState').dataset.state = config.orbitcard_secret_configured ? 'configured' : 'missing';
    if (config.api_key_configured && config.orbitcard_secret_configured) {
        await Promise.all([loadCardIdPreview(), loadPricePreview()]);
    } else {
        $('cardIdPreview').textContent = '请先在服务器环境变量中配置配对的 API Key 和 API Secret。';
        $('pricePreview').textContent = '凭据尚未配置，无法读取平台推荐价。';
    }
}
async function loadPricePreview() {
    const output = $('pricePreview');
    output.textContent = '正在读取产品目录中的套餐 USD 价格…';
    try {
        const data = await request('/api/admin/orbitcard/products');
        const configuredCode = $('productCode').value.trim();
        const products = (data.products || []).filter(product => !configuredCode || product.product_code === configuredCode);
        output.innerHTML = Object.entries(cardPlans).map(([plan, label]) => {
            const prices = products.flatMap(product => (product.prices || []).filter(price => price.plan_type === plan && price.currency === 'USD')
                .map(price => `<small>${escapeHtml(product.product_code)}：${escapeHtml(price.price)} USD · ${escapeHtml(price.source === 'transaction' ? '交易参考价' : price.source === 'config' ? '平台配置价' : '平台返回价')}</small>`));
            return `<div class="price-card"><strong>${escapeHtml(label)}</strong>${prices.length ? prices.join('') : '<small>平台未返回 USD 推荐价，暂不能自动充值</small>'}</div>`;
        }).join('');
    } catch (error) { output.textContent = `推荐价查询失败：${error.message}`; }
}
async function loadCardIdPreview() {
    $('cardIdPreview').textContent = '正在从 Orbitcard 读取卡片 ID…';
    try {
        const data = await request('/api/admin/orbitcard/cards/preview');
        const ids = (data.cards || []).map(card => `${card.card_id}${card.status === 'ACTIVE' ? '（可用）' : `（${card.status || '未知状态'}）`}`);
        $('cardIdPreview').textContent = `平台共 ${data.total} 张卡，可用 ${data.active} 张。${ids.length ? `前 ${ids.length} 张：${ids.join('、')}` : '当前没有卡片，支付时会按规则自动开卡。'}`;
    } catch (error) { $('cardIdPreview').textContent = `卡片 ID 读取失败：${error.message}`; }
}
function apiInput() { return { enabled: $('apiEnabled').checked, base_url: $('baseUrl').value.trim(),
    orbitcard_product_code: $('productCode').value.trim(), orbitcard_max_initial_amount: $('maxInitialAmount').value.trim(),
    orbitcard_max_fee: $('maxFee').value.trim() }; }
async function loadCards() {
    const data = await request('/api/admin/orbitcard/cards');
    const currentCardId = $('transactionCardId').value;
    $('transactionCardId').replaceChildren(new Option('请选择平台卡片', ''));
    for (const card of data.cards) $('transactionCardId').add(new Option(`${card.card_id} / ****${card.last4 || '—'}`, card.card_id));
    if (data.cards.some(card => String(card.card_id) === currentCardId)) $('transactionCardId').value = currentCardId;
    $('cardRows').innerHTML = data.cards.map(card => `<tr><td>${escapeHtml(card.card_id)} / ****${escapeHtml(card.last4 || '—')}<br>${escapeHtml(card.product_code)}</td><td>${escapeHtml(card.provider_status)}<br>${escapeHtml(card.balance ?? '未知')} ${escapeHtml(card.currency)}</td><td>${Object.entries(cardPlans).map(([plan,label]) => `${label}：${escapeHtml(card.usage[plan].successful)} / ${card.usage[plan].limit}${card.usage[plan].reserved ? '（处理中）' : ''}`).join('<br>')}</td><td>${escapeHtml(card.active_job || '空闲')}</td><td>${card.history_confirmed ? '历史已确认，四种套餐独立计数' : `${Object.entries(cardPlans).map(([plan,label]) => `<label>${label}<input data-card-uses="${card.card_id}-${plan}" type="number" min="0" max="${plan === 'plus' ? 4 : 1}" required placeholder="历史成功次数"></label>`).join('')}<button data-bind-card="${card.card_id}" class="secondary">确认历史次数</button>`}<br><button data-card-transactions="${card.card_id}" class="secondary">查看交易</button></td></tr>`).join('') || '<tr><td colspan="5">尚无卡片，请同步或申请。</td></tr>';
    $('issueRows').innerHTML = data.issues.map(issue => `<tr><td>${escapeHtml(issue.created_at)}<br><code>${escapeHtml(issue.issue_key)}</code></td><td>${escapeHtml(issue.product_code)}<br>${escapeHtml(issue.amount)}</td><td>${escapeHtml(cardPlans[issue.plan_type] || issue.plan_type)} / ${escapeHtml(issue.state)}<br>${escapeHtml(issue.provider_status || '')}<br>${escapeHtml(issue.message)}</td><td>${escapeHtml(issue.order_no || '待返回')}<br>${escapeHtml(issue.card_id || '待返回')}</td></tr>`).join('') || '<tr><td colspan="4">暂无开卡申请</td></tr>';
    $('fundingRows').innerHTML=(data.fundings || []).map(funding => `<tr><td>${escapeHtml(funding.created_at)}<br><code>${escapeHtml(funding.job_key)}</code></td><td>${escapeHtml(funding.card_id)}<br>${escapeHtml(funding.amount)} USD</td><td>${escapeHtml(funding.state)} / ${escapeHtml(funding.provider_status)}<br>${escapeHtml(funding.order_no || funding.funding_key)}<br>${escapeHtml(funding.message)}</td><td>${escapeHtml(funding.fee_snapshot || '待确认')}<br>目标余额：${escapeHtml(funding.target_balance)}</td></tr>`).join('') || '<tr><td colspan="4">暂无卡片补款</td></tr>';
}
async function loadCdks() {
    const codes = await request('/api/admin/cdks');
    $('cdkRows').innerHTML = codes.map(code => `<tr><td><code>${escapeHtml(code.code)}</code></td><td>${escapeHtml(code.plan_label || code.plan_type)}</td><td>${status(code.status)}${code.orbitcard_support_locked ? '<br>支付失败，已锁定；请人工售后' : code.orbitcard_balance_blocked ? '<br>账户余额不足，CDK 已锁定' : code.orbitcard_pending_confirmation ? '<br>结果待确认' : ''}</td><td>${code.shipped ? '已出库' : '未出库'}</td><td>${!code.shipped ? `<button class="secondary" data-ship="${escapeHtml(code.code)}">标记出库</button>` : ''}${code.status === 'unused' ? ` <button class="danger" data-delete-cdk="${escapeHtml(code.code)}">删除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">暂无卡密</td></tr>';
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
async function loadSelected() {
    if (selected === 'overview') await loadOverview();
    if (selected === 'orbitcard') await loadApi();
    if (selected === 'cards') await loadCards();
    if (selected === 'logs') await loadLogs();
    if (selected === 'settings') await Promise.all([loadOverview(), loadSecurity()]);
    if (selected === 'cdks' && localStorage.getItem(SECONDARY_KEY)) await loadCdks();
}
$('tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-tab]'); if (!button) return;
    selected = button.dataset.tab;
    for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== selected;
    for (const item of $('tabs').querySelectorAll('button')) {
        item.classList.toggle('active', item === button);
        if (item === button) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
    }
    perform(loadSelected);
});
$('logout').onclick = logout; $('reload').onclick = () => perform(loadSelected);
function form(id, handler) {
    $(id).addEventListener('submit', async event => {
        event.preventDefault(); const button = $(id).querySelector('button[type=submit],button:not([type])');
        if (button) button.disabled = true;
        try { await handler(); } catch (error) { notice(error.message, 'error'); }
        finally { if (button) button.disabled = false; }
    });
}
form('unlockForm', async () => {
    const data = await request('/api/admin/verify-secondary', { password: $('secondaryPassword').value });
    $('secondaryPassword').value = ''; localStorage.setItem(SECONDARY_KEY, data.secondaryToken); $('unlockState').textContent = '已验证'; await loadSelected(); notice('二级验证已通过', 'success');
});
form('generateForm', async () => {
    const data = await request('/api/admin/cdks/generate', { count: Number($('cdkCount').value), plan_type: $('planType').value });
    $('generated').hidden = false; $('generated').textContent = data.cdks.join('\n'); notice(data.message, 'success'); await loadCdks();
});
form('importForm', async () => {
    const data = await request('/api/admin/cdks/import', { cdks: $('cdkImport').value.split(/[\s,;]+/).filter(Boolean), plan_type: $('planType').value });
    $('cdkImport').value = ''; notice(data.message, 'success'); await loadCdks();
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
    return {html:`<strong>查询完成 · ${checkedAt()}</strong><p>账户可用余额：${balance == null ? escapeHtml(data.balance_error || '查询失败') : `${escapeHtml(balance)} USD`}</p><ul>${planItems(data.gpt_plans)}</ul>`,warning:balance == null};
});
$('loadRegions').onclick = () => runDiagnostic('loadRegions', 'regionResult', async output => {
    let products = [], productError = '';
    try { products = (await diagnosticFetch('/api/admin/orbitcard/products')).products || []; }
    catch (error) { productError = error.message; }
    const regions = {};
    for (const [index, plan] of Object.keys(cardPlans).entries()) {
        output.textContent = `正在查询地区 ${index + 1}/4：${cardPlans[plan]}…`;
        try {
            const data = await diagnosticFetch(`/api/admin/orbitcard/payment-regions?plan=${plan}`);
            regions[plan] = data.regions?.[plan] || {options:[],error:'平台未返回该套餐地区'};
            appendPlatformChecks([regions[plan].trace], savedBaseUrl);
        } catch (error) { regions[plan] = {options:[],error:error.message}; }
    }
    const rows = Object.entries(cardPlans).flatMap(([plan, label]) => {
        const result = regions[plan], options = result.options?.length ? result.options : [null];
        const references = products.flatMap(product => (product.prices || [])
            .filter(price => price.plan_type === plan && price.currency === 'USD')
            .map(price => `${product.product_code}: ${price.price} USD`));
        const reference = references.length ? references.map(escapeHtml).join('<br>') : '未返回';
        return options.map(item => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(item?.code || '—')}</td><td>${item?.default ? '是' : '否'}</td><td>${item?.region_price ? `${escapeHtml(item.region_price)} USD` : '未返回'}</td><td>${reference}</td><td>${escapeHtml(result.error || '可用')}</td></tr>`);
    }).join('');
    const warning = Boolean(productError || Object.values(regions).some(result => result.error));
    return {html:`<strong>地区与价格查询完成 · ${checkedAt()}</strong><p>地区接口未文档化地区价格；“产品推荐价”来自卡产品目录，非地区价，也不代表最终扣款。</p>${productError ? `<p>产品价格读取失败：${escapeHtml(productError)}</p>` : ''}<div class="table-wrap"><table class="region-price-table"><thead><tr><th>套餐</th><th>地区</th><th>平台默认</th><th>地区接口价格</th><th>产品推荐价（非地区价）</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>`,warning};
});
$('clearDiagnosticLog').onclick = () => { diagnosticLines.length = 0; $('diagnosticLog').textContent = '尚无调试记录。'; };
$('refreshPrices').onclick = () => perform(loadPricePreview);
$('refreshCardIds').onclick = () => perform(loadCardIdPreview);
$('loadCards').onclick = () => perform(loadCards);
$('loadTransactions').onclick = () => perform(async () => {
    const id = Number($('transactionCardId').value), page = Number($('transactionPage').value);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(page) || page < 1) throw new Error('请输入有效卡 ID 和页码');
    const result = await request(`/api/admin/orbitcard/cards/${id}/transactions?page=${page}`);
    $('cardTransactions').textContent = JSON.stringify(result.data, null, 2);
});
$('syncCards').onclick = () => perform(async () => { notice((await request('/api/admin/orbitcard/cards/sync', {})).message, 'success'); await loadCards(); });
$('loadProducts').onclick = () => perform(async () => { const data = await request('/api/admin/orbitcard/products'); $('products').textContent = JSON.stringify({ automatic_application:data.automatic_application, application_error:data.application_error, products:data.products }, null, 2); });
$('refreshIssues').onclick = () => perform(async () => { notice((await request('/api/admin/orbitcard/issues/refresh', {})).message, 'success'); await loadCards(); });
form('applyCardForm', async () => { try { notice((await request('/api/admin/orbitcard/cards/apply', { plan_type: $('applyPlan').value })).message, 'success'); } finally { await loadCards(); } });
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
$('testTelegram').onclick = () => perform(async () => notice((await request('/api/admin/telegram/test', {})).message, 'success'));
$('loadLoginLogs').onclick = () => perform(async () => { const data = await request('/api/admin/login-logs?limit=100'); $('loginLogs').textContent = JSON.stringify(data.logs, null, 2); });
$('loadCdks').onclick = () => perform(loadCdks); $('loadLogs').onclick = () => perform(loadLogs);
$('clearLogs').onclick = () => perform(async () => { await request('/api/admin/runtime-logs/clear', {}); await loadLogs(); notice('显示缓存已清空，磁盘历史保留', 'success'); });
document.addEventListener('click', event => {
    const transactions = event.target.closest('[data-card-transactions]');
    if (transactions) { $('transactionCardId').value = transactions.dataset.cardTransactions; $('transactionPage').value = '1'; $('loadTransactions').click(); }
    const bind = event.target.closest('[data-bind-card]');
    if (bind) perform(async () => {
        const id = bind.dataset.bindCard, usage = {};
        for (const plan of Object.keys(cardPlans)) {
            const count = document.querySelector(`[data-card-uses="${id}-${plan}"]`).value;
            if (count === '') throw new Error('请分别填写四种套餐的历史成功次数，不能默认当作新卡');
            usage[plan] = Number(count);
        }
        bind.disabled = true;
        try { await request(`/api/admin/orbitcard/cards/${id}/bind`, { usage }); await loadCards(); notice('历史次数已确认', 'success'); }
        finally { bind.disabled = false; }
    });
    const refresh = event.target.closest('[data-refresh-order]');
    if (refresh) perform(async () => { refresh.disabled = true; try { await request(`/api/admin/orders/${encodeURIComponent(refresh.dataset.refreshOrder)}/refresh`, {}); await loadOverview(); notice('已查询原订单', 'success'); } finally { refresh.disabled = false; } });
    const download = event.target.closest('[data-download-audit]');
    if (download) perform(async () => {
        const job = download.dataset.downloadAudit;
        const response = await fetch(`/api/admin/task-logs/${encodeURIComponent(job)}/audit`, { headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}` } });
        if (response.status === 401) { logout(); return; }
        if (!response.ok) throw new Error((await response.json()).message || '日志下载失败');
        const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = `task-${job}.jsonl`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const ship = event.target.closest('[data-ship]');
    if (ship) perform(async () => { await request(`/api/admin/cdks/${encodeURIComponent(ship.dataset.ship)}/ship`, {}); await loadCdks(); });
    const remove = event.target.closest('[data-delete-cdk]');
    if (remove && confirm(`确定删除未使用的卡密 ${remove.dataset.deleteCdk}？`)) perform(async () => { await request(`/api/admin/cdks/${encodeURIComponent(remove.dataset.deleteCdk)}`, undefined, 'DELETE'); await loadCdks(); });
});
perform(async () => {
    const paths = await (await fetch('/api/public/admin-paths')).json(); if (paths.success) loginUrl = paths.loginUrl;
    const session = await request('/api/admin/session'); if (session.token) localStorage.setItem(TOKEN_KEY, session.token);
    await Promise.all([loadOverview(), loadSecurity()]);
});
setInterval(() => { if (!document.hidden && ['overview','logs'].includes(selected)) perform(loadSelected); }, 15000);
