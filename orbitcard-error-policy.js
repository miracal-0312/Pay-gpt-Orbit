'use strict';

const { sanitize } = require('./log-safety');

// This module describes recovery actions. It never proves that a payment was
// rejected, verifies ownership, releases funds, or authorizes another POST.
// Callers must establish those facts before applying a classified failure.
const SUBSCRIPTION_OPERATIONS = new Set(['createSubscription', 'getSubscription', 'getSubscriptionList',
    'getSubscriptionPlans', 'getSubscriptionPaymentRegions']);
const ASSISTANT_OPERATIONS = new Set(['session', 'upgrade-price', 'auto-renewal', 'billing-portal', 'latest-session']
    .map(name => `/api/open/v1/assistants/gpt/${name}`));

const RULES = Object.freeze({
    unknown: ['unknown', 'review', '错误原因尚未确认，保留原订单和失败证据，请管理员核对后处理', true],
    network: ['transport', 'reconcile', '请求结果待确认，保留原订单和支付卡，稍后仅查询原记录', false],
    protocol: ['protocol', 'review', '平台结果不完整或归属不匹配，保留原记录，请管理员核对', true],
    parameters: ['configuration', 'fix_configuration', '请求参数无效，请管理员核对接口字段、类型和原请求，修复后再继续', true],
    authentication: ['authentication', 'fix_configuration', '平台认证失败，请管理员检查密钥、时间、签名、出口 IP 和 Nonce，保留原单核对', true],
    permission: ['authorization', 'fix_configuration', '接口权限不足，请管理员检查 API Key 的 Scope，保留原单核对', true],
    missing: ['identity', 'review', '原订单或卡片不存在，请核对平台账户和原身份；不能据此确认未受理或重新付款', true],
    conflict: ['identity', 'reconcile', '幂等身份冲突，请找回原请求和原幂等键；禁止更换金额、卡片或身份绕过冲突', true],
    oversized: ['configuration', 'fix_configuration', '请求内容超过接口上限，请检查重复包装和异常字段，保留完整必要凭据', true],
    rate: ['rate_limit', 'wait', '平台请求受限，请等待规定间隔并降低并发，继续确认原记录', false],
    service: ['configuration', 'fix_configuration', '卡台服务未启用或暂停接单，请管理员核对服务开关；已有订单保留并继续收尾', true],
    plan: ['configuration', 'fix_configuration', '套餐不支持或档位未配置，请管理员刷新套餐和核对配置，不能自动更换价格档位', true],
    session: ['session', 'refresh_session', '目标账号 Session 无效或已失效，请重新登录该账号并提交最新完整 Session；原单未知时先核对原单', true],
    authorization: ['authorization', 'confirm_authorization', '本次支付授权未确认，请核对真实授权后继续，不能通过换卡跳过授权', true],
    upstreamKey: ['configuration', 'fix_configuration', '卡台上游密钥未配置，请联系卡台管理员修复，暂停新的支付', true],
    feeLimit: ['configuration', 'review_fee', '当前服务费超过设定上限，请管理员核对费用后决定是否调整，系统不会自动提高上限', true],
    capacity: ['capacity', 'wait', '卡台处理中订单达到上限，请降低并发并等待已有订单完成，避免重复提交', false],
    retired: ['configuration', 'fix_configuration', '该核验写接口已停用，请使用原订单查询和只读审计，不能人工伪造订阅结果', true],
    card: ['card', 'replace_card', '已确认支付卡故障，停用原卡并按允许的渠道和 BIN 补开，在剩余支付次数内继续', true],
    account: ['account', 'review_account', '账号资格、订阅或账单存在问题，请先核对并处理目标账号，不能靠换卡解决', true],
    captcha: ['verification', 'complete_verification', '请完成原订单的人机验证并查询原订单，不能重新下单解决验证问题', false],
    assistantParameters: ['configuration', 'fix_configuration', '小助手参数无效，请按当前接口核对完整 Session、登录 Cookie、accountId、enabled 和 targetPlan', true],
    assistantChannel: ['account', 'review_account', '请核对实际订阅渠道；非网页订阅需通过原渠道处理，渠道未知时人工核对', true],
    assistantPlan: ['account', 'review_account', '已拥有目标套餐或目标为降档，请核对当前套餐；需要升级时由用户选择支持的更高档位', true],
    assistantAccount: ['account', 'review_account', '有效订阅、状态或档位尚未确认，请刷新目标账号信息后再操作', true],
    assistantEligibility: ['account', 'review_account', '账号无购买资格、有未结清账单或暂不支持升级，请先处理账号问题再查询', true],
    assistantQuote: ['protocol', 'reconcile', '报价缺少应付金额或币种，请重新查询，不能视为免费或用套餐标价代替', false],
    assistantRenewal: ['account', 'reconcile', '续费操作不可用、进行中或结果未确认，请先查询实际 willRenew，不能立即重复提交', false],
    assistantUpstream: ['upstream', 'reconcile', '小助手上游请求失败，请核对账号登录与服务状态；续费写操作先查询实际结果', false]
});

const PLATFORM_RULES = new Map([
    [11000, 'parameters'], [30004, 'conflict'],
    [59001, 'service'], [59002, 'plan'], [59004, 'session'], [59005, 'card'], [59007, 'authorization'],
    [59008, 'plan'], [59009, 'missing'], [59013, 'upstreamKey'], [59015, 'feeLimit'],
    [59016, 'capacity'], [59018, 'network'], [59019, 'retired']
]);
const ASSISTANT_RULES = new Map([
    ...[40030, 40031, 40032, 40033].map(code => [code, 'assistantParameters']),
    ...[42230, 40934].map(code => [code, 'session']),
    ...[42231, 42232].map(code => [code, 'assistantChannel']),
    ...[40935, 40936].map(code => [code, 'assistantPlan']),
    ...[40937, 40938, 40939].map(code => [code, 'assistantAccount']),
    ...[42233, 40940, 40941].map(code => [code, 'assistantEligibility']),
    [50233, 'assistantQuote'],
    ...[40930, 40931, 40932].map(code => [code, 'assistantRenewal']),
    ...[42900, 50331].map(code => [code, 'rate']),
    ...[50230, 50231, 50232, 50330].map(code => [code, 'assistantUpstream'])
]);

function primitiveCode(value) {
    return typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
        ? String(value).trim().slice(0, 128) : '';
}
function normalizeCode(value) {
    return primitiveCode(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
}
function safeText(value, length = 255) {
    const text = (typeof value === 'string' ? value : primitiveCode(value)).replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
    return sanitize(text).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length);
}
function numericCode(value) {
    const text = primitiveCode(value);
    return /^\d{5}$/.test(text) ? Number(text) : null;
}
function description(name) {
    const [category, action, message, stopTracking] = RULES[name];
    return { category, action, message, stopTracking };
}
function result(name, snapshot) {
    const { category, action, message } = description(name);
    const card = name === 'card';
    return { category, action, message, automaticRetry: card, disableCard: card,
        code: safeText(primitiveCode(snapshot?.failureCode), 128),
        reason: safeText(snapshot?.failureMessage || primitiveCode(snapshot?.failureCode) || message) };
}

function classifyFailure(snapshot) {
    const code = normalizeCode(snapshot?.failureCode);
    const message = typeof snapshot?.failureMessage === 'string' ? safeText(snapshot.failureMessage, 4096) : '';
    // These indicators can only veto a failure action; they cannot establish
    // verified failure on their own. Ownership/terminal evidence stays upstream.
    if (snapshot?.request_error || snapshot?.subscription_succeeded === true
        || [snapshot?.status, snapshot?.upstream_status].some(state => state != null && state !== '' && state !== 'failed')) {
        return result('network', snapshot);
    }
    const numeric = numericCode(code);
    if (numeric === 40027 || numeric === 59004) return result('session', snapshot);
    // Top-level business codes embedded in failureCode are not a documented
    // replacement for a create rejection. They may guide repair, never stop a card.
    if (numeric != null && PLATFORM_RULES.has(numeric)) {
        return result(numeric === 59005 ? 'unknown' : PLATFORM_RULES.get(numeric), snapshot);
    }
    if (/^(?:(?:invalid|expired|missing|revoked|unauthorized)_(?:session|access_token|session_token|cookie)|(?:session|access_token|session_token|login|cookie)_(?:invalid|expired|missing|revoked|failed|required|unauthorized))$/.test(code)) return result('session', snapshot);
    if (/^(?:(?:account|subscription|billing|eligibility|purchase|upgrade)_(?:invalid|restricted|blocked|suspended|disabled|ineligible|not_eligible|not_supported|already_exists|already_active|unpaid|past_due)|(?:already_subscribed|subscription_exists|unpaid_invoice|invoice_unpaid|ineligible_account))$/.test(code)) return result('account', snapshot);
    if (/^(?:(?:unsupported|invalid|missing)_(?:plan|region|configuration)|(?:plan|region|configuration)_(?:unsupported|invalid|missing|not_configured|not_supported)|(?:max_service_fee_exceeded|api_key_invalid|api_key_missing|permission_denied|authorization_required))$/.test(code)) return result('parameters', snapshot);
    if (/^(?:captcha|verification|authentication_challenge)(?:_(?:required|failed|expired|timeout|pending))?$/.test(code)) return result('captcha', snapshot);
    if (/^(?:network_error|request_timeout|upstream_timeout|timeout|connection_error|service_unavailable|rate_limit_exceeded|too_many_requests|relay_[a-z_]+)$/.test(code)) return result('network', snapshot);

    // Explicit non-card context takes precedence over ambiguous card wording.
    if (/(?:session|access[_ ]?token|session[_ ]?token|login cookie).{0,32}(?:expired|invalid|missing|revoked|failed)|(?:Session|登录凭据|登录状态|登录 Cookie|访问令牌).{0,24}(?:失效|过期|无效|缺失)|(?:重新登录|登录已失效)/i.test(message)) return result('session', snapshot);
    if (/(?:账户|账号|平台|钱包|服务费).{0,16}(?:余额不足|资金不足)|(?:account|wallet|platform|service fee).{0,24}(?:insufficient|balance too low)|insufficient (?:account|wallet|platform) (?:balance|funds)/i.test(message)) return result('account', snapshot);
    if (numeric != null) return result('unknown', snapshot);
    // Negative statements and unrelated words such as "discard" are not card
    // failure evidence. Ambiguous prose must not permanently disable a card.
    if (/(?:银行卡|信用卡|支付卡|卡片).{0,16}(?:未|没有|并非|不是).{0,8}(?:拒付|不可用|无效|过期|冻结|停用)|\b(?:card|payment method)\b.{0,20}\b(?:not|never|isn't|wasn't)\b.{0,8}\b(?:declined|invalid|expired|blocked|restricted|unavailable)\b/i.test(message)) return result('unknown', snapshot);
    const cardCode = /^(?:card_(?:error|declined|unavailable|not_available|invalid|expired|blocked|restricted|not_supported|limit_exceeded)|(?:invalid|expired|incorrect|unsupported|lost|stolen|restricted)_card|insufficient_funds|incorrect_cvc|invalid_cvc|do_not_honor|transaction_not_allowed|payment_method_declined)$/.test(code);
    const cardMessage = /(?:银行卡|信用卡|支付卡|卡片).{0,24}(?:拒绝|拒付|不可用|无效|过期|受限|限制|冻结|停用|余额不足)|\b(?:card|payment method)\b.{0,32}\b(?:declined|invalid|expired|blocked|restricted|not supported|unavailable)\b|\b(?:incorrect|invalid) (?:cvc|cvv)\b/i.test(message);
    if (cardCode || cardMessage) return result('card', snapshot);
    return result('unknown', snapshot);
}

function classifyApiError({ operation, status, code, requestError, retryAfterMs } = {}) {
    const platform = numericCode(code), upstream = numericCode(requestError?.upstream_code);
    const requestCode = normalizeCode(requestError?.code);
    const subscription = SUBSCRIPTION_OPERATIONS.has(operation), assistant = ASSISTANT_OPERATIONS.has(operation);
    let name;
    // Authentication, permission and identity conflicts cannot be downgraded by
    // a contradictory body. The transport status never proves payment outcome.
    if (status === 401) name = 'authentication';
    else if (status === 403) name = 'permission';
    else if (status === 409 || platform === 30004) name = 'conflict';
    else if (status === 413) name = 'oversized';
    else if (status === 429) name = 'rate';
    else if (requestCode === 'assistant_invalid_response') name = 'protocol';
    else if (requestCode === 'relay_query_busy') name = 'rate';
    else if (requestError?.source === 'upstream' && subscription && upstream === 40027) name = 'session';
    else if (requestError?.source === 'upstream' && assistant && ASSISTANT_RULES.has(upstream)) name = ASSISTANT_RULES.get(upstream);
    else if (platform === 11000) name = 'parameters';
    else if (subscription && PLATFORM_RULES.has(platform)) name = PLATFORM_RULES.get(platform);
    else if (status === 400) name = 'parameters';
    else if (status === 404) name = 'missing';
    else if (!status || [408, 500, 502, 503, 504].includes(status)) name = 'network';
    else if (requestCode.startsWith('relay_')) name = 'network';
    else name = 'unknown';
    // A card diagnosis on a query is not evidence of a failed payment. Only the
    // submission service may recognize the documented create-time rejection.
    if (name === 'card' && operation !== 'createSubscription') name = 'protocol';
    const hintMs = Number(retryAfterMs);
    const hintSeconds = Number(requestError?.retry_after_seconds);
    const delay = Math.max(0, Number.isFinite(hintMs) ? hintMs : 0, Number.isFinite(hintSeconds) ? hintSeconds * 1000 : 0);
    const policy = description(name);
    return { ...policy, retryAfterMs: Math.min(24 * 60 * 60 * 1000, Math.max(delay, policy.stopTracking ? 30000 : 5000)) };
}

module.exports = { classifyFailure, classifyApiError };
