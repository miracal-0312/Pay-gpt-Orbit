'use strict';
const assert = require('node:assert/strict');
const cardFactory = require('../../orbitcard-card-store');
const cdkFactory = require('../../orbitcard-cdk-store');
const { cardScope } = require('../../orbitcard-card-policy');
const BASE = 'https://orbitcard.test';

module.exports = function fixture() {
    const db = { cards: [], uses: [], issues: [], fundings:[], tasks: [], cdks: [], failIncrement: false };
    let tail = Promise.resolve(), allocationTail = Promise.resolve(), sequence = 0;
    async function withTransaction(fn) {
        const pending = tail.then(async () => {
            const backup = structuredClone(db);
            try { return await fn({ fixtureTransaction: true }); } catch (error) { Object.assign(db, backup); throw error; }
        });
        tail = pending.catch(() => {}); return pending;
    }
    const clean = sql => sql.replace(/\s+/g, ' ').trim();
    async function runQuery(sql, p = []) {
        const q = clean(sql);
        if(q.includes('FROM orbitcard_card_fundings')) return structuredClone(db.fundings.filter(f =>
            (q.includes('WHERE job_key=')?f.job_key===p[0]:f.scope===p[0] && (!q.includes('job_key=?') || f.job_key===p[1]))
                && (!q.includes('state IN') || ['prepared','submitting','pending','unknown'].includes(f.state))));
        if(q.startsWith('SELECT i.* FROM orbitcard_card_issues')) {
            const task=db.tasks.find(t => t.job_key===p[0]);return structuredClone(db.issues.filter(i => i.issue_key===task?.orbitcard_issue_key));
        }
        if (q.includes('LEFT JOIN orbitcard_card_uses')) return db.tasks.filter(t => ['running','manual'].includes(t.status) && !db.uses.some(u => u.job_key === t.job_key));
        if (q.includes('FROM orbitcard_managed_cards')) return structuredClone(db.cards.filter(c => c.scope === p[0] && (!q.includes('card_id=?') || c.card_id === Number(p[1]))).sort((a,b) => b.successful_plus-a.successful_plus || a.card_id-b.card_id));
        if (q.includes('FROM orbitcard_card_uses')) return structuredClone(db.uses.filter(u => u.job_key === p[0]));
        if (q.includes('FROM orbitcard_card_issues')) return structuredClone(db.issues.filter(i => (q.includes('WHERE issue_key=') ? i.issue_key === p[0] : i.scope === p[0]) && (!q.includes('plan_type=?') || i.plan_type === p[1])
            && (!q.includes('job_key=?') || i.job_key === p[1])
            && (!q.includes('state IN') || ['prepared','submitting','pending','unknown'].includes(i.state))));
        if (q.includes('FROM cdk_codes')) return structuredClone(db.cdks.filter(c => c.cdk_code === p[0]));
        if (q.includes('FROM task_logs')) {
            if (q.includes('WHERE job_key')) return structuredClone(db.tasks.filter(t => t.job_key === p[0]));
            let tasks = db.tasks.filter(t => t.cdk_code === p[0]);
            if (q.includes('orbitcard_state IN')) tasks = tasks.filter(t => ['running','manual'].includes(t.status) || ['prepared','retry_waiting','support_locked','balance_blocked','funding_pending','submitting','pending','manual','success'].includes(t.orbitcard_state));
            if (q.includes('ORDER BY id DESC')) tasks = tasks.sort((a,b) => b.id-a.id).slice(0,1);
            return structuredClone(tasks);
        }
        throw new Error(`Unexpected test query: ${q}`);
    }
    async function runExecute(sql, p = []) {
        const q = clean(sql);
        if(q.startsWith('INSERT INTO orbitcard_card_fundings')) {
            assert.ok(!db.fundings.some(f => f.job_key===p[2]));db.fundings.push({funding_key:p[0],scope:p[1],job_key:p[2],plan_type:p[3],card_id:p[4],credential_hash:p[5],request_body:p[6],amount:p[7],target_balance:p[8],state:'prepared',retry_at:0});
        } else if(q.startsWith('UPDATE orbitcard_card_fundings SET state=')) {
            const funding=db.fundings.find(f => f.funding_key===p[6] && f.scope===p[7]);
            if(!['ready','failed'].includes(funding.state)) Object.assign(funding,{state:p[0],order_no:p[1] || funding.order_no,provider_status:p[2] ?? funding.provider_status,fee_snapshot:p[3] ?? funding.fee_snapshot,retry_at:p[4] ?? funding.retry_at,message:p[5]});
        } else if(q.startsWith("UPDATE task_logs SET orbitcard_state='balance_blocked'")) {
            const task=db.tasks.find(t => t.job_key===p[2]);if(task?.orbitcard_state!=='prepared') return {affectedRows:0};
            Object.assign(task,{orbitcard_state:'balance_blocked',status:'failed',orbitcard_required_balance:p[0],message:p[1]});
        } else if (q.startsWith('INSERT INTO orbitcard_managed_cards')) {
            let card = db.cards.find(c => c.scope === p[0] && c.card_id === p[1]);
            if (!card) { card = { scope:p[0],card_id:p[1],history_confirmed:0,successful_plus:0,successful_pro100:0,successful_pro200:0,successful_pro500:0,active_job:null,active_plan:null,source:'imported' }; db.cards.push(card); }
            Object.assign(card,{ provider_status:p[2],product_code:p[3] || card.product_code || '',card_bin:p[4] || card.card_bin || '',last4:p[5] || card.last4 || '',balance:p[6],currency:p[7] });
        } else if (q.startsWith('INSERT INTO orbitcard_card_uses')) {
            assert.ok(!db.uses.some(u => u.job_key === p[0])); db.uses.push({ job_key:p[0],scope:p[1],card_id:p[2],plan_type:p[3],state:'reserved' });
        } else if (q.startsWith('INSERT INTO orbitcard_card_issues')) {
            assert.ok(!db.issues.some(i => i.issue_key === p[0])); db.issues.push({ issue_key:p[0],scope:p[1],job_key:p[2],plan_type:p[3],product_code:p[4],amount:p[5],credential_hash:p[6],request_body:p[7],state:'prepared',retry_at:0 });
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job')) {
            Object.assign(db.cards.find(c => c.scope === p[2] && c.card_id === p[3]),{active_job:p[0],active_plan:p[1]});
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET successful_')) {
            if (db.failIncrement) throw new Error('injected database write failure');
            const card=db.cards.find(c => c.scope === p[3] && c.card_id === p[4]);const column=q.match(/SET (successful_\w+)=/)[1];card[column]+=p[0]; if (card.active_job === p[1]) {card.active_job=null;card.active_plan=null;}
        } else if (q.startsWith("UPDATE orbitcard_managed_cards SET history_confirmed=1,source=")) {
            const card=db.cards.find(c => c.scope === p[0] && c.card_id === p[1]); card.history_confirmed=1;card.source='issued';
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET history_confirmed=')) {
            Object.assign(db.cards.find(c => c.scope === p[4] && c.card_id === p[5]),{history_confirmed:1,successful_plus:p[0],successful_pro100:p[1],successful_pro200:p[2],successful_pro500:p[3]});
        } else if (q.startsWith('UPDATE orbitcard_card_uses SET state')) {
            db.uses.find(u => u.job_key === p[1]).state=p[0];
        } else if (q.startsWith("UPDATE orbitcard_card_issues SET state='ready'")) {
            Object.assign(db.issues.find(i => i.issue_key === p[1]),{state:'ready',card_id:p[0]});
        } else if (q.startsWith('UPDATE orbitcard_card_issues SET state=')) {
            const issue=db.issues.find(i => i.issue_key === p[8] && i.scope === p[9]);
            if (!['ready','failed'].includes(issue.state)) Object.assign(issue,{state:p[0],order_no:p[1] || issue.order_no,card_id:p[2] || issue.card_id,message:p[3],provider_status:p[4] ?? issue.provider_status,completed:p[5] ?? issue.completed,fee_snapshot:p[6] ?? issue.fee_snapshot,retry_at:p[7] ?? issue.retry_at});
        } else if (q.startsWith('UPDATE task_logs SET orbitcard_issue_key')) {
            const task=db.tasks.find(t => t.job_key===p[1]); if(task?.orbitcard_state!=='prepared' || (task.orbitcard_issue_key && task.orbitcard_issue_key!==p[0])) return {affectedRows:0};task.orbitcard_issue_key=p[0];
        } else if (q.startsWith('UPDATE task_logs SET orbitcard_card_id')) {
            db.tasks.find(t => t.job_key === p[1]).orbitcard_card_id=p[0];
        } else if (q.startsWith("UPDATE task_logs SET orbitcard_client_order_no = ?, orbitcard_state = 'retry_waiting'")) {
            Object.assign(db.tasks.find(t => t.job_key === p[10]), {orbitcard_client_order_no:p[0],orbitcard_state:'retry_waiting',orbitcard_plan_type:p[1],orbitcard_email:p[2],orbitcard_base_url:p[3],
                orbitcard_retry_root_job_key:p[4],orbitcard_retry_attempt_no:p[5],orbitcard_retry_first_card_id:p[6],orbitcard_retry_second_card_id:p[7],orbitcard_api_key_hash:p[8],message:p[9]});
        } else if (q.startsWith('UPDATE task_logs SET orbitcard_client_order_no')) {
            Object.assign(db.tasks.find(t => t.job_key === p[6]), {orbitcard_client_order_no:p[0],orbitcard_state:'prepared',orbitcard_plan_type:p[1],orbitcard_email:p[2],orbitcard_base_url:p[3],
                orbitcard_retry_root_job_key:p[4],orbitcard_retry_attempt_no:1,orbitcard_api_key_hash:p[5]});
        } else if (q.startsWith("UPDATE task_logs SET orbitcard_state = 'prepared'")) {
            Object.assign(db.tasks.find(t => t.job_key === p[0]),{orbitcard_state:'prepared',message:'正在准备下一次支付尝试'});
        } else if (q.startsWith("UPDATE task_logs SET status = 'failed', orbitcard_state = 'support_locked'")) {
            const task=db.tasks.find(t => t.job_key === p[3]);
            Object.assign(task,{status:'failed',orbitcard_state:'support_locked',message:p[0],
                gpt_api_order_id:p[1] || task.gpt_api_order_id,gpt_api_raw:p[2] || task.gpt_api_raw});
        } else if (q.startsWith('UPDATE task_logs SET status = ?, progress = 99')) {
            Object.assign(db.tasks.find(t => t.job_key === p[5]),{status:p[0],progress:99,message:p[1],orbitcard_state:p[2],gpt_api_order_id:p[3],gpt_api_raw:p[4]});
        } else if (q.startsWith('UPDATE task_logs SET status')) {
            Object.assign(db.tasks.find(t => t.job_key === p[6]),{status:p[0],progress:p[1],message:p[2],orbitcard_state:p[3],gpt_api_order_id:p[4],gpt_api_raw:p[5]});
        } else if (q.startsWith('UPDATE cdk_codes SET used_at = NULL')) db.cdks.find(c => c.cdk_code === p[0]).used_at=null;
        else if (q.startsWith('UPDATE cdk_codes SET used_at')) db.cdks.find(c => c.cdk_code === p[0]).used_at ||= 'reserved';
        else throw new Error(`Unexpected test execute: ${q}`);
        return { affectedRows:1 };
    }
    const cardStore=cardFactory({runQuery,runExecute,withTransaction,getPool() { throw new Error('Unexpected real connection'); }});
    const cdkStore=cdkFactory({runQuery,runExecute,withTransaction,settleCardUse:cardStore.settleCardUse,
        createTaskLog: async input => { const task={ id:++sequence,job_key:`job-${sequence}`,cdk_code:input.cdkCode,status:'running',progress:3 }; db.tasks.push(task); return {jobKey:task.job_key}; } });
    const store={...cardStore,...cdkStore,acquirePaymentLock:require('./payment-locks.cjs')().acquirePaymentLock,getTaskStatus:async key=>structuredClone(db.tasks.find(t=>t.job_key===key)),withCardAllocationLock(base, fn) {
        const pending=allocationTail.then(() => fn(cardStore.cardMethods(base))); allocationTail=pending.catch(() => {}); return pending;
    }};
    async function claim(plan='plus') {
        const cdk=`CODE-${db.cdks.length+1}`; db.cdks.push({cdk_code:cdk,type:'自助',is_active:1,plan_type:plan,used_at:null});
        return cdkStore.createOrbitcardTask({cdk,planType:plan,email:'customer@example.test',baseUrl:BASE});
    }
    async function addCard(id=42, confirmed=true, used=0) {
        const card={card_id:id,provider_status:'ACTIVE',product_code:'p1',bin:'55565979',last4:'1234',balance:100,currency:'USD'};
        await cardStore.cardMethods(BASE).syncCards([card]); Object.assign(db.cards.find(c => c.card_id === id),{history_confirmed:confirmed?1:0,successful_plus:used}); return card;
    }
    const settle=(task,state) => cdkStore.settleOrbitcardTask(task.jobKey,{status:state==='success'?'success':['failed','rejected'].includes(state)?'failed':'manual',orbitcardState:state,progress:90,message:state,
        ...(state==='submitting'?{expectedState:'prepared',expectedClientOrderNo:task.orbitcardClientOrderNo}:{})});
    return {db,store,claim,addCard,settle,base:BASE,scope:cardScope(BASE)};
};
