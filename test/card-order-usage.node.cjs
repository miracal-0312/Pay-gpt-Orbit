'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/card-db.cjs');
const createOrderUsage = require('../src/db/orbitcard-order-usage');
const { verifiedSuccess } = createOrderUsage;
const proof = (id, cardId = 42) => ({ task_no: `sub-${id}`, client_order_no: `client-${id}`, card_id: cardId,
    status: 'succeeded', subscription_succeeded: true, query_source: 'upstream' });
const entry = (id, cardId = 42) => ({ clientOrderNo: `client-${id}`, orderId: `sub-${id}`, cardId, snapshot: proof(id, cardId) });
const record = (f, order) => f.withTransaction(connection => createOrderUsage(f).recordSuccess({ ...order, scope: f.scope }, { connection }));

test('concurrent repeated platform success increments once and persists across a new store reader', async () => {
    const f = fixture(); await f.addCard();
    const results = await Promise.all(Array.from({length:20}, () => record(f, entry('one'))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.db.cards[0].successful_order_count, 1);
    assert.equal(f.db.successfulOrders.length, 1);
    assert.equal(f.db.cards[0].authorization_count, 0);
});

test('local flags, missing evidence, failed/pending and unverified snapshots never count', async () => {
    const f = fixture(); await f.addCard();
    for (const snapshot of [undefined, {status:'success'}, {...proof('x'),query_source:undefined},
        {...proof('x'),query_source:'snapshot'}, {...proof('x'),status:'failed'},
        {...proof('x'),upstream_status:'pending'}, {...proof('x'),request_error:{code:'timeout'}},
        {...proof('x'),client_order_no:'foreign'}, {...proof('x'),card_id:99}]) {
        assert.equal(await record(f, {...entry('x'),snapshot}),false);
    }
    assert.equal(f.db.cards[0].successful_order_count,0);
    const task=await f.claim();await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    await f.store.settleOrbitcardTask(task.jobKey,{status:'success',orbitcardState:'success',message:'manually marked',progress:100});
    assert.equal(f.db.cards[0].successful_order_count,0);
});

test('verified terminal platform snapshots count, conflicting identities cannot credit another card',async()=>{
    const f=fixture();await f.addCard();await f.addCard(43);
    const first=entry('one');first.snapshot={...first.snapshot,query_source:'snapshot',result_source:'upstream',upstream_status:'succeeded'};
    await record(f, first);
    await assert.rejects(record(f, entry('one',43)),/已关联/);
    const other={...entry('two',43),orderId:'sub-one',snapshot:{...proof('two',43),task_no:'sub-one'}};
    await assert.rejects(record(f, other),/已关联/);
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
    assert.equal(f.db.cards[0].successful_order_count,2);assert.equal(f.db.successfulOrders.length,0);
    assert.ok(!f.db.cards[0].disabled_at);
    f.db.failRelease=false;await f.settle(task,'success');assert.equal(f.db.cards[0].successful_order_count,3);
    assert.equal(f.db.cards[0].disabled_code,'success_limit_reached');
});

test('platform proof requires matching original order and explicit result provenance',()=>{
    assert.equal(verifiedSuccess(proof('x'),{orderId:'sub-x',clientOrderNo:'client-x',cardId:42}),true);
    assert.equal(verifiedSuccess({...proof('x'),query_source:undefined},{orderId:'sub-x',clientOrderNo:'client-x',cardId:42}),false);
});

test('an existing ledger entry is not counted twice when the original order settles',async()=>{
    const f=fixture();await f.addCard();const task=await f.claim();await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    const snapshot={...proof('x'),task_no:`sub-${task.jobKey}`,client_order_no:task.orbitcardClientOrderNo};
    await record(f, {cardId:42,clientOrderNo:snapshot.client_order_no,orderId:snapshot.task_no,snapshot});
    assert.equal(f.db.cards[0].active_job,task.jobKey);
    await f.settle(task,'success');assert.equal(f.db.cards[0].successful_order_count,1);assert.equal(f.db.cards[0].active_job,null);
});
