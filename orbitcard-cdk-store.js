'use strict';
const { requiresManualHandling } = require('./payment-automation');
const { cardScope, planFor } = require('./orbitcard-card-policy');
const { terminalUpstreamSnapshot } = require('./orbitcard-client');
const { MAX_PAYMENT_ATTEMPTS, confirmedFailure } = require('./payment-retry-policy');

// Transaction boundaries keep task creation, order linkage and CDK ownership consistent.
module.exports = function createOrbitcardCdkStore({ withTransaction, runQuery, runExecute, createTaskLog, settleCardUse = async () => {}, enqueueRedemption = async () => {} }) {
    async function hasPendingPreparation(task, options) {
        const funding = await runQuery(`SELECT funding_key FROM orbitcard_card_fundings WHERE job_key=?
            AND state IN ('prepared','submitting','pending','unknown') FOR UPDATE`, [task.job_key], options);
        const issue = await runQuery(`SELECT issue_key FROM orbitcard_card_issues WHERE (job_key=? OR issue_key=?)
            AND state IN ('prepared','submitting','pending','unknown') FOR UPDATE`, [task.job_key, task.orbitcard_issue_key || null], options);
        return Boolean(funding.length || issue.length);
    }

    async function ownsPreparedCard(task, options) {
        const cardId = Number(task.orbitcard_card_id);
        if (!Number.isSafeInteger(cardId) || cardId < 1) return false;
        const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE',
            [cardScope(task.orbitcard_base_url), cardId], options);
        return Boolean(card && card.active_job === task.job_key && card.provider_status === 'ACTIVE'
            && card.currency === 'USD' && card.balance != null);
    }

    async function canReleaseFundingReview(task, options) {
        const [funding] = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key=? FOR UPDATE', [task.job_key], options);
        if (!funding || !['ready','failed'].includes(funding.state)
            || funding.scope !== cardScope(task.orbitcard_base_url) || funding.plan_type !== planFor(task.orbitcard_plan_type)
            || Number(funding.card_id) !== Number(task.orbitcard_card_id)
            || (task.orbitcard_api_key_hash && funding.credential_hash !== task.orbitcard_api_key_hash)) return false;
        const cardId = Number(task.orbitcard_card_id);
        if (!Number.isSafeInteger(cardId) || cardId < 1) return false;
        const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE',
            [funding.scope, cardId], options);
        return Boolean(card && card.active_job === task.job_key);
    }

    async function canReleaseCardReview(task, options) {
        const issues = await runQuery('SELECT * FROM orbitcard_card_issues WHERE job_key=? OR issue_key=? FOR UPDATE',
            [task.job_key, task.orbitcard_issue_key || null], options);
        const [issue] = issues;
        if (issues.length !== 1 || !['ready','failed'].includes(issue.state) || issue.job_key !== task.job_key
            || (task.orbitcard_issue_key && issue.issue_key !== task.orbitcard_issue_key)
            || issue.scope !== cardScope(task.orbitcard_base_url) || issue.plan_type !== planFor(task.orbitcard_plan_type)
            || (task.orbitcard_api_key_hash && issue.credential_hash !== task.orbitcard_api_key_hash)
            || (issue.state === 'ready' && (!Number.isSafeInteger(Number(issue.card_id)) || Number(issue.card_id) < 1))) return false;
        const [funding] = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key=? FOR UPDATE', [task.job_key], options);
        if (funding && !await canReleaseFundingReview(task, options)) return false;
        if (task.orbitcard_card_id != null) {
            if (issue.card_id != null && Number(issue.card_id) !== Number(task.orbitcard_card_id)) return false;
            const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE',
                [issue.scope, task.orbitcard_card_id], options);
            if (!card || card.active_job !== task.job_key) return false;
        }
        return true;
    }

    async function createOrbitcardTask({ cdk, planType, email, baseUrl, apiKeyHash = null }) {
        return withTransaction(async connection => {
            const options = { connection };
            const rows = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const code = rows[0];
            if (!code || !code.is_active || code.used_at || code.type !== '自助') return null;
            if (String(code.plan_type || 'plus') !== String(planType)) return null;
            const unfinished = await runQuery(`SELECT job_key FROM task_logs WHERE cdk_code = ?
                AND (status IN ('running','manual') OR orbitcard_state IN ('preparing','prepared','funding_waiting','funding_review','retry_waiting','support_locked','balance_blocked','funding_pending','submitting','pending','manual','success')) LIMIT 1`, [cdk], options);
            if (unfinished.length) return null;
            const task = await createTaskLog({ tokenPreview: email || 'Orbitcard', cdkCode: cdk, status: 'running', progress: 3 }, options);
            const identity = require('./orbitcard-cdk').clientOrderNo(cdk, task.jobKey);
            await runExecute(`UPDATE task_logs SET orbitcard_client_order_no = ?, orbitcard_state = 'preparing',
                orbitcard_plan_type = ?, orbitcard_email = ?, orbitcard_base_url = ?,
                orbitcard_retry_root_job_key = ?, orbitcard_retry_attempt_no = 1,
                orbitcard_api_key_hash = ? WHERE job_key = ?`,
            [identity, planType, email || '', baseUrl, task.jobKey, apiKeyHash, task.jobKey], options);
            await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ?', [cdk], options);
            return { ...task, orbitcardState: 'preparing', orbitcardClientOrderNo: identity, orbitcardRetryRootJobKey: task.jobKey, orbitcardRetryAttemptNo: 1 };
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
            const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const rows = await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options);
            const task = rows[0];
            if (!task?.orbitcard_client_order_no) throw new Error('兑换任务未绑定 Orbitcard 订单');
            if (expectedState && task.orbitcard_state !== expectedState) return { applied: false, status: task.status };
            if (expectedClientOrderNo && task.orbitcard_client_order_no !== expectedClientOrderNo) return { applied: false, status: task.status };
            if (gptApiOrderId && task.gpt_api_order_id && task.gpt_api_order_id !== gptApiOrderId) return { applied: false, status: task.status };
            if (['preparing','prepared','submitting','funding_waiting','funding_review'].includes(orbitcardState)) {
                const allowedFrom = orbitcardState === 'submitting' ? ['prepared']
                    : orbitcardState === 'preparing' ? ['preparing'] : ['preparing','prepared','funding_waiting'];
                if (!allowedFrom.includes(expectedState) || !expectedClientOrderNo || task.orbitcard_state !== expectedState) {
                    return { applied: false, status: task.status };
                }
                if (task.orbitcard_state === 'funding_waiting' && orbitcardState === 'prepared') {
                    const [funding] = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key=? FOR UPDATE', [jobKey], options);
                    if (!funding || funding.state !== 'ready' || Number(funding.card_id) !== Number(task.orbitcard_card_id)) {
                        return { applied: false, status: task.status };
                    }
                }
                if (task.orbitcard_state === 'preparing' && orbitcardState === 'prepared') {
                    if (!await ownsPreparedCard(task, options) || await hasPendingPreparation(task, options)) {
                        return { applied: false, status: task.status };
                    }
                    const [funding] = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key=? FOR UPDATE', [jobKey], options);
                    if (funding && (funding.state !== 'ready' || Number(funding.card_id) !== Number(task.orbitcard_card_id))) {
                        return { applied: false, status: task.status };
                    }
                    if (task.orbitcard_issue_key) {
                        const [issue] = await runQuery('SELECT * FROM orbitcard_card_issues WHERE issue_key=? FOR UPDATE', [task.orbitcard_issue_key], options);
                        if (!issue || issue.state !== 'ready' || Number(issue.card_id) !== Number(task.orbitcard_card_id)) {
                            return { applied: false, status: task.status };
                        }
                    }
                }
                if (orbitcardState === 'funding_review') status = 'manual';
            }
            const latest = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            if (latest[0]?.job_key !== jobKey) return { applied: false, status: task.status };
            // Stale reads must never release a code after confirmed success, nor reopen a failed attempt.
            if (task.orbitcard_state === 'success' && orbitcardState !== 'success') return { applied: false, status: 'success' };
            if (task.orbitcard_state === 'support_locked') return { applied: false, status: 'failed' };
            if (['failed', 'rejected'].includes(task.orbitcard_state)) return { applied: false, status: task.status };
            const reviewingFunding = ['funding_review','funding_pending'].includes(task.orbitcard_state);
            const reviewRelease = reviewingFunding && orbitcardState === 'rejected';
            const reviewStop = reviewingFunding && orbitcardState === 'funding_pending';
            const reviewStart = orbitcardState === 'funding_review'
                && ['preparing','prepared','funding_waiting'].includes(task.orbitcard_state);
            const issueRelease = task.orbitcard_state === 'card_pending' && orbitcardState === 'rejected';
            if (issueRelease && (expectedState !== 'card_pending' || expectedClientOrderNo !== task.orbitcard_client_order_no
                || task.gpt_api_order_id || !await canReleaseCardReview(task, options))) return { applied: false, status: task.status };
            if (reviewingFunding) {
                if ((!reviewRelease && !reviewStop) || expectedState !== task.orbitcard_state
                    || expectedClientOrderNo !== task.orbitcard_client_order_no || task.gpt_api_order_id) {
                    return { applied: false, status: task.status };
                }
                if (reviewRelease && !await canReleaseFundingReview(task, options)) return { applied: false, status: task.status };
                if (reviewStop) status = 'manual';
            }
            const paymentState = orbitcardState;
            if (Number(task.orbitcard_retry_attempt_no || 1) > 1 && ['failed','rejected'].includes(orbitcardState)) {
                orbitcardState = 'support_locked';
                status = 'failed';
                message = '换卡重试已停止，CDK 保持售后锁定；' + String(message || '').slice(0, 180);
            }
            if ((reviewRelease || issueRelease) && (code?.manual_redeemed_at || Number(task.orbitcard_retry_attempt_no || 1) > 1)) {
                orbitcardState = 'support_locked';
                status = 'failed';
                message = code?.manual_redeemed_at
                    ? '原资金操作已完成核对，支付卡占用已释放；CDK 已人工核销，不再自动支付'
                    : '原资金操作已完成核对，支付卡占用已释放；历史重试任务的 CDK 保持售后锁定';
            }
            const manual = requiresManualHandling(task);
            if (manual && !reviewRelease && !reviewStop && !reviewStart && !issueRelease) {
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
            if (['preparing','prepared','funding_waiting','funding_review','funding_pending','card_pending'].includes(task.orbitcard_state) && ['failed','rejected'].includes(paymentState)) {
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
            const card = Number(cardId);
            if (!task || latest[0]?.job_key !== jobKey || task.orbitcard_client_order_no !== clientOrderNo
                || Number(task.orbitcard_card_id) !== card || !Number.isSafeInteger(card) || card < 1
                || !['submitting','pending','manual'].includes(task.orbitcard_state)) {
                return { applied: false };
            }
            const failure = JSON.parse(raw || '{}');
            if (failure.query_source && failure.query_source !== 'upstream' && !terminalUpstreamSnapshot(failure)) {
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
            const attempt = Number(task.orbitcard_retry_attempt_no || 1);
            const retry = code?.is_active && !code.manual_redeemed_at && !requiresManualHandling(task)
                && Number.isSafeInteger(attempt) && attempt < MAX_PAYMENT_ATTEMPTS
                && confirmedFailure(failure, { clientOrderNo, orderId, cardId: card,
                    planType: require('./plan-registry').PROVIDER_PLANS[planFor(task.orbitcard_plan_type)], email: task.orbitcard_email });
            await runExecute(`UPDATE task_logs SET status = ?, progress = 99, message = ?, orbitcard_state = ?,
                gpt_api_order_id = ?, gpt_api_raw = ?, session_payload = NULL WHERE job_key = ?`,
            [retry ? 'running' : 'failed', retry ? `第 ${attempt} 次充值已明确失败，等待换卡重试（最多 ${MAX_PAYMENT_ATTEMPTS} 次）`
                : code?.manual_redeemed_at ? '原平台订单支付失败；卡密已由人工售后核销，不再重试'
                    : require('./log-safety').sanitize(failure.failureMessage || '订阅失败，已停止充值，请联系售后QQ 2244527967处理'),
            retry ? 'retry_waiting' : 'support_locked', orderId, raw, jobKey], options);
            const uses = await runQuery('SELECT card_id, state FROM orbitcard_card_uses WHERE job_key = ?', [jobKey], options);
            if (Number(uses[0]?.card_id) !== card || uses[0]?.state !== 'reserved') {
                throw new Error('卡片预占记录不一致，不能自动重试');
            }
            await settleCardUse(jobKey, 'failed', options);
            await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [cdk], options);
            return { applied: true, retry };
        });
    }

    async function claimOrbitcardRetry(jobKey, { email, baseUrl, apiKeyHash }) {
        const [initial] = await runQuery('SELECT cdk_code FROM task_logs WHERE job_key = ?', [jobKey]);
        if (!initial) return null;
        return withTransaction(async connection => {
            const options = { connection }, cdk = initial.cdk_code;
            const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], options);
            const [task] = await runQuery('SELECT * FROM task_logs WHERE job_key = ? FOR UPDATE', [jobKey], options);
            const [latest] = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? ORDER BY id DESC LIMIT 1', [cdk], options);
            const attempt = Number(task?.orbitcard_retry_attempt_no || 1);
            if (!code?.is_active || code.manual_redeemed_at || task?.status !== 'running' || task.orbitcard_state !== 'retry_waiting'
                || latest?.job_key !== jobKey || !Number.isSafeInteger(attempt) || attempt < 1 || attempt >= MAX_PAYMENT_ATTEMPTS) return null;
            if (String(task.orbitcard_email).toLowerCase() !== String(email).toLowerCase()
                || task.orbitcard_base_url !== baseUrl || task.orbitcard_api_key_hash !== apiKeyHash) {
                throw new Error('重试账号、平台或密钥与原订单不一致');
            }
            const failure = JSON.parse(task.gpt_api_raw || '{}');
            if (!confirmedFailure(failure, { orderId: task.gpt_api_order_id, clientOrderNo: task.orbitcard_client_order_no,
                cardId: task.orbitcard_card_id, planType: require('./plan-registry').PROVIDER_PLANS[planFor(task.orbitcard_plan_type)], email })) return null;
            if (await hasPendingPreparation(task, options)) return null;
            const next = await createTaskLog({ tokenPreview: email, cdkCode: cdk, status: 'running', progress: 3 }, options);
            const root = task.orbitcard_retry_root_job_key || jobKey;
            const first = task.orbitcard_retry_first_card_id || task.orbitcard_card_id;
            const second = attempt === 2 ? task.orbitcard_card_id : task.orbitcard_retry_second_card_id || null;
            const identity = require('./orbitcard-cdk').clientOrderNo(cdk, next.jobKey);
            await runExecute(`UPDATE task_logs SET orbitcard_client_order_no = ?, orbitcard_state = 'preparing',
                orbitcard_plan_type = ?, orbitcard_email = ?, orbitcard_base_url = ?, orbitcard_retry_root_job_key = ?,
                orbitcard_retry_attempt_no = ?, orbitcard_retry_first_card_id = ?, orbitcard_retry_second_card_id = ?,
                orbitcard_api_key_hash = ? WHERE job_key = ?`,
            [identity, task.orbitcard_plan_type, email, baseUrl, root, attempt + 1, first, second, apiKeyHash, next.jobKey], options);
            await runExecute(`UPDATE task_logs SET status = ?, progress = 99, message = ?, orbitcard_state = ?,
                gpt_api_order_id = ?, gpt_api_raw = ?, session_payload = NULL WHERE job_key = ?`,
            ['failed', '本次支付已失败，已创建下一次换卡尝试', 'failed', task.gpt_api_order_id, task.gpt_api_raw, jobKey], options);
            return { ...next, orbitcardState: 'preparing', orbitcardClientOrderNo: identity,
                orbitcardRetryRootJobKey: root, orbitcardRetryAttemptNo: attempt + 1,
                orbitcardRetryFirstCardId: first, orbitcardRetrySecondCardId: second, planType: task.orbitcard_plan_type };
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
            const selectionExhausted = details.cardSelectionExhausted === true && ['preparing','prepared'].includes(expectedState);
            const legacyRetry = details.legacyRetry === true && expectedState === 'retry_waiting';
            if (!task || latest[0]?.job_key !== jobKey || task.orbitcard_state !== expectedState
                || (Number(task.orbitcard_retry_attempt_no || 1) < 2 && !selectionExhausted && !legacyRetry)) return { applied: false };
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
        recordOrbitcardPaymentFailure, claimOrbitcardRetry, lockOrbitcardSupport };
};
