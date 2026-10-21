'use strict';

const { cardScope, LIMITS } = require('./orbitcard-card-policy');

const { PROVIDER_TO_PLAN: COUNTED_PLANS } = require('./plan-registry');

module.exports = function createManualStore({ runQuery, runExecute, withTransaction }) {
    async function getManualOrder(requestId) {
        const rows = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? LIMIT 1', [requestId]);
        return rows[0] || null;
    }

    async function listManualOrders(limit = 100) {
        return runQuery('SELECT * FROM orbitcard_admin_orders ORDER BY created_at DESC LIMIT ?', [Math.min(100, Math.max(1, Number(limit) || 100))]);
    }

    async function listRecoverableManualOrders() {
        return runQuery(`SELECT * FROM orbitcard_admin_orders WHERE
            (state IN ('submitting','pending','manual') AND updated_at <= DATE_SUB(NOW(), INTERVAL 15 SECOND))
            OR (state = 'prepared' AND updated_at <= DATE_SUB(NOW(), INTERVAL 2 MINUTE))
            ORDER BY updated_at ASC LIMIT 10`);
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
                WHERE scope = ? AND target_email = ? AND plan_type = ?
                AND state IN ('preparing','prepared','submitting','pending','manual') LIMIT 1 FOR UPDATE`,
            [scope, input.targetEmail, input.planType], options);
            if (pending.length) throw new Error('此账号与套餐已有待确认管理员订单，请先核对原单');
            if (input.mode === 'fulfillment') {
                const [cdk] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [input.cdkCode], options);
                if (!cdk || !cdk.is_active || cdk.used_at || !['自助', '手动'].includes(cdk.type)
                    || !input.acceptedCdkPlans.includes(cdk.plan_type)) throw new Error('CDK 无效、已占用或套餐不符');
                if ((await runQuery("SELECT request_id FROM orbitcard_admin_orders WHERE cdk_code = ? AND state = 'success' LIMIT 1", [input.cdkCode], options)).length
                    || (await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? LIMIT 1', [input.cdkCode], options)).length) {
                    throw new Error('该 CDK 已有使用记录，不能再次开通');
                }
                await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ? AND used_at IS NULL', [input.cdkCode], options);
            }
            await runExecute(`INSERT INTO orbitcard_admin_orders
                (request_id,client_order_no,scope,api_key_hash,mode,cdk_code,plan_type,plan_name,target_email,card_id,admin_email,state,message)
                VALUES (?,?,?,?,?,?,?,?,?,0,?,'preparing',?)`,
            [input.requestId, jobKey, scope, input.apiKeyHash, input.mode, input.cdkCode || null,
                input.planType, input.planName, input.targetEmail, input.adminEmail, '正在实时选卡或准备支付资金'], options);
            return getManualOrderInTransaction(input.requestId, options);
        });
    }

    async function reserveManualCard(requestId, cardId, jobKey, planType) {
        const plan = COUNTED_PLANS[planType] || planType;
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.client_order_no !== jobKey || order.state !== 'preparing' || order.plan_type !== planType) {
                throw new Error('管理员订单状态已变更，不能预占支付卡');
            }
            if (Number(order.card_id) > 0 && Number(order.card_id) !== Number(cardId)) {
                throw new Error('管理员订单已绑定原支付卡，不能换卡重复补款');
            }
            const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                [order.scope, cardId], options);
            if (!card || !card.history_confirmed || card.provider_status !== 'ACTIVE' || card.currency !== 'USD'
                || Number(card[`successful_${plan}`]) >= LIMITS[plan]) return null;
            if (Number(order.card_id) === Number(cardId) && card.active_job === jobKey) return card;
            if (card.active_job) return null;
            await runExecute('UPDATE orbitcard_managed_cards SET active_job = ?, active_plan = ? WHERE scope = ? AND card_id = ?',
                [jobKey, plan, order.scope, cardId], options);
            await runExecute('UPDATE orbitcard_admin_orders SET card_id = ?, message = ? WHERE request_id = ? AND state = \'preparing\'',
                [cardId, '支付卡已预占，正在核对或补足卡内资金', requestId], options);
            return { ...card, active_job: jobKey };
        });
    }

    async function attachManualIssue(requestId, jobKey, issueKey) {
        const result = await runExecute(`UPDATE orbitcard_admin_orders SET issue_key = ?, message = ?
            WHERE request_id = ? AND client_order_no = ? AND state = 'preparing'
            AND (issue_key IS NULL OR issue_key = ?)`,
        [issueKey, '正在确认原开卡申请', requestId, jobKey, issueKey]);
        if (result.affectedRows !== 1) throw new Error('管理员订单已变更，不能关联开卡申请');
    }

    async function failManualPreparation(requestId, jobKey, message) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order || order.client_order_no !== jobKey || order.state !== 'preparing') return null;
            if (order.issue_key
                || (await runQuery('SELECT funding_key FROM orbitcard_card_fundings WHERE job_key = ? LIMIT 1', [jobKey], options)).length) {
                throw new Error('管理员订单已有开卡或补款意图，须核对原单，不能自动释放');
            }
            if (order.cdk_code) await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
            if (Number(order.card_id) > 0) {
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                    [order.scope, order.card_id], options);
                if (!card || card.active_job !== jobKey) throw new Error('管理员订单支付卡占用记录不一致，不能自动释放');
                await runExecute('UPDATE orbitcard_managed_cards SET active_job = NULL, active_plan = NULL WHERE scope = ? AND card_id = ? AND active_job = ?',
                    [order.scope, order.card_id, jobKey], options);
            }
            if (order.cdk_code) {
                await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ?', [order.cdk_code], options);
            }
            await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = ? WHERE request_id = ? AND state = 'preparing'",
                [String(message || '').slice(0,255), requestId], options);
            return getManualOrderInTransaction(requestId, options);
        });
    }

    async function blockManualBalance(requestId, jobKey, _required, message) {
        await failManualPreparation(requestId, jobKey, message);
    }

    async function markManualPrepared(requestId, jobKey, cardId) {
        const result = await runExecute(`UPDATE orbitcard_admin_orders SET state = 'prepared', message = ?
            WHERE request_id = ? AND client_order_no = ? AND state = 'preparing' AND card_id = ?`,
        ['支付卡已准备，等待提交原订阅订单', requestId, jobKey, cardId]);
        if (result.affectedRows !== 1) throw new Error('管理员订单支付卡准备状态不一致');
        return getManualOrder(requestId);
    }

    async function createManualOrder(input) {
        const scope = cardScope(input.baseUrl), jobKey = `manual-${input.requestId}`;
        return withTransaction(async connection => {
            const options = { connection };
            const [existing] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [input.requestId], options);
            if (existing) {
                if (existing.plan_type !== input.planType || existing.target_email !== input.targetEmail
                    || Number(existing.card_id) !== input.cardId || existing.scope !== scope
                    || existing.api_key_hash !== input.apiKeyHash || existing.mode !== input.mode
                    || (existing.cdk_code || null) !== (input.cdkCode || null)) throw new Error('此请求编号已用于另一笔管理员订单');
                return { order: existing, created: false };
            }
            const pending = await runQuery(`SELECT request_id FROM orbitcard_admin_orders
                WHERE scope = ? AND target_email = ? AND plan_type = ?
                AND state IN ('prepared','submitting','pending','manual') LIMIT 1 FOR UPDATE`,
            [scope, input.targetEmail, input.planType], options);
            if (pending.length) throw new Error('此账号与套餐已有待确认管理员订单，请先核对原单');
            if (input.mode === 'fulfillment') {
                const [cdk] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [input.cdkCode], options);
                if (!cdk || !cdk.is_active || cdk.used_at || !['自助', '手动'].includes(cdk.type)
                    || !input.acceptedCdkPlans.includes(cdk.plan_type)) {
                    throw new Error('CDK 无效、已占用或套餐与所选卡台套餐不一致');
                }
                const prior = await runQuery('SELECT request_id FROM orbitcard_admin_orders WHERE cdk_code = ? AND state = \'success\' LIMIT 1', [input.cdkCode], options);
                if (prior.length) throw new Error('CDK 已经完成一次人工开通');
                const task = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? LIMIT 1', [input.cdkCode], options);
                if (task.length) throw new Error('该 CDK 已有自助使用记录，不能再次用于人工开通');
            }
            const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                [scope, input.cardId], options);
            if (!card || !card.history_confirmed || card.active_job || card.provider_status !== 'ACTIVE' || card.currency !== 'USD') {
                throw new Error('支付卡未登记历史次数、正在被占用或状态异常，请换卡并重新查询');
            }
            const counted = COUNTED_PLANS[input.planType];
            if (counted && Number(card[`successful_${counted}`]) >= LIMITS[counted]) {
                throw new Error('该卡当前套餐的成功次数已达到上限，请选择其他卡');
            }
            await runExecute(`INSERT INTO orbitcard_admin_orders
                (request_id,client_order_no,scope,api_key_hash,mode,cdk_code,plan_type,plan_name,target_email,card_id,admin_email,state,message)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`,
            [input.requestId, jobKey, scope, input.apiKeyHash, input.mode, input.cdkCode || null,
                input.planType, input.planName, input.targetEmail, input.cardId, input.adminEmail,
                '已保存管理员订单，等待提交 Orbitcard'], options);
            if (input.mode === 'fulfillment') {
                await runExecute('UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ? AND used_at IS NULL', [input.cdkCode], options);
            }
            await runExecute('UPDATE orbitcard_managed_cards SET active_job = ?, active_plan = ? WHERE scope = ? AND card_id = ?',
                [jobKey, 'manual', scope, input.cardId], options);
            return { order: await getManualOrderInTransaction(input.requestId, options), created: true };
        });
    }

    async function getManualOrderInTransaction(requestId, options) {
        const rows = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? LIMIT 1', [requestId], options);
        return rows[0] || null;
    }

    async function claimManualSubmission(requestId) {
        const result = await runExecute(`UPDATE orbitcard_admin_orders SET state = 'submitting', message = '正在提交原订单'
            WHERE request_id = ? AND state = 'prepared'`, [requestId]);
        return result.affectedRows === 1;
    }

    async function abandonPreparedManualOrder(requestId) {
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery(`SELECT * FROM orbitcard_admin_orders
                WHERE request_id = ? AND state = 'prepared'
                AND updated_at <= DATE_SUB(NOW(), INTERVAL 2 MINUTE) FOR UPDATE`, [requestId], options);
            if (!order) return null;
            if (order.cdk_code) {
                await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
                await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ?', [order.cdk_code], options);
            }
            const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                [order.scope, order.card_id], options);
            if (!card || card.active_job !== order.client_order_no) throw new Error('管理员订单支付卡占用记录不一致');
            await runExecute('UPDATE orbitcard_managed_cards SET active_job = NULL, active_plan = NULL WHERE scope = ? AND card_id = ? AND active_job = ?',
                [order.scope, order.card_id, order.client_order_no], options);
            await runExecute("UPDATE orbitcard_admin_orders SET state = 'failed', message = '提交前中断；未调用平台扣款，CDK 与支付卡已释放' WHERE request_id = ? AND state = 'prepared'", [requestId], options);
            return getManualOrderInTransaction(requestId, options);
        });
    }

    async function settleManualOrder(requestId, { state, taskNo = null, snapshot = null, message }) {
        if (!['pending', 'manual', 'success', 'failed'].includes(state)) throw new Error('无效的管理员订单状态');
        return withTransaction(async connection => {
            const options = { connection };
            const [order] = await runQuery('SELECT * FROM orbitcard_admin_orders WHERE request_id = ? FOR UPDATE', [requestId], options);
            if (!order) throw new Error('管理员订单不存在');
            if (order.task_no && taskNo && order.task_no !== taskNo) throw new Error('平台订单号与原订单不一致');
            if (['success', 'failed'].includes(order.state)) return order;
            if (!['submitting','pending','manual'].includes(order.state)) return order;
            const safeTaskNo = taskNo || order.task_no || null;
            await runExecute(`UPDATE orbitcard_admin_orders SET state = ?, task_no = COALESCE(task_no, ?),
                snapshot = ?, message = ? WHERE request_id = ?`,
            [state, safeTaskNo, snapshot ? JSON.stringify(snapshot) : order.snapshot,
                String(message || '').slice(0, 255), requestId], options);
            if (['success', 'failed'].includes(state)) {
                if (order.cdk_code && state === 'failed') {
                    await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [order.cdk_code], options);
                    await runExecute('UPDATE cdk_codes SET used_at = NULL WHERE cdk_code = ?', [order.cdk_code], options);
                }
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope = ? AND card_id = ? FOR UPDATE',
                    [order.scope, order.card_id], options);
                if (!card || card.active_job !== order.client_order_no) throw new Error('管理员订单的支付卡占用记录不一致');
                const counted = COUNTED_PLANS[order.plan_type];
                const increment = state === 'success' && counted ? `, successful_${counted} = successful_${counted} + 1` : '';
                await runExecute(`UPDATE orbitcard_managed_cards SET active_job = NULL, active_plan = NULL${increment}
                    WHERE scope = ? AND card_id = ? AND active_job = ?`,
                [order.scope, order.card_id, order.client_order_no], options);
            }
            return getManualOrderInTransaction(requestId, options);
        });
    }

    return { getManualOrder, listManualOrders, listRecoverableManualOrders,
        prepareManualOrder, reserveManualCard, attachManualIssue, blockManualBalance,
        failManualPreparation, markManualPrepared,
        createManualOrder, claimManualSubmission, abandonPreparedManualOrder, settleManualOrder };
};
