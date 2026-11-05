'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./helpers/card-db.cjs');
const createRetirement = require('../orbitcard-retirement');
const {positiveId} = require('../orbitcard-cards-client');
const cfg = {api_key:'retirement-test',base_url:'https://orbitcard.test'};
const existingKey = () => `retire-${crypto.createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-saved`;

async function setup({status='ACTIVE',request,detail}={}) {
    const f=fixture(), card=await f.addCard(42,true,7), calls=[];
    card.provider_status=status;
    await f.store.cardMethods(f.base).syncCards([card]);
    const locked=f.store.cardMethods(f.base);
    const retire=createRetirement({
        api:{request:async(config,operation,body,key)=>{
            calls.push({operation,body,key});
            // The durable unknown state must precede any outbound write.
            assert.equal(f.db.cards[0].retirement_state,'unknown');
            return request ? request(body,key) : {success:true,data:{card_id:42,status:'DELETED'}};
        }},
        cardsApi:{positiveId,cardDetail:async(config,id)=>{
            calls.push({operation:'cardDetail',body:{card_id:id}});
            return detail ? detail(id) : {...card,provider_status:'DELETED'};
        }}
    });
    return {...f,card,calls,locked,retire,run:(options)=>retire(cfg,locked,card,f.db.cards[0],options)};
}

test('ACTIVE and CANCELLED cards are deleted directly and confirmed without freeze or refund',async()=>{
    for (const status of ['ACTIVE','CANCELLED']) {
        const f=await setup({status});
        const deleted=await f.run();
        assert.deepEqual(f.calls.map(c=>c.operation),['deleteCard']);
        assert.equal(deleted.provider_status,'DELETED');
        assert.equal(f.db.cards[0].provider_status,'DELETED');
        assert.equal(f.db.cards[0].retirement_state,'confirmed');
        assert.equal(f.db.cards[0].authorization_count,7);
        assert.equal(f.db.cards[0].balance,100); // Not evidence of a refund.
    }
});

test('a timed-out deletion preserves its key and only uses cardDetail on every recovery',async()=>{
    let deleted=false;
    const f=await setup({request:()=>{throw Error('timeout');},detail:()=>({...f.card,provider_status:deleted?'DELETED':'ACTIVE'})});
    await assert.rejects(f.run(),/删除结果未知/);
    const key=f.db.cards[0].retirement_key;
    assert.ok(key);assert.equal(f.db.cards[0].retirement_state,'unknown');
    await assert.rejects(f.run(),/删除仍未确认/);
    assert.equal(f.db.cards[0].retirement_key,key);
    assert.equal(f.db.cards[0].provider_status,'ACTIVE');
    deleted=true;await f.run();
    assert.deepEqual(f.calls.map(c=>c.operation),['deleteCard','cardDetail','cardDetail']);
    assert.equal(f.db.cards[0].retirement_key,key);
    assert.equal(f.db.cards[0].retirement_state,'confirmed');
});

test('refund audit evidence comes only from a confirmed delete response and never from the balance',async()=>{
    const f=await setup({request:()=>({success:true,data:{card_id:42,status:'DELETED',refunded_amount:'4.44000000'}})});
    const deleted=await f.run();
    assert.equal(deleted.refunded_amount,'4.44000000');
    assert.equal(deleted.balance,100);
    for(const refunded_amount of [undefined,4.44,'-4.44','invalid']) {
        const invalid=await setup({request:()=>({success:true,data:{card_id:42,status:'DELETED',refunded_amount}})});
        assert.equal((await invalid.run()).refunded_amount,undefined);
    }
});

test('legacy retirement keys and a crash after marking submitted never resend deleteCard',async()=>{
    for(const state of [null,'unknown']) {
        const f=await setup();
        Object.assign(f.db.cards[0],{retirement_key:existingKey(),retirement_state:state});
        await f.run();
        assert.deepEqual(f.calls.map(c=>c.operation),['cardDetail']);
        assert.equal(f.db.cards[0].retirement_key,existingKey());
        assert.equal(f.db.cards[0].retirement_state,'confirmed');
    }
});

test('a prepared intent can submit once after restart; its atomic claim cannot be repeated',async()=>{
    const f=await setup();
    const first=await f.locked.retireCard(42,existingKey());
    assert.equal(first.retirement_state,'prepared');
    await f.run();
    assert.deepEqual(f.calls.map(c=>c.operation),['deleteCard']);
    assert.equal(f.calls[0].key,existingKey());
    assert.equal(await f.locked.markRetirementSubmitted(42,existingKey()),false);
});

test('a crash before the first outbound POST remains uncertain and uses read-only recovery',async()=>{
    const f=await setup({detail:()=>({...f.card,provider_status:'ACTIVE'})});
    await f.locked.retireCard(42,existingKey());
    assert.equal(await f.locked.markRetirementSubmitted(42,existingKey()),true);
    assert.equal(await f.locked.markRetirementSubmitted(42,existingKey()),false);
    await assert.rejects(f.run(),/删除仍未确认/);
    assert.deepEqual(f.calls.map(c=>c.operation),['cardDetail']);
    assert.equal(f.db.cards[0].retirement_state,'unknown');
});

test('even a prepared intent missing from getCardList needs a DELETED detail and sends no POST',async()=>{
    const f=await setup({detail:()=>({...f.card,provider_status:'ACTIVE'})});
    await f.locked.retireCard(42,existingKey());
    await assert.rejects(f.run({listed:false}),/删除仍未确认/);
    assert.deepEqual(f.calls.map(c=>c.operation),['cardDetail']);
    assert.equal(f.db.cards[0].retirement_state,'prepared');
});

test('changed credentials, occupied cards, and mismatched card IDs cannot trigger deletion',async()=>{
    const f=await setup();
    await f.locked.retireCard(42,existingKey());
    await assert.rejects(f.retire({...cfg,api_key:'changed'},f.locked,f.card,f.db.cards[0]),/API Key/);
    f.db.cards[0].active_job='pending-payment';
    await assert.rejects(f.run(),/任务占用/);
    f.db.cards[0].active_job=null;
    await assert.rejects(f.retire(cfg,f.locked,{...f.card,card_id:43},f.db.cards[0]),/ID 不一致/);
    assert.equal(f.calls.length,0);
});

test('malformed or rejected delete responses cannot be confirmed or replayed',async()=>{
    for (const result of [null,{success:false},{success:true,data:{}},
        {success:true,data:{card_id:99,status:'DELETED'}},
        {success:true,data:{card_id:42,status:'ACTIVE'}}]) {
        const f=await setup({request:()=>result});
        await assert.rejects(f.run(),/删除仍未确认/);
        assert.equal(f.db.cards[0].retirement_state,'unknown');
        assert.equal(f.db.cards[0].provider_status,'ACTIVE');
        await f.run();
        assert.deepEqual(f.calls.map(c=>c.operation),['deleteCard','cardDetail']);
    }
});

test('read-only recovery rejects mismatched details and survives network failures without new writes',async()=>{
    const f=await setup({detail:()=>{throw Error('network failure');}});
    Object.assign(f.db.cards[0],{retirement_key:existingKey(),retirement_state:'unknown'});
    await assert.rejects(f.run(),/查询失败/);
    assert.equal(f.db.cards[0].retirement_state,'unknown');
    assert.deepEqual(f.calls.map(c=>c.operation),['cardDetail']);
    const wrong=await setup({detail:()=>({card_id:43,provider_status:'DELETED'})});
    Object.assign(wrong.db.cards[0],{retirement_key:existingKey(),retirement_state:'unknown'});
    await assert.rejects(wrong.run(),/删除仍未确认/);
    assert.equal(wrong.db.cards[0].provider_status,'ACTIVE');
});

test('a DB failure after successful delete is recovered read-only using the saved intent',async()=>{
    const f=await setup();
    const confirm=f.locked.confirmRetirement;
    f.locked.confirmRetirement=async()=>{throw Error('database unavailable');};
    await assert.rejects(f.run(),/database unavailable/);
    assert.equal(f.db.cards[0].retirement_state,'unknown');
    f.locked.confirmRetirement=confirm;
    await f.run();
    assert.deepEqual(f.calls.map(c=>c.operation),['deleteCard','cardDetail']);
    assert.equal(f.db.cards[0].retirement_state,'confirmed');
});
