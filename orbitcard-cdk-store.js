'use strict';
const { requiresManualHandling } = require('./payment-automation');

// Transaction boundaries keep task creation, order linkage and CDK ownership consistent.
module.exports = function createOrbitcardCdkStore({ withTransaction, runQuery, runExecute, createTaskLog, settleCardUse = async () => {}, enqueueRedemption = async () => {} }) {
    async function hasPendingPreparation(task, options) {
        const funding = await runQuery(`SELECT funding_key FROM orbitcard_card_fundings WHERE job_key=?
            AND state IN ('prepared','submitting','pending','unknown') FOR UPDATE`, [task.job_key], options);
        const issue = task.orbitcard_issue_key ? await runQuery(`SELECT issue_key FROM orbitcard_card_issues WHERE issue_key=?
            AND state IN ('prepared','submitting','pending','unknown') FOR UPDATE`, [task.orbitcard_issue_key], options) : [];
        return Boolean(funding.length || issue.length);
    }

    async function createOrbitcardTask({ cdk, planType, email, baseUrl, apiKeyHash = null }) {
        return withTransaction(async connection => {
            const options = { connection };
            const rows = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const code = rows[0];
            if (!code || !code.is_active || code.used_at || code.type !== '自助') return null;
            if (String(code.plan_type || 'plus') !== String(planType)) return null;
            const unfinished = await runQuery(`SELECT job_key FROM task_logs WHERE cdk_code = ?
                AND (status IN ('running','manual') OR orbitcard_state IN ('prepared','retry_waiting','support_locked','balance_blocked','funding_pending','submitting','pending','manual','success')) LIMIT 1`, [cdk], options);
            if (unfinished.length) return null;
            const task = await createTaskLog({ tokenPreview: email || 'Orbitcard', cdkCode: cdk, status: 'running', progress: 3 }, options);
            const identity = require('./orbitcard-cdk').clientOrderNo(cdk, task.jobKey);
            await runExecute(`UPDATE task_logs SET orbitcard_client_order_no = ?, orbitcard_state = 'prepared',
                orbitcard_plan_type = ?, orbitcard_email = ?, orbitcard_base_url = ?,
                orbitcard_retry_root_job_key = ?, orbitcard_retry_attempt_no = 1,
                orbitcard_api_key_hash = ? WHERE job_key = ?`,
            [identity, planType, email || '', baseUrl, task.jobKey, apiKeyHash, task.jobKey], options);
            await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ?', [cdk], options);
            return { ...task, orbitcardClientOrderNo: identity, orbitcardRetryRootJobKey: task.jobKey, orbitcardRetryAttemptNo: 1 };
        });
    }

    async function getOrbitcardTaskByCdk(cdk) {
        const rows = await runQuery(`SELECT t.*, c.manual_redeemed_at FROM task_logs t JOIN cdk_codes c ON c.cdk_code = t.cdk_code
            WHERE t.cdk_code = ? AND c.is_active = 1 AND t.orbitcard_client_order_no IS NOT NULL
            ORDER BY t.id DESC LIMIT 1`, [cdk]);
        return rows[0] || null;
    }

    async function settleOrbitcardTask(jobKey, input) {
        const initial = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial[0]) throw new Error('兑换任务不存在');
        return withTransaction(async connection => {
            let { status, progress, message, orbitcardState, gptApiOrderId, gptApiRaw, expectedState, expectedClientOrderNo } = input;
            const options = { connection };
            const cdk = initial[0].cdk_code;
            // Every transaction takes CDK then task locks in the same order.
            await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const rows = await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options);
            const task = rows[0];
            if (!task?.orbitcard_client_order_no) throw new Error('兑换任务未绑定 Orbitcard 订单');
            if (expectedState && task.orbitcard_state !== expectedState) return { applied: false, status: task.status };
            if (expectedClientOrderNo && task.orbitcard_client_order_no !== expectedClientOrderNo) return { applied: false, status: task.status };
            if (gptApiOrderId && task.gpt_api_order_id && task.gpt_api_order_id !== gptApiOrderId) return { applied: false, status: task.status };
            if (['prepared','submitting'].includes(orbitcardState)
                && (expectedState !== 'prepared' || !expectedClientOrderNo || task.orbitcard_state !== 'prepared')) {
                return { applied: false, status: task.status };
            }
            const latest = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            if (latest[0]?.job_key !== jobKey) return { applied: false, status: task.status };
            // Stale reads must never release a code after confirmed success, nor reopen a failed attempt.
            if (task.orbitcard_state === 'success' && orbitcardState !== 'success') return { applied: false, status: 'success' };
            if (task.orbitcard_state === 'support_locked') return { applied: false, status: 'failed' };
            if (['failed', 'rejected'].includes(task.orbitcard_state)) return { applied: false, status: task.status };
            const manual = requiresManualHandling(task);
            const paymentState = orbitcardState;
            if (manual) {
                // Handoff is durable: a pending query cannot put the task back in the payment loop.
                if (!['submitting', 'pending', 'manual'].includes(task.orbitcard_state)
                    || !['pending', 'manual', 'success', 'failed', 'rejected'].includes(orbitcardState)) {
                    return { applied: false, status: task.status };
                }
                if (['failed', 'rejected'].includes(orbitcardState)) {
                    orbitcardState = 'support_locked';
                    status = 'failed';
                    message = '原订单已确认失败，自动支付已停止；CDK 保持锁定，请人工售后处理';
                } else if (orbitcardState !== 'success') {
                    orbitcardState = 'manual';
                    status = 'manual';
                    message = '已转人工处理，自动支付已停止；仅核对原订单结果，勿重复充值';
                }
            }
            if (task.orbitcard_state === 'prepared' && ['failed','rejected'].includes(orbitcardState)) {
                // Recheck inside the transaction: a recovery snapshot can predate
                // a funding/issuance intent committed by a worker losing its lock.
                if (await hasPendingPreparation(task, options)) return { applied: false, status: task.status };
            }
            await runExecute(`UPDATE task_logs SET status = ?, progress = GREATEST(progress, ?), message = ?,
                orbitcard_state = ?, gpt_api_order_id = COALESCE(?, gpt_api_order_id),
                gpt_api_raw = COALESCE(?, gpt_api_raw), session_payload = NULL WHERE job_key = ?`,
            [status, Number(progress || 0), message, orbitcardState, gptApiOrderId || null, gptApiRaw || null, jobKey], options);
            if (['failed', 'rejected'].includes(orbitcardState)) {
                await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ? AND manual_redeemed_at IS NULL', [cdk], options);
            } else {
                await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [cdk], options);
            }
            await settleCardUse(jobKey, paymentState, options);
            if (status === 'success' && orbitcardState === 'success' && task.orbitcard_state !== 'success') {
                await enqueueRedemption({ cdk, orderId: task.orbitcard_retry_root_job_key || jobKey }, options);
            }
            return { applied: true, status };
        });
    }

    async function recordOrbitcardPaymentFailure(jobKey, { clientOrderNo, cardId, orderId, raw }) {
        const initial = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial[0]) throw new Error('兑换任务不存在');
        return withTransaction(async connection => {
            const options = { connection }, cdk = initial[0].cdk_code;
            const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const task = (await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options))[0];
            const latest = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            const card = Number(cardId), attempt = Number(task?.orbitcard_retry_attempt_no || 1);
            if (!task || latest[0]?.job_key !== jobKey || task.orbitcard_client_order_no !== clientOrderNo
                || Number(task.orbitcard_card_id) !== card || !Number.isSafeInteger(card) || card < 1
                || !['submitting','pending','manual'].includes(task.orbitcard_state) || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
                return { applied: false };
            }
            const firstCardId = Number(task.orbitcard_retry_first_card_id || 0);
            const secondCardId = Number(task.orbitcard_retry_second_card_id || 0);
            if ((attempt === 2 && (!firstCardId || firstCardId === card))
                || (attempt === 3 && (!firstCardId || !secondCardId || firstCardId === secondCardId
                    || firstCardId === card || secondCardId === card))) {
                throw new Error('支付重试卡片与固定选卡规则不一致');
            }
            const failure = JSON.parse(raw || '{}');
            if (failure.query_source && failure.query_source !== 'upstream') {
                throw new Error('订阅详情不是本次验证的上游结果，不能自动重试');
            }
            if (failure.upstream_status && failure.status && failure.upstream_status !== failure.status) {
                throw new Error('订阅状态字段不一致，不能自动重试');
            }
            if (failure.subscription_succeeded === true || failure.upstream_status === 'succeeded' || failure.status === 'succeeded') {
                throw new Error('平台已确认订阅成功，不能记录为支付失败');
            }
            if (['pending','processing'].includes(failure.upstream_status) || ['pending','processing'].includes(failure.status)) {
                throw new Error('上游订阅仍在处理中，不能自动重试');
            }
            if (failure.subscription_succeeded !== false && failure.upstream_status !== 'failed' && failure.status !== 'failed') {
                throw new Error('缺少平台明确的订阅失败终态，不能自动重试');
            }
            if (!orderId || (task.gpt_api_order_id && task.gpt_api_order_id !== orderId) || (failure.task_no && failure.task_no !== orderId)
                || (failure.orderId && failure.orderId !== orderId)
                || (failure.client_order_no && failure.client_order_no !== clientOrderNo)
                || (failure.card_id != null && Number(failure.card_id) !== card)) {
                throw new Error('失败订单归属不一致，不能自动重试');
            }
            const manual = requiresManualHandling(task);
            const exhausted = attempt === 3 || manual || Boolean(code?.manual_redeemed_at);
            await runExecute(`UPDATE task_logs SET status = ?, progress = 99, message = ?, orbitcard_state = ?,
                gpt_api_order_id = ?, gpt_api_raw = ?, session_payload = NULL WHERE job_key = ?`,
            ['failed', code?.manual_redeemed_at ? '原平台订单支付失败；卡密已由人工售后核销，不再重试'
                : manual ? '原订单已确认失败，任务已转人工处理，不再换卡或充值' : exhausted
                ? '三张卡支付均已明确失败，CDK 已锁定；请联系人工售后'
                : `第 ${attempt} 次支付已明确失败，正在准备下一次尝试`,
            exhausted ? 'support_locked' : 'failed', orderId, raw, jobKey], options);
            const uses = await runQuery('SELECT card_id, state FROM orbitcard_card_uses WHERE job_key = ?', [jobKey], options);
            if (Number(uses[0]?.card_id) !== card || uses[0]?.state !== 'reserved') {
                throw new Error('卡片预占记录不一致，不能自动重试');
            }
            await settleCardUse(jobKey, 'failed', options);
            await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [cdk], options);
            if (exhausted) return { applied: true, exhausted: true, supportStopped: manual || Boolean(code?.manual_redeemed_at) };
            const next = await createTaskLog({ tokenPreview: task.orbitcard_email || 'Orbitcard', cdkCode: cdk, status: 'running', progress: 3 }, options);
            const identity = require('./orbitcard-cdk').clientOrderNo(cdk, next.jobKey);
            const first = Number(task.orbitcard_retry_first_card_id || (attempt === 1 ? card : 0)) || null;
            const second = Number(task.orbitcard_retry_second_card_id || (attempt === 2 ? card : 0)) || null;
            await runExecute(`UPDATE task_logs SET orbitcard_client_order_no = ?, orbitcard_state = 'retry_waiting',
                orbitcard_plan_type = ?, orbitcard_email = ?, orbitcard_base_url = ?,
                orbitcard_retry_root_job_key = ?, orbitcard_retry_attempt_no = ?,
                orbitcard_retry_first_card_id = ?, orbitcard_retry_second_card_id = ?,
                orbitcard_api_key_hash = ?, message = ? WHERE job_key = ?`, [identity, task.orbitcard_plan_type, task.orbitcard_email,
                task.orbitcard_base_url, task.orbitcard_retry_root_job_key || jobKey, attempt + 1,
                first, second, task.orbitcard_api_key_hash || null,
                `第 ${attempt} 次支付已明确失败；下一次尝试待开始，CDK 保持占用`, next.jobKey], options);
            return { applied: true, exhausted: false, nextTask: { ...next, orbitcardClientOrderNo: identity,
                orbitcardRetryRootJobKey: task.orbitcard_retry_root_job_key || jobKey,
                orbitcardRetryAttemptNo: attempt + 1, orbitcardRetryFirstCardId: first, orbitcardRetrySecondCardId: second } };
        });
    }

    async function claimOrbitcardRetryTask(jobKey, clientOrderNo) {
        const initial = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial[0]) return false;
        return withTransaction(async connection => {
            const options = { connection }, cdk = initial[0].cdk_code;
            const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            if (code?.manual_redeemed_at) return false;
            const task = (await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options))[0];
            const latest = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            if (!task || requiresManualHandling(task) || latest[0]?.job_key !== jobKey || task.orbitcard_state !== 'retry_waiting'
                || task.orbitcard_client_order_no !== clientOrderNo) return false;
            await runExecute("UPDATE task_logs SET orbitcard_state = 'prepared', message = '正在准备下一次支付尝试' WHERE job_key = ?", [jobKey], options);
            return true;
        });
    }

    async function lockOrbitcardSupport(jobKey, expectedState, message, details = {}) {
        const initial = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial[0]) return { applied: false };
        return withTransaction(async connection => {
            const options = { connection }, cdk = initial[0].cdk_code;
            await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const task = (await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options))[0];
            const latest = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            const selectionExhausted = details.cardSelectionExhausted === true && expectedState === 'prepared';
            if (!task || latest[0]?.job_key !== jobKey || task.orbitcard_state !== expectedState
                || (Number(task.orbitcard_retry_attempt_no || 1) < 2 && !selectionExhausted)) return { applied: false };
            // Support escalation releases the card too, so it needs the same
            // transactional funding check as ordinary preparation failure.
            if (await hasPendingPreparation(task, options)) return { applied: false };
            await runExecute(`UPDATE task_logs SET status = 'failed', orbitcard_state = 'support_locked', message = ?,
                gpt_api_order_id = COALESCE(?,gpt_api_order_id), gpt_api_raw = COALESCE(?,gpt_api_raw)
                WHERE job_key = ?`, [message, details.orderId || null, details.raw || null, jobKey], options);
            await settleCardUse(jobKey, 'failed', options);
            await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [cdk], options);
            return { applied: true };
        });
    }

    return { createOrbitcardTask, getOrbitcardTaskByCdk, settleOrbitcardTask,
        recordOrbitcardPaymentFailure, claimOrbitcardRetryTask, lockOrbitcardSupport };
};
