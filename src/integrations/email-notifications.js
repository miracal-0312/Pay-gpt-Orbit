'use strict';
const crypto = require('node:crypto');
const { confirmedSuccess, confirmedFailure, confirmedRejection } = require('../payments/payment-retry-policy');
const { PLAN_LABELS, PROVIDER_PLANS, paymentPlan } = require('../config/plan-registry');
const { classifyFailure } = require('../orbitcard/orbitcard-error-policy');
const { cardScope } = require('../orbitcard/orbitcard-card-policy');
const money = require('../orbitcard/orbitcard-money');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const identifier = value => /^[a-zA-Z0-9_.:-]{1,128}$/.test(String(value || '')) ? String(value) : '未记录';
const emailAddress = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) ? value : '未记录';
function eventEnabled(config, type) {
    return type === 'low_balance' ? config.on_low_balance : type === 'order_success' ? config.on_success : config.on_failure;
}
function orderEvent(row, targetEmail) {
    if (!['success','failed','rejected','support_locked'].includes(row.state)) return null;
    let snapshot = null, plan;
    try { snapshot = JSON.parse(row.snapshot || '{}'); } catch (_) { /* Unknown proof cannot claim success. */ }
    try { plan = paymentPlan(row.plan_type); } catch (_) { plan = null; }
    const expected = { clientOrderNo:row.client_order_no,orderId:row.order_no,cardId:row.card_id,
        planType:plan ? PROVIDER_PLANS[plan] : row.plan_type,email:row.target_email };
    let type, subject, result;
    if (row.state === 'success') {
        if (!confirmedSuccess(snapshot, expected)) return null;
        type = 'order_success'; subject = '订阅充值成功'; result = '平台已确认订阅充值成功。';
    } else if (confirmedFailure(snapshot, expected) || confirmedRejection(snapshot, expected)) {
        type = 'order_failure'; subject = '订阅充值失败';
        result = `原订单已确认失败或未受理。${classifyFailure(snapshot).message}`;
    } else {
        type = 'order_review'; subject = '充值未完成，需人工处理';
        result = '本地任务已停止自动支付，但没有足够证据判断订阅付款结果。请在后台核对原订单、卡片及资金记录，勿直接重复充值。';
    }
    const source = row.source_type === 'self_service' ? '自助兑换' : row.mode === 'fulfillment' ? '管理员人工交付' : '管理员测试';
    const updated = Number(row.updated_ms), time = Number.isFinite(updated) && updated > 0
        ? `${new Date(updated).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）` : '未记录';
    const lines = [result,'',`来源：${source}`,`任务：${identifier(row.business_key)}`,
        `平台订单：${identifier(row.order_no)}`,`本次请求：${identifier(row.client_order_no)}`,
        `套餐：${plan ? PLAN_LABELS[plan] : '未识别套餐'}`,`账号邮箱：${emailAddress(row.target_email)}`,`结果时间：${time}`];
    if (type === 'order_success' && Number.isFinite(snapshot?.payment?.amount) && snapshot.payment.amount >= 0
        && /^[A-Z]{3}$/.test(snapshot.payment.currency)) {
        lines.push(`平台返回支付金额：${snapshot.payment.amount} ${snapshot.payment.currency}`);
    }
    lines.push('', '请登录管理后台查看原始订单和脱敏审计。此通知不执行补款、退款或再次订阅。');
    return { event_id:hash(JSON.stringify([row.source_type,row.business_key,type,targetEmail.trim().toLowerCase()])),
        event_type:type,subject:`[Pay-gpt-Orbit] ${subject}`,text:lines.join('\n') };
}

module.exports = function createEmailNotifications({ store, mailer, provider, now = Date.now, audit = () => {} }) {
    let stopped = false, activeTick = null, activeTest = null, nextTestAt = 0;
    function record(event, text, data = {}) {
        try { audit({ jobKey:'',source:'email',event,text,data }); } catch (_) { /* Mail auditing cannot affect payment. */ }
    }
    async function orders(config) {
        const rows = await store.listEmailOrderCandidates({ since:config.enabled_since,targetEmail:config.to_email });
        for (const row of rows) {
            if (stopped) break;
            const event = orderEvent(row,config.to_email);
            await store.commitEmailObservation(row,config.to_email,event && eventEnabled(config,event.event_type) ? event : null);
        }
    }
    async function balance(config) {
        if (!config.on_low_balance || stopped) return;
        const platformConfig = await store.getGptApiConfig();
        if (!platformConfig?.api_key || !platformConfig.base_url) return;
        const accountKey = hash(`${cardScope(platformConfig.base_url)}|${hash(platformConfig.api_key.trim())}`);
        const claim = await store.claimEmailBalanceCheck(accountKey,config.to_email);
        if (!claim) return;
        try {
            const result = await provider.request(platformConfig,'getAccountBalance');
            if (!result?.success || result.status !== 200 || result.requestError || result.data?.request_error || result.code != null && result.code !== 0) {
                await store.deferEmailBalanceCheck(claim,result?.retryAfterMs);
                record('email_balance_check_deferred','余额预警暂未取得有效余额，将按间隔重查');
                return;
            }
            const available = money.units(result.data?.available_balance), threshold = money.units(config.balance_threshold);
            await store.completeEmailBalanceCheck(claim,{ low:available<threshold,available:money.decimal(available),threshold:money.decimal(threshold),
                platform:new URL(platformConfig.base_url).origin,cooldown_minutes:config.balance_cooldown_minutes });
        } catch (_) {
            await store.deferEmailBalanceCheck(claim);
            record('email_balance_check_deferred','余额预警查询暂不可用，未将失败当作余额为零');
        }
    }
    async function deliver(config) {
        const types = ['order_success','order_failure','order_review','low_balance'].filter(type => eventEnabled(config,type));
        const events = await store.listPendingEmails(config.to_email,types);
        for (const event of events) {
            if (stopped) break;
            const token = await store.claimEmailDelivery(event.event_id);
            if (!token) continue;
            let result;
            try {
                // Re-read at the point of delivery: disabling notifications or
                // changing recipient must not send an old captured configuration.
                const current = await store.getEmailConfig();
                if (stopped || !current.enabled || !eventEnabled(current,event.event_type)
                    || current.to_email.trim().toLowerCase() !== event.target_email.trim().toLowerCase()) result = { deferred:true };
                else result = await mailer.send(current,{subject:event.subject,text:event.body,messageId:`<${event.event_id}@pay-gpt-orbit.local>`});
            } catch (_) { result = {ok:false,error_code:'smtp_transport'}; }
            await store.finishEmailDelivery(event.event_id,token,result);
            if (!result?.deferred) record(result?.ok ? 'email_delivered' : 'email_delivery_deferred',
                result?.ok ? '管理员邮件已交给邮件服务器' : '管理员邮件未确认发送，保留队列并有限重试',
                { event_id:event.event_id,event_type:event.event_type });
        }
    }
    async function runTick() {
        try {
            const config = await store.getEmailConfig();
            if (stopped || !config.enabled) return;
            // Independent failures do not prevent delivery of an already saved event.
            for (const [name, action] of [['orders',orders],['balance',balance],['delivery',deliver]]) {
                if (stopped) break;
                try { await action(config); }
                catch (_) { record('email_worker_deferred','管理员邮件处理暂不可用，将在后续检查重试',{stage:name}); }
            }
        } catch (_) { record('email_config_unavailable','邮件配置暂不可用，未影响充值处理'); }
    }
    function tick() {
        if (stopped) return Promise.resolve();
        if (activeTick) return activeTick;
        activeTick = runTick().finally(() => { activeTick = null; });
        return activeTick;
    }
    function testEmail() {
        if (stopped) return Promise.resolve({success:false,message:'服务正在停止，请稍后测试'});
        if (activeTest || now()<nextTestAt) return Promise.resolve({success:false,message:'测试邮件每分钟最多发送一次，请稍后再试'});
        nextTestAt = now()+60000;
        activeTest = (async () => {
            try {
                const config = await store.getEmailConfig();
                if (stopped) return {success:false,message:'服务正在停止，请稍后测试'};
                const result = await mailer.send(config,{subject:'[Pay-gpt-Orbit] 管理员邮件测试',
                    text:`这是一封管理员通知测试邮件。\n\n测试时间：${new Date(now()).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）\n此测试不会发起任何开卡、充值或订阅。`,
                    messageId:`<test-${crypto.randomUUID()}@pay-gpt-orbit.local>`});
                return result?.ok ? {success:true,message:'测试邮件已交给邮件服务器，请检查收件箱或垃圾邮件'}
                    : {success:false,message:result?.message || '测试邮件未确认发送，请检查已保存的邮件配置'};
            } catch (_) { return {success:false,message:'测试邮件未确认发送，请检查已保存的邮件配置'}; }
        })().finally(() => { activeTest = null; });
        return activeTest;
    }
    async function stop() {
        stopped = true;
        await Promise.allSettled([activeTick,activeTest].filter(Boolean));
    }
    return { tick,testEmail,stop };
};
module.exports.orderEvent = orderEvent;
