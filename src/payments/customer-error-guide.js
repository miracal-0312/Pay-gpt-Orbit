'use strict';

const { classifyFailure, classifyApiError } = require('../orbitcard/orbitcard-error-policy');

// Translate Orbitcard platform/upstream error codes and task states into
// brand-safe, actionable customer guidance for the redemption page.
function buildCustomerGuidance(task = {}, order = {}) {
    const status = String(task.manual_result || task.status || '');
    const state = String(task.orbitcard_state || '');

    if (status === 'success' || task.manual_redeemed_at) return null;

    if (order.stage === 'awaiting_captcha') {
        return {
            category: 'captcha',
            title: '请完成人机验证',
            summary: '当前订阅订单需要完成人机安全验证后才能继续扣款。',
            steps: [
                '点击下方「打开人机验证」按钮并在有效期内完成验证',
                '验证完成后直接返回本页，无需重新提交卡密或 Session',
                '页面会自动刷新进度，也可点击「查询原订单」手动核对'
            ],
            can_self_fix: true,
            need_support: false
        };
    }

    if (state === 'retry_waiting' || status === 'retry') {
        return {
            category: 'session',
            title: '请提交最新 Session 继续原订单',
            summary: '原订单已准备就绪或正在切换支付通道，需要您提供目标账号的最新登录 Session 继续完成开通。',
            steps: [
                '先确认浏览器已登录需要充值的目标 ChatGPT 账号',
                '打开获取 Session 链接并复制完整的 JSON 内容',
                '粘贴到下方输入框并确认账号邮箱后重新提交'
            ],
            can_self_fix: true,
            need_support: false
        };
    }

    if (state === 'balance_blocked') {
        return {
            category: 'service',
            title: '支付通道暂时余额不足',
            summary: '当前充值通道资金暂不足，您的卡密已安全保留，不会作废。',
            steps: [
                '请联系客服补充通道余额，或稍后点击「查询原订单」查看恢复状态',
                '余额补足后卡密会自动解除锁定，届时重新提交 Session 即可'
            ],
            can_self_fix: false,
            need_support: true
        };
    }

    if (['funding_waiting', 'funding_review', 'funding_pending', 'card_pending', 'preparing', 'prepared', 'submitting', 'pending'].includes(state)
        && ['running', 'manual'].includes(status)) {
        return {
            category: 'pending',
            title: status === 'manual' ? '订单结果核对中，请勿重复提交' : '订单正在处理中',
            summary: status === 'manual'
                ? '原订单或资金流水正在后台核对，在确认结果前卡密保持占用。'
                : '系统正在为您的目标账号处理订阅，请保持页面打开或稍后用原卡密查询。',
            steps: [
                '请勿重复提交或使用其他卡密给同一账号充值',
                '可随时点击「查询原订单」获取最新状态'
            ],
            can_self_fix: false,
            need_support: status === 'manual'
        };
    }

    // Classify failure evidence from Orbitcard snapshot or API error metadata.
    const failurePolicy = (order.failureCode || order.failureMessage)
        ? classifyFailure({
            status: 'failed',
            upstream_status: 'failed',
            subscription_succeeded: false,
            failureCode: order.failureCode,
            failureMessage: order.failureMessage
        })
        : null;
    const apiPolicy = (order.platform_code || order.http_status || order.request_error)
        ? classifyApiError({
            operation: 'createSubscription',
            status: order.http_status,
            code: order.platform_code,
            requestError: order.request_error
        })
        : null;

    const category = resolveCategory(failurePolicy, apiPolicy, task.message);

    if (category === 'session') {
        return {
            category: 'session',
            title: '账号登录状态（Session）已失效',
            summary: '目标 ChatGPT 账号的 Session 已过期、格式不完整或登录状态已变更，导致无法继续订阅。',
            steps: [
                '重新登录需要充值的目标 ChatGPT 账号',
                '打开 https://chatgpt.com/api/auth/session 复制最新完整 JSON',
                '如卡密已释放，请点击「重新验证并继续充值」后粘贴提交；如卡密仍锁定请联系客服'
            ],
            can_self_fix: true,
            need_support: state === 'support_locked'
        };
    }

    if (category === 'account') {
        return {
            category: 'account',
            title: '目标 ChatGPT 账号状态不满足开通条件',
            summary: '目标账号可能已有有效订阅、存在未结清账单、为非网页端订阅（如 App Store / Google Play）或暂不符合升级资格。',
            steps: [
                '登录目标 ChatGPT 账号，检查「设置 → 订阅管理」确认当前无冲突订阅或欠费',
                '非网页渠道订阅需先在原应用商店处理后再开通',
                '如确认账号正常，请携带订单号联系售后核对'
            ],
            can_self_fix: true,
            need_support: true
        };
    }

    if (category === 'card') {
        return {
            category: 'card',
            title: '当前支付卡通道被拒付',
            summary: '本次支付通道扣款未通过，系统已记录异常并保护您的卡密状态。',
            steps: [
                '如页面提示卡密已释放，可稍后重新验证并提交',
                '如已达重试上限并进入售后锁定，请复制订单号联系客服处理'
            ],
            can_self_fix: false,
            need_support: true
        };
    }

    if (category === 'rate_limit' || category === 'capacity') {
        return {
            category: 'capacity',
            title: '当前充值通道繁忙',
            summary: '同时处理中的订单较多，触发了通道并发或频控限制。',
            steps: [
                '请等待 5–10 分钟后再查询原订单或重新验证提交',
                '请勿频繁重复点击提交'
            ],
            can_self_fix: true,
            need_support: false
        };
    }

    if (category === 'configuration' || category === 'authentication' || category === 'authorization') {
        return {
            category: 'service',
            title: '当前套餐或充值通道暂不可用',
            summary: '服务端通道配置正在维护或该套餐暂未开放，并非您的账号或卡密问题。',
            steps: [
                '请保留您的卡密，稍后重试或联系客服确认开放时间'
            ],
            can_self_fix: false,
            need_support: true
        };
    }

    if (category === 'transport' || status === 'manual') {
        return {
            category: 'pending',
            title: '网络波动，结果待确认',
            summary: '与充值通道通信超时，系统将在后台继续核对原订单最终状态。',
            steps: [
                '请勿重复提交或更换卡密',
                '稍后点击「查询原订单」查看最终结果'
            ],
            can_self_fix: false,
            need_support: true
        };
    }

    if (status === 'failed' || state === 'support_locked' || state === 'rejected') {
        return {
            category: 'unknown',
            title: '本次充值未能完成',
            summary: '通道返回了未通过结果，请查看上方失败说明并核对卡密状态。',
            steps: [
                '如卡密已自动释放，排除原因后可点击「重新验证并继续充值」',
                '如卡密处于锁定状态，请复制订单号联系售后核查原订单'
            ],
            can_self_fix: false,
            need_support: true
        };
    }

    return null;
}

function resolveCategory(failurePolicy, apiPolicy, message = '') {
    if (failurePolicy && failurePolicy.category && failurePolicy.category !== 'unknown') {
        return failurePolicy.category;
    }
    if (apiPolicy && apiPolicy.category && apiPolicy.category !== 'unknown') {
        return apiPolicy.category;
    }
    const text = String(message || '');
    if (/Session|登录状态|访问令牌|重新登录/i.test(text)) return 'session';
    if (/已有订阅|无购买资格|账单|订阅渠道|账号资格/i.test(text)) return 'account';
    if (/支付卡故障|拒付|卡片不可用|换卡/i.test(text)) return 'card';
    if (/繁忙|上限|受限|排队/i.test(text)) return 'capacity';
    if (/暂未开放|维护|套餐不支持|配置/i.test(text)) return 'configuration';
    if (/待确认|超时|网络/i.test(text)) return 'transport';
    return 'unknown';
}

module.exports = { buildCustomerGuidance };
