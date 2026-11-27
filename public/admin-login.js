'use strict';

const TOKEN_KEY = 'plus_admin_token';
const SECONDARY_TOKEN_KEY = 'plus_admin_secondary_token';
const METHOD_LABELS = {
    totp: 'Google Authenticator',
    telegram: 'Telegram 验证码'
};
const METHOD_HINTS = {
    totp: '请打开 Google Authenticator，输入当前 6 位动态码。',
    telegram: '点击下方按钮发送验证码到管理员 Telegram，再输入 6 位数字。'
};
const state = { challengeToken: '', methods: [], selectedMethod: '' };
let adminPanelPath = '/admin';
let tgCooldownTimer = null;
let tgCooldownUntil = 0;

function clearTgCooldown() {
    if (tgCooldownTimer) {
        clearInterval(tgCooldownTimer);
        tgCooldownTimer = null;
    }
    tgCooldownUntil = 0;
    const btn = document.getElementById('sendTgBtn');
    if (btn) {
        btn.disabled = false;
        btn.textContent = '发送 Telegram 验证码';
    }
}

function startTgCooldown(seconds = 60) {
    const btn = document.getElementById('sendTgBtn');
    if (!btn) return;
    if (tgCooldownTimer) clearInterval(tgCooldownTimer);
    tgCooldownUntil = Date.now() + seconds * 1000;
    const update = () => {
        const remaining = Math.ceil((tgCooldownUntil - Date.now()) / 1000);
        if (remaining <= 0) {
            clearTgCooldown();
            return;
        }
        btn.disabled = true;
        btn.textContent = `重新发送验证码（${remaining}s）`;
    };
    update();
    tgCooldownTimer = setInterval(update, 1000);
}

function finishLogin(data) {
    if (!data.token) throw new Error('登录响应缺少令牌，请重新登录');
    clearTgCooldown();
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.removeItem(SECONDARY_TOKEN_KEY);
    location.href = data.panelUrl || data.panelPath || adminPanelPath;
}

async function submitLogin(buttonId, endpoint, body, onSuccess) {
    const button = document.getElementById(buttonId);
    if (button.disabled) return;
    button.disabled = true;
    setMessage('');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let keepDisabled = false;
    try {
        const response = await fetch(`/api/admin/login${endpoint}`, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '验证请求失败');
        keepDisabled = onSuccess(data) === true;
    } catch (error) {
        setMessage(controller.signal.aborted ? '请求超时，请稍后重试' : error.message);
    } finally {
        clearTimeout(timeout);
        if (!keepDisabled) button.disabled = false;
    }
}

function getBrowserFingerprint() {
    const parts = [
        navigator.userAgent,
        navigator.language,
        screen.width,
        screen.height,
        Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    ];
    return btoa(unescape(encodeURIComponent(parts.join('|')))).slice(0, 96);
}

function setMessage(text, isSuccess) {
    const el = document.getElementById('message');
    el.textContent = text || '';
    el.className = 'message' + (isSuccess ? ' success' : '');
}

function showStep(name) {
    document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
    document.getElementById(name === '2fa' ? 'step2fa' : 'stepLogin').classList.add('active');
    if (name !== '2fa') clearTgCooldown();
    document.getElementById(name === '2fa' ? 'code' : 'email').focus();
}

function updateMethodUi() {
    const method = state.selectedMethod;
    const hintEl = document.getElementById('methodHint');
    const sendTgBtn = document.getElementById('sendTgBtn');
    const codeInput = document.getElementById('code');

    hintEl.textContent = METHOD_HINTS[method] || '请输入验证码';
    sendTgBtn.hidden = method !== 'telegram';
    codeInput.placeholder = method === 'totp' ? 'Google Authenticator 6 位码' : 'Telegram 6 位验证码';
    codeInput.value = '';
    setMessage('');
}

function selectMethod(method) {
    if (!state.methods.includes(method)) return;
    state.selectedMethod = method;
    document.querySelectorAll('.method-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.method === method);
    });
    updateMethodUi();
}

function renderMethods(methods, defaultMethod) {
    const tabs = document.getElementById('methodTabs');
    const single = document.getElementById('methodSingle');
    if (tabs.replaceChildren) tabs.replaceChildren();
    else tabs.innerHTML = '';
    state.methods = methods || [];
    state.selectedMethod = defaultMethod && methods.includes(defaultMethod)
        ? defaultMethod
        : (methods[0] || '');

    if (methods.length <= 1) {
        tabs.hidden = true;
        single.hidden = !methods.length;
        single.textContent = methods.length
            ? `验证方式：${METHOD_LABELS[methods[0]] || methods[0]}`
            : '';
    } else {
        tabs.hidden = false;
        single.hidden = true;
        methods.forEach((method) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'method-tab' + (method === state.selectedMethod ? ' active' : '');
            btn.dataset.method = method;
            btn.textContent = METHOD_LABELS[method] || method;
            btn.onclick = () => selectMethod(method);
            tabs.appendChild(btn);
        });
    }
    updateMethodUi();
}

async function verifyExistingToken() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    try {
        const response = await fetch('/api/admin/session', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('登录已失效');
        const data = await response.json();
        if (data.refreshed && data.token) {
            localStorage.setItem(TOKEN_KEY, data.token);
        }
        location.href = data.panelUrl || data.panelPath || adminPanelPath;
    } catch (_) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(SECONDARY_TOKEN_KEY);
    }
}

function login() {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) {
        setMessage('请输入邮箱和密码');
        return;
    }
    return submitLogin('loginBtn', '', { email, password, fingerprint: getBrowserFingerprint() }, data => {
        if (data.requires2fa) {
            state.challengeToken = data.challengeToken;
            renderMethods(data.methods || [], data.defaultMethod || '');
            const modeHint = data.login2faMode === 'either' && (data.methods || []).length > 1
                ? '可在下方切换 Google Authenticator / Telegram 验证。'
                : '';
            document.getElementById('step2faHint').textContent =
                `账号 ${data.email || email} 需要二次验证。${modeHint}`;
            showStep('2fa');
            return;
        }
        finishLogin(data);
    });
}

function sendTelegramCode() {
    if (state.selectedMethod !== 'telegram') {
        setMessage('请先切换到 Telegram 验证码');
        return;
    }
    return submitLogin('sendTgBtn', '/send-tg-code', { challengeToken: state.challengeToken }, data => {
        setMessage(data.message || '验证码已发送', true);
        startTgCooldown(60);
        return true;
    });
}

function verify2fa() {
    const code = document.getElementById('code').value.trim();
    if (!code) {
        setMessage('请输入验证码');
        return;
    }
    if (!state.selectedMethod) {
        setMessage('请选择验证方式');
        return;
    }
    return submitLogin('verifyBtn', '/verify-2fa', {
        challengeToken: state.challengeToken, method: state.selectedMethod, code, fingerprint: getBrowserFingerprint()
    }, finishLogin);
}

document.getElementById('stepLogin').addEventListener('submit', event => { event.preventDefault(); login(); });
document.getElementById('step2fa').addEventListener('submit', event => { event.preventDefault(); verify2fa(); });
document.getElementById('sendTgBtn').addEventListener('click', sendTelegramCode);
document.getElementById('backBtn').addEventListener('click', () => showStep('login'));
const togglePassword = document.getElementById('togglePassword');
if (togglePassword) {
    togglePassword.addEventListener('click', () => {
        const input = document.getElementById('password');
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        togglePassword.textContent = showing ? '显示' : '隐藏';
        togglePassword.setAttribute('aria-pressed', String(!showing));
    });
}

verifyExistingToken();
