'use strict';
const poolPolicy = require('../orbitcard/orbitcard-pool');

const { cardScope, planFor, FUNDING_POLL_MS } = require('../orbitcard/orbitcard-card-policy');
const { MAX_PAYMENT_ATTEMPTS, confirmedFailure, confirmedSuccess, confirmedRejection, retryableFailure, manualHistory } = require('../payments/payment-retry-policy');
const { classifyFailure } = require('../orbitcard/orbitcard-error-policy');

module.exports = function createManualStore({ runQuery, runExecute, withTransaction, enqueueRedemption = async () => {} }) {
    const usage = require('./orbitcard-order-usage')({ runQuery, runExecute });
    async function getManualOrder(requestId, options) {
        const rows = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? LIMIT 1', [requestId], options);
        return rows[0] || null;
    }

    async function listManualOrders(limit = 100) {
        return runQuery('SELECT * FROM orbitcard_admin_orders ORDER BY created_at DESC LIMIT ?', [Math.min(100, Math.max(1, Number(limit) || 100))]);
    }

    async function listRecoverableManualOrders() {
        return runQuery(`SELECT * FROM orbitcard_admin_orders WHERE
            (state IN ('submitting','pending','manual','retry_waiting') AND updated_at <= DATE_SUB(NOW(), INTERVAL 15 SECOND))
            OR (state IN ('funding_waiting','funding_review','funding_pending','card_pending') AND updated_at <= DATE_SUB(NOW(), INTERVAL ${FUNDING_POLL_MS / 1000} SECOND))
            OR (state IN ('preparing','prepared') AND updated_at <= DATE_SUB(NOW(), INTERVAL 2 MINUTE))
            ORDER BY updated_at ASC LIMIT 10`);
    }

    async function noteManualQueryAttempt(requestId) {
        // Rotate waiting rows without restarting the two-minute preparation
        // timeout or touching a terminal result reached by another worker.
        await runExecute(`UPDATE orbitcard_admin_orders SET updated_at = CURRENT_TIMESTAMP WHERE request_id = ?
            AND state IN ('submitting','pending','manual','retry_waiting','funding_waiting','funding_review','funding_pending','card_pending')`, [requestId]);
    }

    async function prepareManualOrder(input) {
        const scope = cardScope(input.baseUrl), jobKey = `manual-${input.requestId}`;
        return withTransaction(async connection => {
            const options = { connection };
            const [existing] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [input.requestId], options);
            if (existing) {
                if (existing.plan_type !== input.planType || existing.target_email !== input.targetEmail
                    || existing.scope !== scope || existing.api_key_hash !== input.apiKeyHash
                    || existing.mode !== input.mode || (existing.cdk_code || null) !== (input.cdkCode || null)) {
                    throw new Error('此请求编号已用于另一笔管理员订单');
                }
                return existing;
            }
            const pending = await runQuery(`SELECT request_id FROM orbitcard_admin_orders
                WHERE scope = ? AND target_email = ? AND plan_type = ? AND manual_local_released_at IS NULL
                AND state IN ('preparing','prepared','funding_waiting','funding_review','funding_pending','card_pending','submitting','pending','manual','retry_waiting') LIMIT 1 FOR UPDATE`,
            [scope, input.targetEmail, input.planType], options);
            if (pending.length) throw new Error('此账号与套餐已有待确认管理员订单，请先核对原单');
            if (input.mode === 'fulfillment') {
                const [cdk] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [input.cdkCode], options);
                if (!cdk || !cdk.is_active || cdk.used_at || cdk.manual_redeemed_at || !['自助', '手动'].includes(cdk.type)
                    || !input.acceptedCdkPlans.includes(cdk.plan_type)) throw new Error('CDK 无效、已占用或套餐不符');
                if ((await runQuery("SELECT request_id FROM orbitcard_admin_orders WHERE cdk_code = ? AND state = 'success' AND manual_local_released_at IS NULL LIMIT 1", [input.cdkCode], options)).length
                    || (await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? AND manual_local_released_at IS NULL LIMIT 1', [input.cdkCode], options)).length) {
                    throw new Error('该 CDK 已有使用记录，不能再次开通');
                }
                await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ? AND used_at IS NULL', [input.cdkCode], options);
            }
            await runExecute(`INSERT INTO orbitcard_admin_orders
                (request_id,client_order_no,scope,api_key_hash,mode,cdk_code,plan_type,plan_name,target_email,card_id,admin_email,state,message)
                VALUES (?,?,?,?,?,?,?,?,?,0,?,'preparing',?)`,
            [input.requestId, jobKey, scope, input.apiKeyHash, input.mode, input.cdkCode || null,
                input.planType, input.planName, input.targetEmail, input.adminEmail, '正在实时选卡或准备支付资金'], options);
            return getManualOrder(input.requestId, options);
        });
    }

    async function reserveManualCard(requestId, cardId, jobKey, planType) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.manual_result || order.manual_local_released_at || order.client_order_no !== jobKey || order.state !== 'preparing' || order.plan_type !== planType) {
                throw new Error('管理员订单状态已变更，不能预占支付卡');
            }
            if (Number(order.card_id) > 0 && Number(order.card_id) !== Number(cardId)) {
                throw new Error('管理员订单已绑定原支付卡，不能换卡重复补款');
            }
            if (manualHistory(order).some(attempt => Number(attempt.card_id) === Number(cardId))) return null;
            const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                [order.scope, cardId], options);
            if (!card || card.provider_status !== 'ACTIVE' || card.currency !== 'USD') return null;
            if (Number(order.card_id) === Number(cardId) && card.active_job === jobKey) return poolPolicy.eligible(card) ? card : null;
            if (card.active_job || !poolPolicy.eligible(card)) return null;
            await runExecute('UPDATE orbitcard_managed_cards SET active_job = ? WHERE scope = ? AND card_id = ?',
                [jobKey, order.scope, cardId], options);
            await runExecute('UPDATE orbitcard_admin_orders SET card_id = ?, message = ? WHERE request_id = ? AND state = \'preparing\'',
                [cardId, '支付卡已预占，正在核对或补足卡内资金', requestId], options);
            return { ...card, active_job: jobKey };
        });
    }

    async function failManualPreparation(requestId, jobKey, message) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.client_order_no !== jobKey || !['preparing','prepared','card_pending'].includes(order.state)) return null;
            const issues = await runQuery('SELECT * FROM orbitcard_card_issues WHERE job_key = ? OR issue_key = ? FOR UPDATE',
                [jobKey, order.issue_key || null], options);
            const fundings = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key = ? FOR UPDATE', [jobKey], options);
            if (issues.length > 1 || fundings.length > 1 || (order.issue_key && !issues.length)) {
                throw new Error('管理员订单原开卡或补款记录不完整，不能自动释放');
            }
            for (const intent of [...issues, ...fundings]) {
                if (intent.job_key !== jobKey || intent.scope !== order.scope
                    || intent.credential_hash !== order.api_key_hash || intent.plan_type !== planFor(order.plan_type)
                    || !['ready','failed'].includes(intent.state)) {
                    throw new Error('管理员订单原开卡或补款归属、状态尚未确认，不能自动释放');
                }
            }
            const [issue] = issues, [funding] = fundings;
            if ((issue && ((order.issue_key && issue.issue_key !== order.issue_key)
                || (issue.state === 'ready' && !(Number(issue.card_id) > 0))
                || (Number(order.card_id) > 0 && Number(issue.card_id) !== Number(order.card_id))))
                || (funding && (!(Number(order.card_id) > 0) || Number(funding.card_id) !== Number(order.card_id)))) {
                throw new Error('管理员订单原资金操作的卡片归属不一致，不能自动释放');
            }
            if (order.manual_local_released_at) {
                await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = ? WHERE request_id = ?", [
                    '原准备记录已核对；此前人工结果和本地释放记录保留', requestId], options);
                return getManualOrder(requestId, options);
            }
            if (order.cdk_code) await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
            if (Number(order.card_id) > 0) {
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                    [order.scope, order.card_id], options);
                if (!card || card.active_job !== jobKey) throw new Error('管理员订单支付卡占用记录不一致，不能自动释放');
                await runExecute('UPDATE orbitcard_managed_cards SET active_job = NULL WHERE scope = ? AND card_id = ? AND active_job = ?',
                    [order.scope, order.card_id, jobKey], options);
            }
            const retry = Boolean(order.manual_result) || manualHistory(order).length > 0;
            if (order.cdk_code && !retry) {
                await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ? AND manual_redeemed_at IS NULL', [order.cdk_code], options);
            }
            await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = ? WHERE request_id = ? AND state IN ('preparing','prepared','card_pending')",
                [String(message || '').slice(0,255), requestId], options);
            if (retry) await runExecute('UPDATE orbitcard_admin_orders SET state = ?, message = ? WHERE request_id = ?',
                ['support_locked', (order.manual_result ? '人工结果已登记，CDK 保持售后锁定；' : '换卡重试准备失败，CDK 保持锁定；') + String(message || '').slice(0, 180), requestId], options);
            return getManualOrder(requestId, options);
        });
    }

    async function pauseManualPreparation(requestId, jobKey, message) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.client_order_no !== jobKey
                || !['preparing','card_pending','funding_waiting','funding_review','funding_pending'].includes(order.state)) return null;
            const fundings = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key = ? FOR UPDATE', [jobKey], options);
            // A handoff stops new payments but retains a path for original money
            // reconciliation. Do not turn preparation incidents into final support orders.
            const state = fundings.length || ['funding_waiting','funding_review','funding_pending'].includes(order.state)
                ? 'funding_pending' : order.issue_key ? 'card_pending' : 'support_locked';
            await runExecute('UPDATE orbitcard_admin_orders SET state = ?, message = ? WHERE request_id = ?',
                [state, String(message || '').slice(0, 255), requestId], options);
            return getManualOrder(requestId, options);
        });
    }

    async function markManualPrepared(requestId, jobKey, cardId) {
        const result = await runExecute(`UPDATE orbitcard_admin_orders SET state = 'prepared', message = ?
            WHERE request_id = ? AND client_order_no = ? AND state IN ('preparing','funding_waiting') AND card_id = ? AND manual_result IS NULL AND manual_local_released_at IS NULL`,
        ['支付卡已准备，等待提交原订阅订单', requestId, jobKey, cardId]);
        if (result.affectedRows !== 1) throw new Error('管理员订单支付卡准备状态不一致');
        return getManualOrder(requestId);
    }

    async function noteManualWaiting(requestId, jobKey, message) {
        const result = await runExecute(`UPDATE orbitcard_admin_orders SET message = ?
            WHERE request_id = ? AND client_order_no = ? AND state = 'preparing' AND card_id = 0 AND manual_result IS NULL AND manual_local_released_at IS NULL`,
        [String(message || '').slice(0, 255), requestId, jobKey]);
        if (result.affectedRows !== 1) throw new Error('管理员订单准备状态已变更，不能继续等待支付卡');
        return getManualOrder(requestId);
    }

    async function waitManualFunding(requestId, jobKey, message) {
        return setManualFundingState(requestId, jobKey, message, 'funding_waiting');
    }

    async function reviewManualFunding(requestId, jobKey, message) {
        return setManualFundingState(requestId, jobKey, message, 'funding_review');
    }

    async function setManualFundingState(requestId, jobKey, message, state) {
        return withTransaction(async connection => {
            const options={connection};
            const [order]=await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE',[requestId],options);
            const allowed = state === 'funding_review' ? ['funding_waiting','funding_review'] : ['preparing','funding_waiting'];
            if(!order || state !== 'funding_review' && (order.manual_result || order.manual_local_released_at) || order.client_order_no!==jobKey || !allowed.includes(order.state)) {
                throw new Error('管理员订单状态已变更，不能继续等待补款');
            }
            const [funding]=await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key = ? FOR UPDATE',[jobKey],options);
            if(!funding || !funding.order_no || funding.scope!==order.scope || Number(funding.card_id)!==Number(order.card_id)
                || funding.credential_hash!==order.api_key_hash || funding.plan_type!==planFor(order.plan_type)) {
                throw new Error('管理员原补款身份不完整，不能自动恢复');
            }
            await runExecute(`UPDATE orbitcard_admin_orders SET state = '${state}', message = ? WHERE request_id = ?`,
                [String(message || '').slice(0,255),requestId],options);
            return getManualOrder(requestId,options);
        });
    }

    async function releaseManualFunding(requestId, jobKey, message) {
        return withTransaction(async connection => {
            const options={connection};
            const [order]=await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE',[requestId],options);
            if(!order || order.client_order_no!==jobKey || !['funding_waiting','funding_review','funding_pending'].includes(order.state)) return null;
            const fundings=await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key = ? FOR UPDATE',[jobKey],options);
            const [funding]=fundings;
            if(fundings.length!==1 || !['ready','failed'].includes(funding.state) || funding.scope!==order.scope
                || Number(funding.card_id)!==Number(order.card_id) || funding.credential_hash!==order.api_key_hash
                || funding.plan_type!==planFor(order.plan_type)) return null;
            const issues=await runQuery('SELECT * FROM orbitcard_card_issues WHERE job_key = ? OR issue_key = ? FOR UPDATE',
                [jobKey,order.issue_key || null],options);
            if(issues.length>1 || (order.issue_key && !issues.length)) return null;
            for(const issue of issues) {
                if(!['ready','failed'].includes(issue.state) || issue.job_key!==jobKey
                    || issue.scope!==order.scope || issue.credential_hash!==order.api_key_hash
                    || (order.issue_key && issue.issue_key!==order.issue_key)
                    || issue.plan_type!==planFor(order.plan_type) || Number(issue.card_id)!==Number(order.card_id)) return null;
            }
            if (order.manual_local_released_at) {
                await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = ? WHERE request_id = ?", [
                    '原补款已完成核对；此前人工结果和本地释放记录保留', requestId], options);
                return getManualOrder(requestId, options);
            }
            if(order.cdk_code) {
                const [code]=await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE',[order.cdk_code],options);
                if(!code) return null;
            }
            const [card]=await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                [order.scope,order.card_id],options);
            if(!card || card.active_job!==jobKey) throw new Error('原补款卡片占用归属已变更，不能释放');
            await runExecute('UPDATE orbitcard_managed_cards SET active_job = NULL WHERE scope = ? AND card_id = ? AND active_job = ?',
                [order.scope,order.card_id,jobKey],options);
            const retry = Boolean(order.manual_result) || manualHistory(order).length > 0;
            if(order.cdk_code && !retry) await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ? AND manual_redeemed_at IS NULL',[order.cdk_code],options);
            await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = ? WHERE request_id = ? AND state IN ('funding_waiting','funding_review','funding_pending')",
                [String(message || '').slice(0,255),requestId],options);
            if (retry) await runExecute('UPDATE orbitcard_admin_orders SET state = ?, message = ? WHERE request_id = ?',
                ['support_locked', order.manual_result ? '原补款已核对；人工结果已登记，CDK 保持售后锁定' : '换卡补款已核对，订阅未继续；CDK 保持售后锁定', requestId], options);
            return getManualOrder(requestId,options);
        });
    }

    async function claimManualSubmission(requestId) {
        const result = await runExecute(`UPDATE orbitcard_admin_orders SET state = 'submitting', message = '正在提交原订单'
            WHERE request_id = ? AND state = 'prepared' AND manual_result IS NULL AND manual_local_released_at IS NULL`, [requestId]);
        return result.affectedRows === 1;
    }

    async function abandonPreparedManualOrder(requestId) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery(`SELECT * FROM orbitcard_admin_orders
                WHERE request_id = ? AND state = 'prepared'
                AND updated_at <= DATE_SUB(NOW(), INTERVAL 2 MINUTE) FOR UPDATE`, [requestId], options);
            if (!order || order.manual_result || order.manual_local_released_at) return null;
            if (order.cdk_code) {
                await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
                if (!manualHistory(order).length) await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ? AND manual_redeemed_at IS NULL', [order.cdk_code], options);
            }
            const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                [order.scope, order.card_id], options);
            if (!card || card.active_job !== order.client_order_no) throw new Error('管理员订单支付卡占用记录不一致');
            await runExecute('UPDATE orbitcard_managed_cards SET active_job = NULL WHERE scope = ? AND card_id = ? AND active_job = ?',
                [order.scope, order.card_id, order.client_order_no], options);
            await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = '提交前中断；未调用平台扣款，CDK 与支付卡已释放' WHERE request_id = ? AND state = 'prepared'", [requestId], options);
            if (manualHistory(order).length) await runExecute('UPDATE orbitcard_admin_orders SET state = ?, message = ? WHERE request_id = ?',
                ['support_locked', '换卡重试在提交前中断，CDK 保持售后锁定', requestId], options);
            return getManualOrder(requestId, options);
        });
    }

    async function resolvedPreparation(order, options) {
        const fundings = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key = ? FOR UPDATE', [order.client_order_no], options);
        const issues = await runQuery('SELECT * FROM orbitcard_card_issues WHERE job_key = ? OR issue_key = ? FOR UPDATE',
            [order.client_order_no, order.issue_key || null], options);
        return fundings.length <= 1 && issues.length <= 1 && (!order.issue_key || issues.length === 1)
            && [...fundings, ...issues].every(intent => ['ready','failed'].includes(intent.state)
                && intent.job_key === order.client_order_no && intent.scope === order.scope
                && intent.credential_hash === order.api_key_hash && intent.plan_type === planFor(order.plan_type)
                && Number(intent.card_id) === Number(order.card_id))
            && (!order.issue_key || issues[0]?.issue_key === order.issue_key);
    }

    async function settleManualOrder(requestId, { state, taskNo = null, snapshot = null, message, retryAllowed = false, expectedClientOrderNo }) {
        if (!['pending', 'manual', 'success', 'failed', 'rejected'].includes(state)) throw new Error('无效的管理员订单状态');
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order) throw new Error('管理员订单不存在');
            if (expectedClientOrderNo && order.client_order_no !== expectedClientOrderNo) return order;
            if (order.task_no && taskNo && order.task_no !== taskNo) throw new Error('平台订单号与原订单不一致');
            if (['success', 'failed', 'rejected', 'support_locked'].includes(order.state)) return order;
            if (!['submitting','pending','manual'].includes(order.state)) return order;
            if (state === 'rejected' && (order.state !== 'submitting' || order.task_no || taskNo)) {
                throw new Error('已有受理结果或已转人工的管理员订单不能按未受理释放');
            }
            if (order.state === 'manual' && state === 'pending') {
                state = 'manual';
                message = `已转人工处理，自动支付已停止；仅核对原订单结果${message ? `；${message}` : ''}`;
            }
            const safeTaskNo = taskNo || order.task_no || null;
            const expected = { clientOrderNo: order.client_order_no, orderId: safeTaskNo,
                cardId: order.card_id, planType: order.plan_type, email: order.target_email };
            if ((state === 'failed' && !confirmedFailure(snapshot, expected))
                || (state === 'success' && !confirmedSuccess(snapshot, expected))
                || (state === 'rejected' && !confirmedRejection(snapshot, expected))) {
                throw new Error('管理员订单缺少归属一致的已确认结果，保留原订单与支付卡占用');
            }
            if (order.manual_local_released_at) {
                await runExecute(`UPDATE orbitcard_admin_orders SET state = ?, task_no = COALESCE(task_no, ?),
                    snapshot = ?, message = ? WHERE request_id = ?`, [state, safeTaskNo,
                    snapshot ? JSON.stringify(snapshot) : order.snapshot,
                    '原平台结果已核对；此前人工结果和本地释放记录保留', requestId], options);
                return getManualOrder(requestId, options);
            }
            if (['success','failed','rejected'].includes(state) && !await resolvedPreparation(order, options)) {
                throw new Error('管理员原开卡或补款尚未完整核对，保留原订单与支付卡占用');
            }
            const supportLocked = state === 'failed';
            let retry = false;
            if (supportLocked && retryAllowed && !order.manual_result && order.state !== 'manual' && manualHistory(order).length + 1 < MAX_PAYMENT_ATTEMPTS
                && retryableFailure(snapshot, { clientOrderNo: order.client_order_no, orderId: safeTaskNo,
                    cardId: order.card_id, planType: order.plan_type, email: order.target_email })) {
                const [code] = order.cdk_code ? await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options) : [];
                retry = !order.cdk_code || Boolean(code?.is_active && !code.manual_redeemed_at);
            }
            if (supportLocked) {
                const disposition = classifyFailure(snapshot);
                message = `${disposition.message}；自动支付已停止，保留原记录${order.cdk_code ? '及 CDK 锁定' : ''}，请人工核对`;
                if (disposition.automaticRetry && manualHistory(order).length + 1 >= MAX_PAYMENT_ATTEMPTS) {
                    message = `已达到 ${MAX_PAYMENT_ATTEMPTS} 次支付上限；${message}`;
                }
            }
            if (retry) message = `充值已明确失败，等待换卡重试；最多 ${MAX_PAYMENT_ATTEMPTS} 次，Session 失效时请按原请求编号重新提交`;
            await runExecute(`UPDATE orbitcard_admin_orders SET state = ?, task_no = COALESCE(task_no, ?),
                snapshot = ?, message = ? WHERE request_id = ?`,
            [retry ? 'retry_waiting' : supportLocked ? 'support_locked' : state, safeTaskNo, snapshot ? JSON.stringify(snapshot) : order.snapshot,
                String(message || '').slice(0, 255), requestId], options);
            if (['success', 'failed', 'rejected'].includes(state)) {
                if (order.cdk_code && state === 'rejected' && !manualHistory(order).length) {
                    await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
                    await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ? AND manual_redeemed_at IS NULL', [order.cdk_code], options);
                }
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                    [order.scope, order.card_id], options);
                if (!card || card.active_job !== order.client_order_no) throw new Error('管理员订单的支付卡占用记录不一致');
                if (state === 'success') {
                    await usage.recordSuccess({ scope: order.scope, cardId: order.card_id,
                        clientOrderNo: order.client_order_no, orderId: safeTaskNo, snapshot }, options);
                }
                if (state === 'failed') await require('../orbitcard/orbitcard-card-failure').disableFailedCard({ runExecute,
                    scope: order.scope, cardId: order.card_id, jobKey: order.client_order_no, snapshot, options,
                    expected: { clientOrderNo: order.client_order_no, orderId: safeTaskNo,
                        cardId: order.card_id, planType: order.plan_type, email: order.target_email } });
                await runExecute(`UPDATE orbitcard_managed_cards SET active_job = NULL
                    WHERE scope = ? AND card_id = ? AND active_job = ?`,
                [order.scope, order.card_id, order.client_order_no], options);
            }
            if (state === 'success' && order.cdk_code) {
                await enqueueRedemption({ cdk: order.cdk_code, orderId: order.client_order_no }, options);
            }
            return getManualOrder(requestId, options);
        });
    }

    async function reviewRetry(order, options) {
        if (order.manual_result || order.manual_local_released_at) return false;
        let snapshot = null, eligible = false;
        try {
            snapshot = JSON.parse(order.snapshot || '{}');
            eligible = manualHistory(order).length + 1 < MAX_PAYMENT_ATTEMPTS && retryableFailure(snapshot, {
                clientOrderNo: order.client_order_no, orderId: order.task_no, cardId: order.card_id,
                planType: order.plan_type, email: order.target_email
            });
        } catch (_) { /* Incomplete historical evidence cannot authorize a new payment. */ }
        if (eligible) return true;
        const disposition = classifyFailure(snapshot);
        await runExecute('UPDATE orbitcard_admin_orders SET state = ?, message = ? WHERE request_id = ?',
            ['support_locked', `${disposition.message}；原重试依据不满足自动换卡条件，已停止自动支付并保留原记录`.slice(0, 255), order.request_id], options);
        return false;
    }

    async function reviewManualRetry(requestId, expectedClientOrderNo) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.client_order_no !== expectedClientOrderNo || order.state !== 'retry_waiting') return order;
            await reviewRetry(order, options);
            return getManualOrder(requestId, options);
        });
    }

    async function startManualRetry(requestId, expectedClientOrderNo, { email, baseUrl, apiKeyHash }) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.manual_result || order.manual_local_released_at || order.client_order_no !== expectedClientOrderNo || order.state !== 'retry_waiting') return null;
            if (order.target_email.toLowerCase() !== email.toLowerCase() || order.scope !== cardScope(baseUrl) || order.api_key_hash !== apiKeyHash) {
                throw new Error('重试账号、平台或密钥与原订单不一致');
            }
            if (!await reviewRetry(order, options)) return null;
            const history = manualHistory(order), snapshot = JSON.parse(order.snapshot || '{}');
            if (order.cdk_code) {
                const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
                if (!code?.is_active || code.manual_redeemed_at) return null;
            }
            if (!await resolvedPreparation(order, options)) return null;
            history.push({ client_order_no: order.client_order_no, task_no: order.task_no, card_id: Number(order.card_id), snapshot });
            const identity = `manual-${requestId}-attempt-${history.length + 1}`;
            await runExecute(`UPDATE orbitcard_admin_orders SET client_order_no = ?, retry_history = ?, state = 'preparing',
                card_id = 0, issue_key = NULL, task_no = NULL, snapshot = NULL, message = ? WHERE request_id = ?`,
            [identity, JSON.stringify(history), `正在准备第 ${history.length + 1} 次支付，使用其他现有卡片`, requestId], options);
            return getManualOrder(requestId, options);
        });
    }

    return { getManualOrder, listManualOrders, listRecoverableManualOrders, noteManualQueryAttempt,
        prepareManualOrder, reserveManualCard,
        failManualPreparation, pauseManualPreparation, markManualPrepared, noteManualWaiting, waitManualFunding, reviewManualFunding, releaseManualFunding,
        claimManualSubmission, abandonPreparedManualOrder, settleManualOrder, reviewManualRetry, startManualRetry };
};
