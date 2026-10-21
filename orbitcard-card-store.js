'use strict';
const { CardPreparationError } = require('./orbitcard-card-policy');

const { cardScope, planFor, LIMITS, settlementState } = require('./orbitcard-card-policy');

module.exports = function createCardStore({ runQuery, runExecute, withTransaction, openLockConnection }) {
    function methods(baseUrl, connection = null) {
        const scope = cardScope(baseUrl), options = connection ? { connection } : {};
        const query = (sql, args = []) => runQuery(sql, args, options);
        const execute = (sql, args = []) => runExecute(sql, args, options);
        const transaction = fn => withTransaction(fn, connection);
        async function syncCards(cards) {
            for (const card of cards) {
                await execute(`INSERT INTO orbitcard_managed_cards
                    (scope,card_id,provider_status,product_code,card_bin,last4,balance,currency)
                    VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_status=VALUES(provider_status),
                    product_code=IF(VALUES(product_code)='',product_code,VALUES(product_code)),
                    card_bin=IF(VALUES(card_bin)='',card_bin,VALUES(card_bin)),last4=IF(VALUES(last4)='',last4,VALUES(last4)),
                    balance=VALUES(balance),currency=VALUES(currency)`,
                [scope,card.card_id,card.provider_status,card.product_code,card.bin || '',card.last4,card.balance,card.currency]);
            }
        }
        async function listCards() {
            return query('SELECT * FROM orbitcard_managed_cards WHERE scope = ? ORDER BY successful_plus+successful_pro100+successful_pro200+successful_pro500 DESC, card_id', [scope]);
        }
        async function issueForJob(jobKey) {
            const rows = await query('SELECT * FROM orbitcard_card_issues WHERE scope=? AND job_key=? ORDER BY created_at DESC LIMIT 1', [scope, jobKey]);
            return rows[0] || null;
        }
        async function bindCard(cardId, counts) {
            if (!counts || Object.keys(counts).length !== 4 || Object.entries(LIMITS).some(([plan, limit]) =>
                !Object.hasOwn(counts, plan) || !Number.isInteger(counts[plan]) || counts[plan] < 0 || counts[plan] > limit)) {
                throw new CardPreparationError('请分别填写 Plus 0–4 次、Pro 100/200/500 各 0–1 次的历史成功次数');
            }
            return transaction(async tx => {
                const opts = { connection: tx };
                const legacy = await runQuery(`SELECT t.job_key FROM task_logs t
                    LEFT JOIN orbitcard_card_uses u ON u.job_key=t.job_key
                    WHERE t.orbitcard_client_order_no IS NOT NULL AND u.job_key IS NULL
                    AND t.status IN ('running','manual') LIMIT 1`, [], opts);
                if (legacy.length) throw new CardPreparationError('存在尚未确认的旧充值订单，请先核对原订单再绑定历史卡片');
                const cards = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,cardId], opts);
                if (!cards[0] || cards[0].history_confirmed || cards[0].active_job) throw new CardPreparationError('卡片不存在或历史次数已确认；已有额度记录不能重置');
                await runExecute(`UPDATE orbitcard_managed_cards SET history_confirmed=1,successful_plus=?,successful_pro100=?,
                    successful_pro200=?,successful_pro500=? WHERE scope=? AND card_id=?`,
                [counts.plus,counts.pro100,counts.pro200,counts.pro500,scope,cardId], opts);
            });
        }
        async function reserveCard(cardId, jobKey, planType) {
            const plan = planFor(planType);
            return transaction(async tx => {
                const opts = { connection: tx };
                const tasks = await runQuery('SELECT * FROM task_logs WHERE job_key=? FOR UPDATE', [jobKey], opts);
                const task = tasks[0];
                if (!task || task.orbitcard_state !== 'prepared' || cardScope(task.orbitcard_base_url) !== scope || planFor(task.orbitcard_plan_type) !== plan) {
                    throw new CardPreparationError('充值任务已变更，不能预占卡片');
                }
                const cards = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,cardId], opts);
                const card = cards[0];
                const uses = await runQuery('SELECT * FROM orbitcard_card_uses WHERE job_key=? FOR UPDATE', [jobKey], opts);
                if (uses[0]) {
                    if (uses[0].state === 'reserved' && Number(uses[0].card_id) === Number(cardId) && card?.active_job === jobKey) return card;
                    throw new CardPreparationError('本任务已绑定卡片，不允许更换支付卡');
                }
                if (!card || !card.history_confirmed || card.active_job || card.provider_status !== 'ACTIVE'
                    || Number(card[`successful_${plan}`]) >= LIMITS[plan]) return null;
                await runExecute('INSERT INTO orbitcard_card_uses (job_key,scope,card_id,plan_type,state) VALUES (?,?,?,?,\'reserved\')', [jobKey,scope,cardId,plan], opts);
                await runExecute('UPDATE orbitcard_managed_cards SET active_job=?,active_plan=? WHERE scope=? AND card_id=?', [jobKey,plan,scope,cardId], opts);
                await runExecute('UPDATE task_logs SET orbitcard_card_id=? WHERE job_key=?', [cardId,jobKey], opts);
                return { ...card, active_job: jobKey };
            });
        }
        async function pendingIssue(planType) {
            const rows = await query(`SELECT * FROM orbitcard_card_issues WHERE scope=? AND plan_type=?
                AND state IN ('prepared','submitting','pending','unknown') ORDER BY created_at LIMIT 1`, [scope,planFor(planType)]);
            return rows[0] || null;
        }
        async function createIssue(issue) {
            await execute(`INSERT INTO orbitcard_card_issues (issue_key,scope,job_key,plan_type,product_code,amount,credential_hash,request_body,state)
                VALUES (?,?,?,?,?,?,?,?,'prepared')`, [issue.issue_key,scope,issue.job_key || null,issue.plan_type,issue.product_code,issue.amount,issue.credential_hash,issue.request_body]);
            return { ...issue, scope, state: 'prepared' };
        }
        async function updateIssue(key, { state, order_no, card_id, message, provider_status, completed, fee_snapshot, retry_at }) {
            await execute(`UPDATE orbitcard_card_issues SET state=?,order_no=COALESCE(NULLIF(?,''),order_no),
                card_id=COALESCE(?,card_id),message=?,provider_status=COALESCE(?,provider_status),completed=COALESCE(?,completed),
                fee_snapshot=COALESCE(?,fee_snapshot),retry_at=COALESCE(?,retry_at)
                WHERE issue_key=? AND scope=? AND state NOT IN ('ready','failed')`,
            [state,order_no || null,card_id || null,message || '',provider_status || null,completed ?? null,fee_snapshot || null,retry_at ?? null,key,scope]);
        }
        async function completeIssue(issue, card) {
            // Persist the ready card and issue result together; recovery can safely replay this transaction.
            return transaction(async tx => {
                const opts = { connection: tx };
                const rows = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,card.card_id], opts);
                if (!rows[0]) throw new CardPreparationError('新卡摘要尚未登记');
                await runExecute(`UPDATE orbitcard_managed_cards SET history_confirmed=1,source='issued'
                    WHERE scope=? AND card_id=?`, [scope,card.card_id], opts);
                await runExecute(`UPDATE orbitcard_card_issues SET state='ready',card_id=?,message='开卡成功'
                    WHERE issue_key=? AND scope=?`, [card.card_id,issue.issue_key,scope], opts);
            });
        }
        async function listIssues() { return query('SELECT * FROM orbitcard_card_issues WHERE scope=? ORDER BY created_at DESC LIMIT 100', [scope]); }
        async function attachIssue(jobKey, issueKey) {
            const result = await execute(`UPDATE task_logs SET orbitcard_issue_key=? WHERE job_key=? AND orbitcard_state='prepared'
                AND (orbitcard_issue_key IS NULL OR orbitcard_issue_key=?)`, [issueKey,jobKey,issueKey]);
            if (!result.affectedRows) throw new CardPreparationError('任务已变更，不能关联新的开卡申请');
        }
        async function blockBalance(jobKey, required, message) {
            if (!jobKey) return;
            const result = await execute(`UPDATE task_logs SET orbitcard_state='balance_blocked',status='failed',
                orbitcard_required_balance=?,message=? WHERE job_key=? AND orbitcard_state='prepared'`, [required,message,jobKey]);
            if (!result.affectedRows) throw new CardPreparationError('任务已变更，不能覆盖原订单的余额状态');
        }
        async function fundingForJob(jobKey) {
            const rows = await query('SELECT * FROM orbitcard_card_fundings WHERE scope=? AND job_key=? LIMIT 1', [scope,jobKey]);
            return rows[0] || null;
        }
        async function createFunding(funding) {
            return transaction(async tx => {
                const opts = { connection: tx }, manual = funding.job_key.startsWith('manual-');
                const [owner] = await runQuery(manual
                    ? 'SELECT * FROM orbitcard_admin_orders WHERE client_order_no = ? FOR UPDATE'
                    : 'SELECT * FROM task_logs WHERE job_key=? FOR UPDATE', [funding.job_key], opts);
                if (!owner || (manual ? owner.state !== 'preparing' || owner.scope !== scope
                    || Number(owner.card_id) !== Number(funding.card_id) || planFor(owner.plan_type) !== funding.plan_type
                    : owner.orbitcard_state !== 'prepared' || cardScope(owner.orbitcard_base_url) !== scope
                    || Number(owner.orbitcard_card_id) !== Number(funding.card_id) || planFor(owner.orbitcard_plan_type) !== funding.plan_type)) {
                    throw new CardPreparationError('支付任务已变更，不能创建新的补款意图');
                }
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE',
                    [scope, funding.card_id], opts);
                if (!card || card.active_job !== funding.job_key) throw new CardPreparationError('补款卡片已不属于当前任务');
                await runExecute(`INSERT INTO orbitcard_card_fundings
                (funding_key,scope,job_key,plan_type,card_id,credential_hash,request_body,amount,target_balance,state)
                VALUES (?,?,?,?,?,?,?,?,?,'prepared')`, [funding.funding_key,scope,funding.job_key,funding.plan_type,funding.card_id,
                funding.credential_hash,funding.request_body,funding.amount,funding.target_balance], opts);
                return {...funding,scope,state:'prepared'};
            });
        }
        async function updateFunding(key, {state,order_no,provider_status,fee_snapshot,retry_at,message}) {
            await execute(`UPDATE orbitcard_card_fundings SET state=?,order_no=COALESCE(NULLIF(?,''),order_no),
                provider_status=COALESCE(?,provider_status),fee_snapshot=COALESCE(?,fee_snapshot),
                retry_at=COALESCE(?,retry_at),message=? WHERE funding_key=? AND scope=? AND state NOT IN ('ready','failed')`,
            [state,order_no || null,provider_status || null,fee_snapshot || null,retry_at ?? null,message || '',key,scope]);
        }
        async function listFundings(pending = false) {
            return query(`SELECT * FROM orbitcard_card_fundings WHERE scope=?${pending ? " AND state IN ('prepared','submitting','pending','unknown')" : ''}
                ORDER BY updated_at ${pending ? 'ASC' : 'DESC'} LIMIT 100`, [scope]);
        }
        return { syncCards, listCards, bindCard, reserveCard, pendingIssue, createIssue, updateIssue, completeIssue, listIssues, attachIssue, issueForJob,
            blockBalance, fundingForJob, createFunding, updateFunding, listFundings };
    }

    async function withCardAllocationLock(baseUrl, fn) {
        const scope = cardScope(baseUrl), name = `oc-card-${scope.slice(0, 48)}`;
        const connection = await openLockConnection();
        try {
            const rows = await runQuery('SELECT GET_LOCK(?, 10) AS acquired', [name], { connection });
            if (Number(rows[0]?.acquired) !== 1) throw new CardPreparationError('支付卡正在分配，请稍后重试');
            return await fn(methods(baseUrl, connection));
        } finally {
            // A dedicated connection cannot starve the query/transaction pool.
            // Disconnect always releases the advisory lock, including error paths.
            connection.destroy();
        }
    }

    // Called inside the same transaction that settles the CDK. Lock order is task -> card -> use.
    async function settleCardUse(jobKey, orbitcardState, options) {
        const found = await runQuery('SELECT * FROM orbitcard_card_uses WHERE job_key=?', [jobKey], options);
        const initial = found[0];
        if (!initial) return; // Historical orders predate automatic card allocation.
        await runQuery('SELECT card_id FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [initial.scope,initial.card_id], options);
        const uses = await runQuery('SELECT * FROM orbitcard_card_uses WHERE job_key=? FOR UPDATE', [jobKey], options);
        const current = uses[0], next = settlementState(current.state, orbitcardState);
        if (next === current.state) return;
        await runExecute('UPDATE orbitcard_card_uses SET state=? WHERE job_key=?', [next,jobKey], options);
        const column = `successful_${planFor(current.plan_type)}`;
        await runExecute(`UPDATE orbitcard_managed_cards SET ${column}=${column}+?,
            active_plan=IF(active_job=?,NULL,active_plan),active_job=IF(active_job=?,NULL,active_job) WHERE scope=? AND card_id=?`,
        [next === 'consumed' ? 1 : 0,jobKey,jobKey,current.scope,current.card_id], options);
    }

    async function getCardIssueForTask(jobKey) {
        const rows = await runQuery(`SELECT i.* FROM orbitcard_card_issues i JOIN task_logs t ON t.orbitcard_issue_key=i.issue_key
            WHERE t.job_key=? LIMIT 1`, [jobKey]);
        return rows[0] || null;
    }
    async function getCardFundingForTask(jobKey) {
        const rows = await runQuery('SELECT * FROM orbitcard_card_fundings WHERE job_key=? LIMIT 1', [jobKey]);
        return rows[0] || null;
    }
    return { cardMethods: methods, withCardAllocationLock, settleCardUse, getCardIssueForTask, getCardFundingForTask };
};
