'use strict';
const poolPolicy = require('./orbitcard-pool');
const { CardPreparationError } = require('./orbitcard-card-policy');

const { cardScope, planFor, settlementState } = require('./orbitcard-card-policy');

module.exports = function createCardStore({ runQuery, runExecute, withTransaction, openLockConnection, now = Date.now }) {
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
        async function listAuthorizations(cardId) {
            const rows = await query('SELECT transaction_id FROM orbitcard_card_authorizations WHERE scope=? AND card_id=?', [scope,cardId]);
            return rows.map(row => row.transaction_id);
        }
        async function saveAuthorizations(cardId, ids) {
            if (!Number.isSafeInteger(Number(cardId)) || Number(cardId) < 1 || !Array.isArray(ids)
                || ids.some(id => typeof id !== 'string' || !id || id.length > 128 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id))) {
                throw new CardPreparationError('成功消费授权记录格式无效');
            }
            const uniqueIds = [...new Set(ids)];
            return transaction(async tx => {
                const opts = { connection: tx };
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,cardId], opts);
                if (!card) throw new CardPreparationError('卡片摘要尚未登记，不能保存消费授权记录');
                for (let offset = 0; offset < uniqueIds.length; offset += 100) {
                    const batch = uniqueIds.slice(offset, offset + 100);
                    await runExecute(`INSERT IGNORE INTO orbitcard_card_authorizations (scope,card_id,transaction_id)
                        VALUES ${batch.map(() => '(?,?,?)').join(',')}`, batch.flatMap(id => [scope,cardId,id]), opts);
                }
                const [total] = await runQuery('SELECT COUNT(*) AS total FROM orbitcard_card_authorizations WHERE scope=? AND card_id=?', [scope,cardId], opts);
                const count = Number(total?.total);
                if (!Number.isSafeInteger(count) || count < 0) throw new CardPreparationError('成功消费授权次数无效');
                await runExecute(`UPDATE orbitcard_managed_cards SET authorization_count=?,authorizations_checked_at=UTC_TIMESTAMP(3)
                    WHERE scope=? AND card_id=?`, [count,scope,cardId], opts);
                const [saved] = await runQuery('SELECT authorization_count,authorizations_checked_at,authorization_pending_count FROM orbitcard_managed_cards WHERE scope=? AND card_id=?', [scope,cardId], opts);
                return saved;
            });
        }
        async function retireCard(cardId, key) {
            return transaction(async tx => {
                const opts = { connection: tx };
                const [card] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,cardId], opts);
                if (!card || card.active_job) throw new CardPreparationError('卡片不存在或仍被任务占用，稍后再删卡');
                if (card.retirement_key) return card;
                await runExecute("UPDATE orbitcard_managed_cards SET retirement_key=?,retirement_state='prepared' WHERE scope=? AND card_id=? AND retirement_key IS NULL AND active_job IS NULL", [key,scope,cardId], opts);
                return { ...card, retirement_key: key, retirement_state: 'prepared' };
            });
        }
        async function markRetirementSubmitted(cardId, key) {
            // Save uncertainty before sending: a process crash must never cause a second delete POST.
            const result = await execute("UPDATE orbitcard_managed_cards SET retirement_state='unknown' WHERE scope=? AND card_id=? AND retirement_key=? AND retirement_state='prepared' AND active_job IS NULL AND provider_status<>'DELETED'", [scope,cardId,key]);
            return result.affectedRows === 1;
        }
        async function confirmRetirement(cardId, key, card) {
            if (Number(card?.card_id) !== Number(cardId) || card?.provider_status !== 'DELETED') {
                throw new CardPreparationError('删卡确认缺少相符的卡 ID 或 DELETED 状态');
            }
            return transaction(async tx => {
                const opts = { connection: tx };
                const [current] = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,cardId], opts);
                if (!current || current.active_job || current.retirement_key !== key) throw new CardPreparationError('删卡意图已变更，不能确认删除');
                await methods(baseUrl, tx).syncCards([card]);
                await runExecute("UPDATE orbitcard_managed_cards SET retirement_state='confirmed' WHERE scope=? AND card_id=? AND retirement_key=?", [scope,cardId,key], opts);
                return card;
            });
        }
        async function listCards() {
            return query('SELECT * FROM orbitcard_managed_cards WHERE scope = ? ORDER BY authorization_count DESC, card_id', [scope]);
        }
        async function issueForJob(jobKey) {
            const rows = await query('SELECT * FROM orbitcard_card_issues WHERE scope=? AND job_key=? ORDER BY created_at DESC LIMIT 1', [scope, jobKey]);
            return rows[0] || null;
        }
        async function reserveCard(cardId, jobKey, planType) {
            const plan = planFor(planType);
            return transaction(async tx => {
                const opts = { connection: tx };
                const tasks = await runQuery('SELECT * FROM task_logs WHERE job_key=? FOR UPDATE', [jobKey], opts);
                const task = tasks[0];
                if (!task || !['preparing','prepared'].includes(task.orbitcard_state) || cardScope(task.orbitcard_base_url) !== scope || planFor(task.orbitcard_plan_type) !== plan) {
                    throw new CardPreparationError('充值任务已变更，不能预占卡片');
                }
                const cards = await runQuery('SELECT * FROM orbitcard_managed_cards WHERE scope=? AND card_id=? FOR UPDATE', [scope,cardId], opts);
                const card = cards[0];
                const uses = await runQuery('SELECT * FROM orbitcard_card_uses WHERE job_key=? FOR UPDATE', [jobKey], opts);
                if (uses[0]) {
                    if (uses[0].state === 'reserved' && Number(uses[0].card_id) === Number(cardId) && card?.active_job === jobKey) return card;
                    throw new CardPreparationError('本任务已绑定卡片，不允许更换支付卡');
                }
                if (!card || card.active_job || card.provider_status !== 'ACTIVE'
                    || !poolPolicy.eligible(card, now())) return null;
                await runExecute('INSERT INTO orbitcard_card_uses (job_key,scope,card_id,plan_type,state,authorization_baseline) VALUES (?,?,?,?,\'reserved\',?)', [jobKey,scope,cardId,plan,Number(card.authorization_count)], opts);
                await runExecute('UPDATE orbitcard_managed_cards SET active_job=? WHERE scope=? AND card_id=?', [jobKey,scope,cardId], opts);
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
                await runExecute(`UPDATE orbitcard_managed_cards SET source='issued'
                    WHERE scope=? AND card_id=?`, [scope,card.card_id], opts);
                await runExecute(`UPDATE orbitcard_card_issues SET state='ready',card_id=?,message='开卡成功'
                    WHERE issue_key=? AND scope=?`, [card.card_id,issue.issue_key,scope], opts);
            });
        }
        async function listIssues() { return query('SELECT * FROM orbitcard_card_issues WHERE scope=? ORDER BY created_at DESC LIMIT 100', [scope]); }
        async function attachIssue(jobKey, issueKey) {
            const result = await execute(`UPDATE task_logs SET orbitcard_issue_key=? WHERE job_key=? AND orbitcard_state IN ('preparing','prepared')
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
                    : !['preparing','prepared'].includes(owner.orbitcard_state) || cardScope(owner.orbitcard_base_url) !== scope
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
                retry_at=GREATEST(COALESCE(retry_at,0),COALESCE(?,0)),message=? WHERE funding_key=? AND scope=? AND state NOT IN ('ready','failed')`,
            [state,order_no || null,provider_status || null,fee_snapshot || null,retry_at ?? null,message || '',key,scope]);
        }
        async function deferFunding(key, retryAt) {
            await execute(`UPDATE orbitcard_card_fundings SET retry_at=GREATEST(COALESCE(retry_at,0),?)
                WHERE funding_key=? AND scope=? AND state<>'failed'`, [retryAt,key,scope]);
        }
        async function listFundings(pending = false) {
            return query(`SELECT * FROM orbitcard_card_fundings WHERE scope=?${pending ? " AND state IN ('prepared','submitting','pending','unknown')" : ''}
                ORDER BY updated_at ${pending ? 'ASC' : 'DESC'} LIMIT 100`, [scope]);
        }
        return { retireCard, markRetirementSubmitted, confirmRetirement, syncCards, listCards, listAuthorizations, saveAuthorizations, reserveCard, pendingIssue, createIssue, updateIssue, completeIssue, listIssues, attachIssue, issueForJob,
            blockBalance, fundingForJob, createFunding, updateFunding, deferFunding, listFundings };
    }

    async function withCardAllocationLock(baseUrl, fn) {
        const scope = cardScope(baseUrl), name = `oc-card-${scope.slice(0, 48)}`;
        const connection = await openLockConnection();
        try {
            const rows = await runQuery('SELECT GET_LOCK(?, 10) AS acquired', [name], { connection });
            if (Number(rows[0]?.acquired) !== 1) throw Object.assign(new CardPreparationError('支付卡正在分配，请稍后重试'), { code: 'CARD_ALLOCATION_BUSY' });
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
        if (next === 'consumed' && current.authorization_baseline != null) {
            // A successful order may finish before its authorization is visible. Keep
            // the next allocation waiting; only provider transaction IDs raise usage.
            const pending = Number(current.authorization_baseline) + 1;
            if (!Number.isSafeInteger(pending) || pending < 1) throw new CardPreparationError('原订单消费授权基准无效');
            const updated = await runExecute(`UPDATE orbitcard_managed_cards SET authorization_pending_count=GREATEST(COALESCE(authorization_pending_count,0),?)
                WHERE scope=? AND card_id=?`, [pending,current.scope,current.card_id], options);
            if (updated.affectedRows !== 1) throw new CardPreparationError('原订单卡片不存在，不能确认消费授权待同步状态');
        }
        // A successful authorization can appear before available balance catches up.
        // Failed payments may also leave a temporary authorization hold.
        if (['success', 'failed'].includes(orbitcardState)) {
            const updated = await runExecute(`UPDATE orbitcard_managed_cards SET reuse_after_ms=GREATEST(COALESCE(reuse_after_ms,0),?)
                WHERE scope=? AND card_id=?`, [now() + poolPolicy.REUSE_COOLDOWN_MS, current.scope, current.card_id], options);
            if (updated.affectedRows !== 1) throw new Error('原订单卡片不存在，不能保存支付后冷却时间');
        }
        await runExecute('UPDATE orbitcard_card_uses SET state=? WHERE job_key=?', [next,jobKey], options);
        await runExecute('UPDATE orbitcard_managed_cards SET active_job=NULL WHERE scope=? AND card_id=? AND active_job=?',
            [current.scope,current.card_id,jobKey], options);
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
