'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/card-db.cjs');
const createSync = require('../src/orbitcard/orbitcard-order-sync');
const { verifiedSuccess } = require('../src/db/orbitcard-order-usage');
const proof = (id, cardId = 42) => ({ task_no: `sub-${id}`, client_order_no: `client-${id}`, card_id: cardId,
    status: 'succeeded', subscription_succeeded: true, query_source: 'upstream' });
const entry = (id, cardId = 42) => ({ clientOrderNo: `client-${id}`, orderId: `sub-${id}`, cardId, snapshot: proof(id, cardId) });

test('concurrent repeated platform success increments once and persists across a new store reader', async () => {
    const f = fixture(); await f.addCard();
    const results = await Promise.all(Array.from({length:20}, () => f.store.cardMethods(f.base).recordSuccessfulOrder(entry('one'))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.db.cards[0].successful_order_count, 1);
    assert.equal((await f.store.cardMethods(f.base).listSuccessfulOrders()).length, 1);
    assert.equal(f.db.cards[0].authorization_count, 0);
});

test('local flags, missing evidence, failed/pending and unverified snapshots never count', async () => {
    const f = fixture(); await f.addCard();
    for (const snapshot of [undefined, {status:'success'}, {...proof('x'),query_source:undefined},
        {...proof('x'),query_source:'snapshot'}, {...proof('x'),status:'failed'},
        {...proof('x'),upstream_status:'pending'}, {...proof('x'),request_error:{code:'timeout'}},
        {...proof('x'),client_order_no:'foreign'}, {...proof('x'),card_id:99}]) {
        assert.equal(await f.store.cardMethods(f.base).recordSuccessfulOrder({...entry('x'),snapshot}),false);
    }
    assert.equal(f.db.cards[0].successful_order_count,0);
    const task=await f.claim();await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    await f.store.settleOrbitcardTask(task.jobKey,{status:'success',orbitcardState:'success',message:'manually marked',progress:100});
    assert.equal(f.db.cards[0].successful_order_count,0);
});

test('verified terminal platform snapshots count, conflicting identities cannot credit another card',async()=>{
    const f=fixture();await f.addCard();await f.addCard(43);
    const first=entry('one');first.snapshot={...first.snapshot,query_source:'snapshot',result_source:'upstream',upstream_status:'succeeded'};
    await f.store.cardMethods(f.base).recordSuccessfulOrder(first);
    await assert.rejects(f.store.cardMethods(f.base).recordSuccessfulOrder(entry('one',43)),/已关联/);
    const other={...entry('two',43),orderId:'sub-one',snapshot:{...proof('two',43),task_no:'sub-one'}};
    await assert.rejects(f.store.cardMethods(f.base).recordSuccessfulOrder(other),/已关联/);
    assert.deepEqual(f.db.cards.map(c=>c.successful_order_count),[1,0]);
});

test('self-service platform settlement counts atomically and stops reuse after the third success',async()=>{
    const f=fixture();await f.addCard();
    for(let n=0;n<3;n++){
        const task=await f.claim();assert.ok(await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus',4));
        await Promise.all([f.settle(task,'success'),f.settle(task,'success')]);
        assert.equal(f.db.cards[0].successful_order_count,n+1);assert.equal(f.db.cards[0].active_job,null);
    }
    const next=await f.claim();assert.equal(await f.store.cardMethods(f.base).reserveCard(42,next.jobKey,'plus',4),null);
    assert.equal(f.db.cards[0].authorization_count,0);
});

test('a failed release on the third success rolls back the ledger, counter and disable marker',async()=>{
    const f=fixture();await f.addCard(42,true,2);const task=await f.claim();await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    f.db.failRelease=true;await assert.rejects(f.settle(task,'success'));
    assert.equal(f.db.cards[0].successful_order_count,2);assert.equal((await f.store.cardMethods(f.base).listSuccessfulOrders()).length,0);
    assert.ok(!f.db.cards[0].disabled_at);
    f.db.failRelease=false;await f.settle(task,'success');assert.equal(f.db.cards[0].successful_order_count,3);
    assert.equal(f.db.cards[0].disabled_code,'success_limit_reached');
});

async function syncFixture(rows, transform = x=>x) {
    const f=fixture();await f.addCard();const calls=[];
    const api={request:async(_cfg,operation,body)=>{
        calls.push({operation,body});
        if(operation==='getSubscriptionList')return {success:true,data:{page:body.page,total:rows.length,items:rows.slice((body.page-1)*20,body.page*20)}};
        assert.equal(operation,'getSubscription');return transform({success:true,data:rows.find(row=>row.task_no===body.task_no)});
    }};
    return {...f,calls,sync:createSync({api,store:f.store}),cfg:{base_url:f.base},cards:[{card_id:42}]};
}

test('platform history paginates, verifies original orders and deduplicates repeated synchronization',async()=>{
    const f=await syncFixture(Array.from({length:23},(_,i)=>proof(i)));
    let result=await f.sync.synchronize(f.cfg,f.cards);assert.equal(result.added,23);assert.equal(result.complete,true);
    assert.equal(f.db.cards[0].successful_order_count,23);
    result=await f.sync.synchronize(f.cfg,f.cards);assert.equal(result.added,0);
    assert.equal(f.calls.filter(c=>c.operation==='getSubscription').length,23);
    assert.ok(f.calls.every(c=>['getSubscriptionList','getSubscription'].includes(c.operation)));
});

test('list success alone cannot count an unconfirmed or foreign detail',async()=>{
    for(const data of [{...proof('x'),status:'processing'}, {...proof('x'),card_id:43}, {...proof('x'),client_order_no:'foreign'}, {...proof('x'),query_source:'snapshot'}]) {
        const f=await syncFixture([proof('x')],()=>({success:true,data}));
        const result=await f.sync.synchronize(f.cfg,f.cards);assert.equal(result.complete,false);assert.equal(result.added,0);
        assert.equal(f.db.cards[0].successful_order_count,0);
    }
});

test('orders missing card ownership are unresolved; a saved original binding is usable irrespective of local status',async()=>{
    const row=proof('x');delete row.card_id;
    const f=await syncFixture([row]);let result=await f.sync.synchronize(f.cfg,f.cards);
    assert.equal(result.unresolved[0].reason,'card_identity_missing');assert.equal(result.added,0);
    f.db.tasks.push({orbitcard_base_url:f.base,orbitcard_card_id:42,orbitcard_client_order_no:'client-x',gpt_api_order_id:'sub-x',status:'failed',orbitcard_state:'failed'});
    result=await f.sync.synchronize(f.cfg,f.cards);assert.equal(result.added,1);
    assert.equal(f.db.cards[0].successful_order_count,1);
});

test('duplicate platform pages fail before any counter changes',async()=>{
    const f=await syncFixture([proof('x'),proof('x')]);
    await assert.rejects(f.sync.synchronize(f.cfg,f.cards),/重复/);assert.equal(f.db.cards[0].successful_order_count,0);
});

test('platform proof requires matching original order and explicit result provenance',()=>{
    assert.equal(verifiedSuccess(proof('x'),{orderId:'sub-x',clientOrderNo:'client-x',cardId:42}),true);
    assert.equal(verifiedSuccess({...proof('x'),query_source:undefined},{orderId:'sub-x',clientOrderNo:'client-x',cardId:42}),false);
});

test('startup imports only verified platform evidence and ignores local success flags; repeated migration is idempotent',async()=>{
    const f=fixture();await f.addCard();
    const rows=[
        {cursor_id:1,base_url:f.base,card_id:42,client_order_no:'client-yes',order_no:'sub-yes',snapshot:JSON.stringify(proof('yes')),local_state:'failed'},
        {cursor_id:2,base_url:f.base,card_id:42,client_order_no:'client-no',order_no:'sub-no',snapshot:JSON.stringify({status:'success'}),local_state:'success'},
        {cursor_id:3,base_url:f.base,card_id:42,client_order_no:'client-error',snapshot:'invalid',local_state:'success'}
    ];
    const usage=require('../src/db/orbitcard-order-usage')({...f,runQuery:async(sql,p,options)=>{
        if(sql.includes('AS cursor_id')) {
            assert.ok(!sql.includes("state='success'"),'local outcome must not be a counting condition');
            return sql.includes('FROM task_logs t')?rows.filter(row=>row.cursor_id>p[0]):[];
        }
        return f.runQuery(sql,p,options);
    }});
    await usage.backfill();await usage.backfill();assert.equal(f.db.cards[0].successful_order_count,1);assert.equal(f.db.successfulOrders.length,1);
});

test('platform history followed by normal settlement counts the same original order once',async()=>{
    const f=fixture();await f.addCard();const task=await f.claim();await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    const snapshot={...proof('x'),task_no:`sub-${task.jobKey}`,client_order_no:task.orbitcardClientOrderNo};
    await f.store.cardMethods(f.base).recordSuccessfulOrder({cardId:42,clientOrderNo:snapshot.client_order_no,orderId:snapshot.task_no,snapshot});
    assert.equal(f.db.cards[0].active_job,task.jobKey,'history synchronization must not release an in-flight owner');
    await f.settle(task,'success');assert.equal(f.db.cards[0].successful_order_count,1);assert.equal(f.db.cards[0].active_job,null);
});
