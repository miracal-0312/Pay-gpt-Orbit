'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const factory = require('../src/db/email-notification-store');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function fixture() {
    let clock = 1700000000000, failObservation = false, tail = Promise.resolve();
    const db = { events:[],observations:[],balances:[] }, reads = [];
    async function withTransaction(fn) {
        const run = tail.then(async () => { const backup = structuredClone(db); try { return await fn({test:true}); }
            catch (error) { Object.assign(db,backup); throw error; } });
        tail = run.catch(() => {}); return run;
    }
    async function runQuery(sql, p = []) {
        const q = sql.replace(/\s+/g,' ').trim(); reads.push({q,p});
        if (q.includes('FROM task_logs t') || q.includes('FROM orbitcard_admin_orders m')) return [];
        if (q.startsWith('SELECT * FROM email_balance_alerts')) return structuredClone(db.balances.filter(row => row.alert_key===p[0] && row.check_token===p[1]));
        if (q.includes('FROM email_notification_outbox')) {
            if (q.startsWith('SELECT event_type')) return db.events.map(row => ({ event_type:row.event_type,target_email:row.target_email,
                attempts:row.attempts,last_error:row.last_error,created_at:row.created_at,delivered_at:row.delivered_at,
                status:row.delivered_at?'sent':row.attempts>=p[0]?'failed':'pending' })).slice(0,p[1]);
            return structuredClone(db.events.filter(row => row.target_hash===p[0] && !row.delivered_at && row.attempts<p[1]
                && row.next_attempt_at<=p[2] && row.lease_until<=p[3] && p.slice(4).includes(row.event_type)).slice(0,10));
        }
        throw Error(`Unexpected query ${q}`);
    }
    async function runExecute(sql, p = []) {
        const q = sql.replace(/\s+/g,' ').trim();
        if (q.startsWith('INSERT INTO email_notification_outbox')) {
            if (!db.events.some(row => row.event_id===p[0])) db.events.push({event_id:p[0],event_type:p[1],target_email:p[2],target_hash:p[3],subject:p[4],body:p[5],
                attempts:0,next_attempt_at:0,lease_until:0,lease_token:null,last_error:null,delivered_at:null,created_at:clock});
        } else if (q.startsWith('INSERT INTO email_notification_observations')) {
            if (failObservation) throw Error('observation unavailable');
            let row = db.observations.find(row => row.source_type===p[0] && row.record_key===p[1] && row.target_hash===p[2]);
            if (!row) { row={source_type:p[0],record_key:p[1],target_hash:p[2]}; db.observations.push(row); }
            Object.assign(row,{version_key:p[3],enabled_since:p[4]});
        } else if (q.startsWith('INSERT IGNORE INTO email_balance_alerts')) {
            if (!db.balances.some(row => row.alert_key===p[0])) db.balances.push({alert_key:p[0],account_key:p[1],target_hash:p[2],
                is_low:0,alert_sequence:0,last_queued_at:0,last_checked_at:0,next_check_at:0,check_token:null});
        } else if (q.startsWith('UPDATE email_balance_alerts SET check_token=?')) {
            const row = db.balances.find(row => row.alert_key===p[2] && row.next_check_at<=p[3]);
            if (!row) return {affectedRows:0}; Object.assign(row,{check_token:p[0],next_check_at:p[1]});
        } else if (q.startsWith('UPDATE email_balance_alerts SET is_low=')) {
            const row = db.balances.find(row => row.alert_key===p[4] && row.check_token===p[5]);
            if (!row) return {affectedRows:0}; Object.assign(row,{is_low:p[0],alert_sequence:p[1],last_queued_at:p[2],last_checked_at:p[3],check_token:null});
        } else if (q.startsWith('UPDATE email_balance_alerts SET check_token=NULL')) {
            const row = db.balances.find(row => row.alert_key===p[1] && row.check_token===p[2]);
            if (!row) return {affectedRows:0}; row.check_token=null; row.next_check_at=Math.max(row.next_check_at,p[0]);
        } else if (q.startsWith('UPDATE email_notification_outbox SET lease_token=?')) {
            const row = db.events.find(row => row.event_id===p[2] && !row.delivered_at && row.attempts<p[3] && row.next_attempt_at<=p[4] && row.lease_until<=p[5]);
            if (!row) return {affectedRows:0}; row.lease_token=p[0];row.lease_until=p[1];row.attempts++;
        } else if (q.startsWith('UPDATE email_notification_outbox SET delivered_at=')) {
            const row = db.events.find(row => row.event_id===p[0] && row.lease_token===p[1]);
            if (!row) return {affectedRows:0}; Object.assign(row,{delivered_at:clock,lease_token:null,lease_until:0,last_error:null});
        } else if (q.startsWith('UPDATE email_notification_outbox SET lease_token=NULL')) {
            const deferred = q.includes('attempts=GREATEST');
            const row = db.events.find(row => row.event_id===p[deferred?1:2] && row.lease_token===p[deferred?2:3]);
            if (!row) return {affectedRows:0};
            Object.assign(row,{lease_token:null,lease_until:0});
            if (deferred) { row.attempts=Math.max(0,row.attempts-1); row.next_attempt_at=p[0]; }
            else { row.last_error=p[0];row.next_attempt_at=p[1]+Math.min(3600000,30000*2**(row.attempts-1)); }
        } else throw Error(`Unexpected execute ${q}`);
        return {affectedRows:1};
    }
    const store = factory({runQuery,runExecute,withTransaction,now:()=>clock});
    return {store,db,reads,advance:ms=>{clock+=ms;},failObservation:value=>{failObservation=value;},
        recreate:()=>factory({runQuery,runExecute,withTransaction,now:()=>clock})};
}
const target = 'admin@example.test';
const observed = {source_type:'self_service',record_key:'job-1',version_key:hash('v1'),enabled_since:1700000000123};
const event = {event_id:hash('event'),event_type:'order_success',subject:'充值成功',text:'安全订单信息'};

test('event and observation commit together, retries deduplicate and rollback never loses discovery',async()=>{
    const f=fixture();f.failObservation(true);
    await assert.rejects(f.store.commitEmailObservation(observed,target,event),/unavailable/);
    assert.equal(f.db.events.length,0);assert.equal(f.db.observations.length,0);
    f.failObservation(false);
    await f.store.commitEmailObservation(observed,target,event);
    await f.store.commitEmailObservation({...observed,version_key:hash('v2')},target,event);
    assert.equal(f.db.events.length,1);assert.equal(f.db.observations[0].version_key,hash('v2'));
});

test('order scans include the activation second, latest self-service attempt and observation versions',async()=>{
    const f=fixture();await f.store.listEmailOrderCandidates({since:1700000000123,targetEmail:target,limit:999});
    assert.equal(f.reads.length,2);
    for(const {q,p} of f.reads){ assert.equal(p[1],1700000000000);assert.equal(p[2],1700000000123);assert.equal(p[3],100);
        assert.match(q,/o\.version_key<>SHA2/);assert.doesNotMatch(q,/session_payload|token_preview|SELECT \*/); }
    assert.match(f.reads[0].q,/newer\.cdk_code=t\.cdk_code AND newer\.id>t\.id/);
    assert.match(f.reads[0].q,/COALESCE\(NULLIF\(newer\.orbitcard_retry_root_job_key/);
    assert.match(f.reads[0].q,/t\.updated_at>=FROM_UNIXTIME/);
    assert.match(f.reads[1].q,/m\.updated_at>=FROM_UNIXTIME/);
    assert.doesNotMatch(f.reads[0].q,/IN \([^)]*retry_waiting/);
});

test('delivery lease allows one sender, respects target and event switches, and ignores stale acknowledgements',async()=>{
    const f=fixture();await f.store.commitEmailObservation(observed,target,event);
    assert.deepEqual(await f.store.listPendingEmails('new@example.test'),[]);
    assert.deepEqual(await f.store.listPendingEmails(target,['low_balance']),[]);
    const claims=await Promise.all([f.store.claimEmailDelivery(event.event_id),f.store.claimEmailDelivery(event.event_id)]);
    assert.equal(claims.filter(Boolean).length,1);
    await f.store.finishEmailDelivery(event.event_id,'stale-token',{ok:true});assert.equal(f.db.events[0].delivered_at,null);
    await f.store.finishEmailDelivery(event.event_id,claims.find(Boolean),{ok:true});
    assert.deepEqual(await f.store.listPendingEmails(target),[]);
    const history=await f.store.getEmailNotificationHistory();assert.equal(history[0].status,'sent');
    assert.equal(history[0].body,undefined);assert.equal(history[0].subject,undefined);
});

test('SMTP failures have bounded durable retries and never persist raw error details',async()=>{
    const f=fixture();await f.store.commitEmailObservation(observed,target,event);
    for(let n=0;n<factory.MAX_ATTEMPTS;n++){
        const lease=await f.recreate().claimEmailDelivery(event.event_id);assert.ok(lease);
        await f.store.finishEmailDelivery(event.event_id,lease,{ok:false,error_code:'secret-password-raw-response'});
        assert.equal(f.db.events[0].last_error,'smtp_transport');
        assert.equal(await f.store.claimEmailDelivery(event.event_id),null);f.advance(3600000);
    }
    assert.equal(await f.store.claimEmailDelivery(event.event_id),null);
    assert.equal((await f.store.getEmailNotificationHistory())[0].status,'failed');
});

test('configuration pauses release a delivery without consuming a send attempt',async()=>{
    const f=fixture();await f.store.commitEmailObservation(observed,target,event);
    const lease=await f.store.claimEmailDelivery(event.event_id);
    await f.store.finishEmailDelivery(event.event_id,lease,{deferred:true});
    assert.equal(f.db.events[0].attempts,0);assert.equal(await f.store.claimEmailDelivery(event.event_id),null);
    f.advance(30000);assert.ok(await f.store.claimEmailDelivery(event.event_id));
});

test('low balance checks and alerts persist across restart, cooldown, recovery and account changes',async()=>{
    const f=fixture(),account=hash('platform/key');
    async function observe(low,store=f.store){const claim=await store.claimEmailBalanceCheck(account,target);assert.ok(claim);
        await store.completeEmailBalanceCheck(claim,{low,available:low?'19.00':'25.00',threshold:'20.00',platform:'https://orbitcard.test',cooldown_minutes:360});}
    const claims=await Promise.all([f.store.claimEmailBalanceCheck(account,target),f.store.claimEmailBalanceCheck(account,target)]);
    assert.equal(claims.filter(Boolean).length,1);
    await f.store.completeEmailBalanceCheck(claims.find(Boolean),{low:true,available:'19.00',threshold:'20.00',platform:'https://orbitcard.test',cooldown_minutes:360});
    assert.equal(f.db.events.length,1);assert.equal(await f.recreate().claimEmailBalanceCheck(account,target),null);
    f.advance(300000);await observe(true,f.recreate());assert.equal(f.db.events.length,1);
    f.advance(360*60000);await observe(true);assert.equal(f.db.events.length,2);
    f.advance(300000);await observe(false);f.advance(300000);await observe(true);assert.equal(f.db.events.length,3);
    assert.ok(await f.store.claimEmailBalanceCheck(hash('changed-key'),target));
    assert.ok(await f.store.claimEmailBalanceCheck(account,'other@example.test'));
});

test('balance read errors honor longer retry-after without changing the last known low state',async()=>{
    const f=fixture(),account=hash('account'),claim=await f.store.claimEmailBalanceCheck(account,target);
    await f.store.deferEmailBalanceCheck(claim,900000);
    f.advance(300000);assert.equal(await f.recreate().claimEmailBalanceCheck(account,target),null);
    assert.equal(f.db.events.length,0);assert.equal(f.db.balances[0].is_low,0);
    f.advance(600000);assert.ok(await f.store.claimEmailBalanceCheck(account,target));
});
