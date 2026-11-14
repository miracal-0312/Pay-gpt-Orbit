'use strict';
const assert = require('node:assert/strict');
const cardFactory = require('../../orbitcard-card-store');
const cdkFactory = require('../../orbitcard-cdk-store');
const { cardScope } = require('../../orbitcard-card-policy');
const BASE = 'https://orbitcard.test';

module.exports = function fixture({ enqueueRedemption, now: externalNow } = {}) {
    let clock = Date.now();
    const now = externalNow || (() => clock);
    const db = { cards: [], authorizations: [], uses: [], issues: [], fundings:[], tasks: [], cdks: [], failRelease: false };
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
            const task=db.tasks.find(t => t.job_key===p[0]);
            return task ? structuredClone(db.issues.filter(i => i.job_key===task.job_key || i.issue_key===task.orbitcard_issue_key).slice(0,2)) : [];
        }
        if (q.includes('FROM orbitcard_card_authorizations')) {
            const rows = db.authorizations.filter(row => row.scope === p[0] && row.card_id === Number(p[1]));
            return q.startsWith('SELECT COUNT(*)') ? [{total: rows.length}] : structuredClone(rows);
        }
        if (q.includes('FROM orbitcard_managed_cards')) return structuredClone(db.cards.filter(c => c.scope === p[0] && (!/card_id\s*=\s*\?/.test(q) || c.card_id === Number(p[1]))).sort((a,b) => b.authorization_count-a.authorization_count || a.card_id-b.card_id));
        if (q.includes('FROM orbitcard_card_uses')) return structuredClone(db.uses.filter(u => q.includes('WHERE scope=')
            ? u.scope === p[0] && u.card_id === p[1] && u.state === 'reserved' : u.job_key === p[0]));
        if (q.includes('FROM orbitcard_card_issues')) {
            const byOwnerOrKey = /WHERE \(?job_key\s*=\s*\? OR issue_key\s*=\s*\?/.test(q);
            const byKeyOrOwner = /WHERE \(?issue_key\s*=\s*\? OR job_key\s*=\s*\?/.test(q);
            return structuredClone(db.issues.filter(i => (byOwnerOrKey ? i.job_key===p[0] || i.issue_key===p[1]
                : byKeyOrOwner ? i.issue_key===p[0] || i.job_key===p[1]
                : (q.includes('WHERE issue_key=') ? i.issue_key === p[0] : i.scope === p[0])
                    && (!q.includes('plan_type=?') || i.plan_type === p[1]) && (!q.includes('job_key=?') || i.job_key === p[1]))
                && (!q.includes('state IN') || ['prepared','submitting','pending','unknown'].includes(i.state))));
        }
        if (q.includes('FROM cdk_codes')) return structuredClone(db.cdks.filter(c => c.cdk_code === p[0]));
        if (q.includes('FROM task_logs')) {
            if (q.includes('WHERE job_key')) return structuredClone(db.tasks.filter(t => t.job_key === p[0]));
            let tasks = db.tasks.filter(t => t.cdk_code === p[0]);
            if (q.includes('orbitcard_state IN')) tasks = tasks.filter(t => ['running','manual'].includes(t.status) || ['preparing','prepared','funding_waiting','funding_review','retry_waiting','support_locked','balance_blocked','funding_pending','submitting','pending','manual','success'].includes(t.orbitcard_state));
            if (q.includes('ORDER BY id DESC')) tasks = tasks.sort((a,b) => b.id-a.id).slice(0,1);
            return structuredClone(tasks);
        }
        throw new Error(`Unexpected test query: ${q}`);
    }
    async function runExecute(sql, p = []) {
        const q = clean(sql);
        if (q.startsWith('INSERT IGNORE INTO orbitcard_card_authorizations')) {
            for (let i=0;i<p.length;i+=3) if (!db.authorizations.some(row => row.scope===p[i] && row.card_id===Number(p[i+1]) && row.transaction_id===p[i+2]))
                db.authorizations.push({scope:p[i],card_id:Number(p[i+1]),transaction_id:p[i+2]});
            return {affectedRows:1};
        }
        if (q.startsWith('UPDATE orbitcard_managed_cards SET authorization_count=')) {
            const card = db.cards.find(c => c.scope === p[1] && c.card_id === Number(p[2]));
            if (!card) return {affectedRows:0};
            Object.assign(card, {authorization_count:p[0], authorizations_checked_at:new Date().toISOString()});
            return {affectedRows:1};
        }
        if (q.startsWith('UPDATE orbitcard_managed_cards SET authorization_pending_count=')) {
            const card = db.cards.find(c => c.scope === p[1] && c.card_id === Number(p[2]));
            if (!card) return {affectedRows:0};
            card.authorization_pending_count = Math.max(card.authorization_pending_count || 0, p[0]);
            return {affectedRows:1};
        }
        if (q.startsWith('UPDATE orbitcard_managed_cards SET reuse_after_ms=')) {
            const card = db.cards.find(c => c.scope === p[1] && c.card_id === Number(p[2]));
            if (!card) return {affectedRows:0};
            card.reuse_after_ms = Math.max(card.reuse_after_ms || 0, p[0]);
            return {affectedRows:1};
        }
        if (q.startsWith('UPDATE orbitcard_managed_cards SET retirement_key=')) {
            const card = db.cards.find(c => c.scope === p[1] && c.card_id === p[2]);
            if (!card || card.active_job || card.retirement_key) return {affectedRows:0};
            Object.assign(card, {retirement_key:p[0],retirement_state:'prepared'}); return {affectedRows:1};
        }
        if (q.startsWith("UPDATE orbitcard_managed_cards SET retirement_state='unknown'")) {
            const card = db.cards.find(c => c.scope === p[0] && c.card_id === p[1] && c.retirement_key === p[2]);
            if (!card || card.retirement_state !== 'prepared' || card.active_job || card.provider_status === 'DELETED') return {affectedRows:0};
            card.retirement_state = 'unknown'; return {affectedRows:1};
        }
        if (q.startsWith("UPDATE orbitcard_managed_cards SET retirement_state='confirmed'")) {
            const card = db.cards.find(c => c.scope === p[0] && c.card_id === p[1] && c.retirement_key === p[2]);
            if (!card) return {affectedRows:0};
            card.retirement_state = 'confirmed'; return {affectedRows:1};
        }
        if(q.startsWith('INSERT INTO orbitcard_card_fundings')) {
            assert.ok(!db.fundings.some(f => f.job_key===p[2]));db.fundings.push({funding_key:p[0],scope:p[1],job_key:p[2],plan_type:p[3],card_id:p[4],credential_hash:p[5],request_body:p[6],amount:p[7],target_balance:p[8],state:'prepared',retry_at:0});
        } else if(q.startsWith('UPDATE orbitcard_card_fundings SET retry_at=')) {
            const funding=db.fundings.find(f=>f.funding_key===p[1] && f.scope===p[2]);
            if(funding && funding.state!=='failed') funding.retry_at=Math.max(Number(funding.retry_at || 0),p[0]);
        } else if(q.startsWith('UPDATE orbitcard_card_fundings SET state=')) {
            const funding=db.fundings.find(f => f.funding_key===p[6] && f.scope===p[7]);
            if(!['ready','failed'].includes(funding.state)) Object.assign(funding,{state:p[0],order_no:p[1] || funding.order_no,provider_status:p[2] ?? funding.provider_status,fee_snapshot:p[3] ?? funding.fee_snapshot,retry_at:Math.max(Number(funding.retry_at || 0),p[4] || 0),message:p[5]});
        } else if(q.startsWith("UPDATE task_logs SET orbitcard_state='balance_blocked'")) {
            const task=db.tasks.find(t => t.job_key===p[2]);if(task?.orbitcard_state!=='prepared') return {affectedRows:0};
            Object.assign(task,{orbitcard_state:'balance_blocked',status:'failed',orbitcard_required_balance:p[0],message:p[1]});
        } else if (q.startsWith('INSERT INTO orbitcard_managed_cards')) {
            let card = db.cards.find(c => c.scope === p[0] && c.card_id === p[1]);
            if (!card) { card = { scope:p[0],card_id:p[1],authorization_count:null,authorizations_checked_at:null,authorization_pending_count:null,retirement_key:null,retirement_state:null,active_job:null,source:'imported' }; db.cards.push(card); }
            Object.assign(card,{ provider_status:p[2],product_code:p[3] || card.product_code || '',card_bin:p[4] || card.card_bin || '',last4:p[5] || card.last4 || '',balance:p[6],currency:p[7] });
        } else if (q.startsWith('INSERT INTO orbitcard_card_uses')) {
            assert.ok(!db.uses.some(u => u.job_key === p[0])); db.uses.push({ job_key:p[0],scope:p[1],card_id:p[2],plan_type:p[3],state:'reserved',authorization_baseline:p[4] });
        } else if (q.startsWith('INSERT INTO orbitcard_card_issues')) {
            assert.ok(!db.issues.some(i => i.issue_key === p[0])); db.issues.push({ issue_key:p[0],scope:p[1],job_key:p[2],plan_type:p[3],product_code:p[4],amount:p[5],credential_hash:p[6],request_body:p[7],state:'prepared',retry_at:0 });
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job=NULL')) {
            if (db.failRelease) throw new Error('injected card release failure');
            const card=db.cards.find(c=>c.scope===p[0] && c.card_id===p[1]);
            if(card.active_job===p[2]) card.active_job=null;
        } else if (q.startsWith('UPDATE orbitcard_managed_cards SET active_job=')) {
            db.cards.find(c=>c.scope===p[1] && c.card_id===p[2]).active_job=p[0];
        } else if (q.startsWith("UPDATE orbitcard_managed_cards SET source=")) {
            db.cards.find(c=>c.scope===p[0] && c.card_id===p[1]).source='issued';
        } else if (q.startsWith('UPDATE orbitcard_card_uses SET state')) {
            db.uses.find(u => u.job_key === p[1]).state=p[0];
        } else if (q.startsWith("UPDATE orbitcard_card_issues SET state='ready'")) {
            Object.assign(db.issues.find(i => i.issue_key === p[1]),{state:'ready',card_id:p[0]});
        } else if (q.startsWith('UPDATE orbitcard_card_issues SET state=')) {
            const issue=db.issues.find(i => i.issue_key === p[8] && i.scope === p[9]);
            if (!['ready','failed'].includes(issue.state)) Object.assign(issue,{state:p[0],order_no:p[1] || issue.order_no,card_id:p[2] || issue.card_id,message:p[3],provider_status:p[4] ?? issue.provider_status,completed:p[5] ?? issue.completed,fee_snapshot:p[6] ?? issue.fee_snapshot,retry_at:p[7] ?? issue.retry_at});
        } else if (q.startsWith('UPDATE task_logs SET orbitcard_issue_key')) {
            const task=db.tasks.find(t => t.job_key===p[1]); if(!['preparing','prepared'].includes(task?.orbitcard_state) || (task.orbitcard_issue_key && task.orbitcard_issue_key!==p[0])) return {affectedRows:0};task.orbitcard_issue_key=p[0];
        } else if (q.startsWith('UPDATE task_logs SET orbitcard_card_id')) {
            db.tasks.find(t => t.job_key === p[1]).orbitcard_card_id=p[0];
        } else if (q.startsWith('UPDATE task_logs SET orbitcard_client_order_no')) {
            if (q.includes('orbitcard_retry_attempt_no = ?')) {
                Object.assign(db.tasks.find(t => t.job_key === p[9]), {orbitcard_client_order_no:p[0],orbitcard_state:'preparing',
                    orbitcard_plan_type:p[1],orbitcard_email:p[2],orbitcard_base_url:p[3],orbitcard_retry_root_job_key:p[4],
                    orbitcard_retry_attempt_no:p[5],orbitcard_retry_first_card_id:p[6],orbitcard_retry_second_card_id:p[7],orbitcard_api_key_hash:p[8]});
                return {affectedRows:1};
            }
            Object.assign(db.tasks.find(t => t.job_key === p[6]), {orbitcard_client_order_no:p[0],orbitcard_state:/orbitcard_state = '([^']+)'/.exec(q)[1],orbitcard_plan_type:p[1],orbitcard_email:p[2],orbitcard_base_url:p[3],
                orbitcard_retry_root_job_key:p[4],orbitcard_retry_attempt_no:1,orbitcard_api_key_hash:p[5]});
        } else if (q.startsWith("UPDATE task_logs SET status = 'failed', orbitcard_state = 'support_locked'")) {
            const task=db.tasks.find(t => t.job_key === p[3]);
            Object.assign(task,{status:'failed',orbitcard_state:'support_locked',message:p[0],
                gpt_api_order_id:p[1] || task.gpt_api_order_id,gpt_api_raw:p[2] || task.gpt_api_raw});
        } else if (q.startsWith('UPDATE task_logs SET status = ?, progress = 99')) {
            Object.assign(db.tasks.find(t => t.job_key === p[5]),{status:p[0],progress:99,message:p[1],orbitcard_state:p[2],gpt_api_order_id:p[3],gpt_api_raw:p[4]});
        } else if (q.startsWith('UPDATE task_logs SET status')) {
            Object.assign(db.tasks.find(t => t.job_key === p[6]),{status:p[0],progress:p[1],message:p[2],orbitcard_state:p[3],gpt_api_order_id:p[4],gpt_api_raw:p[5]});
        } else if (q.startsWith('UPDATE cdk_codes SET used_at = NULL')) {
            const code = db.cdks.find(c => c.cdk_code === p[0]);
            if (!q.includes('manual_redeemed_at IS NULL') || !code.manual_redeemed_at) code.used_at = null;
        }
        else if (q.startsWith('UPDATE cdk_codes SET used_at')) db.cdks.find(c => c.cdk_code === p[0]).used_at ||= 'reserved';
        else throw new Error(`Unexpected test execute: ${q}`);
        return { affectedRows:1 };
    }
    const cardStore=cardFactory({runQuery,runExecute,withTransaction,now,getPool() { throw new Error('Unexpected real connection'); }});
    const cdkStore=cdkFactory({runQuery,runExecute,withTransaction,settleCardUse:cardStore.settleCardUse,enqueueRedemption,
        createTaskLog: async input => { const task={ id:++sequence,job_key:`job-${sequence}`,cdk_code:input.cdkCode,status:'running',progress:3 }; db.tasks.push(task); return {jobKey:task.job_key}; } });
    const automation=require('../../payment-automation')({runQuery});
    const store={...cardStore,...cdkStore,...automation,acquirePaymentLock:require('./payment-locks.cjs')().acquirePaymentLock,getTaskStatus:async key=>structuredClone(db.tasks.find(t=>t.job_key===key)),withCardAllocationLock(base, fn) {
        const pending=allocationTail.then(() => fn(cardStore.cardMethods(base))); allocationTail=pending.catch(() => {}); return pending;
    }};
    async function claim(plan='plus') {
        const cdk=`CODE-${db.cdks.length+1}`; db.cdks.push({cdk_code:cdk,type:'自助',is_active:1,plan_type:plan,used_at:null});
        const task=await cdkStore.createOrbitcardTask({cdk,planType:plan,email:'customer@example.test',baseUrl:BASE});
        // Most existing fixtures exercise historical prepared tasks. Dedicated
        // preparing tests call createOrbitcardTask directly to verify new tasks.
        db.tasks.find(row=>row.job_key===task.jobKey).orbitcard_state='prepared';
        return {...task,orbitcardState:'prepared'};
    }
    async function addCard(id=42, confirmed=true, used=0) {
        const card={card_id:id,provider_status:'ACTIVE',product_code:'p1',bin:'55565979',last4:'1234',balance:100,currency:'USD'};
        const methods=cardStore.cardMethods(BASE);
        await methods.syncCards([card]);
        if(confirmed) await methods.saveAuthorizations(id,Array.from({length:used},(_,i)=>String(i)));
        return card;
    }
    const settle=(task,state) => cdkStore.settleOrbitcardTask(task.jobKey,{status:state==='success'?'success':['failed','rejected'].includes(state)?'failed':state==='manual'?'manual':'running',orbitcardState:state,progress:90,message:state,
        ...(state==='submitting'?{expectedState:'prepared',expectedClientOrderNo:task.orbitcardClientOrderNo}:{})});
    return {db,store,claim,addCard,settle,now,advance:(ms=300000)=>{clock+=ms;},base:BASE,scope:cardScope(BASE)};
};
