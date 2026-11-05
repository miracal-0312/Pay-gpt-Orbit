'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const policy=require('../orbitcard-pool');
const fixture=require('./helpers/card-db.cjs');
function load(name,mocks) {
    const filename=path.resolve(__dirname,'..',name), real=createRequire(filename), module={exports:{}};
    new Function('require','module','exports',fs.readFileSync(filename,'utf8'))(id=>mocks[id]||real(id),module,module.exports);
    return module.exports;
}
const cfg={enabled:true,base_url:'https://orbitcard.test',api_key:'test',
    orbitcard_plan_prices:{plus:'20.00',pro100:'100.00',pro200:'200.00',pro500:'500.00'}};
const authorization=(id,card_id=42)=>({transaction_id:String(id),card_id,transaction_type:'Authorization',status:'approved',authorization_amount:'-15.54'});
const settlement=(id,card_id=42)=>({...authorization(id,card_id),transaction_type:'Settlement'});
async function setup(counts=[0,0,0,0,0],overrides={}) {
    const f=fixture(), calls=[], remote=[], ledger=new Map(); let clock=Date.now(), next=100;
    for(let i=0;i<counts.length;i++) {
        const card=await f.addCard(42+i,true,counts[i]); remote.push({...card,status:'ACTIVE'});
        ledger.set(card.card_id,Array.from({length:counts[i]},(_,j)=>authorization(j,card.card_id)));
    }
    const transport={request:async(config,operation,body={},key)=>{
        calls.push({operation,body,key});
        if(overrides[operation]) {const r=await overrides[operation](body,key,remote);if(r)return r;}
        if(operation==='getCardList')return {success:true,data:{list:remote,total:remote.length}};
        if(operation==='cardTransaction') {const rows=ledger.get(body.card_id)||[];return {success:true,data:{list:rows.slice((body.page-1)*body.page_size,body.page*body.page_size),total:rows.length}};}
        if(operation==='cardDetail')return {success:true,data:body.card_ids?{list:body.card_ids.map(id=>remote.find(c=>c.card_id===id))}:remote.find(c=>c.card_id===body.card_id)};
        if(operation==='getProductCode')return {success:true,data:{list:[{product_code:'p1',bin:'55565979',min_initial_amount:'20.00',min_retained_balance:'1.00',remaining_open_card_num:100}]}};
        if(operation==='getAccountBalance')return {success:true,data:{available_balance:'10000.00'}};
        if(operation==='createCard') {const card={card_id:next++,status:'ACTIVE',product_code:'p1',balance:'20.00',currency:'USD'};remote.push(card);return {success:true,status:200,data:{card_id:card.card_id,order_no:`open-${card.card_id}`,status:'success',completed:true}};}
        if(operation==='deleteCard') {remote.find(c=>c.card_id===body.card_id).status='DELETED';return {success:true,data:{card_id:body.card_id,status:'DELETED'}};}
        if(operation==='freezeCard') {remote.find(c=>c.card_id===body.card_id).status=body.status;return {success:true,data:{card_id:body.card_id,status:body.status}};}
        throw Error(operation);
    }};
    const cards=load('orbitcard-cards-client.js',{'./orbitcard-client':transport});
    const service=load('orbitcard-card-service.js',{'./orbitcard-client':transport,'./orbitcard-cards-client':cards})({store:f.store,audit(){},maxIssuePolls:1,now:()=>clock,sleep:async()=>{}});
    return {...f,service,calls,remote,ledger,advance(){clock+=120000;}};
}
test('only confirmed authorization counts below seven are eligible',()=>{
    assert.equal(policy.MAX_USES,7);
    assert.equal(policy.SIZE,5);
    assert.equal(policy.eligible({authorization_count:6}),true);
    for(const authorization_count of [7,8,null,undefined,-1,1.5,NaN,Infinity])
        assert.equal(policy.eligible({authorization_count}),false);
    assert.equal(policy.eligible({authorization_count:0,retirement_key:'pending'}),false);
    assert.equal(policy.eligible({authorization_count:6,authorization_pending_count:7}),false);
    assert.equal(policy.eligible({authorization_count:4,authorization_pending_count:4}),true);
});
test('seven successful authorizations delete once and replace to five; six authorizations remain usable',async()=>{
    const f=await setup([7,6,0,0,0]);await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
    assert.equal(f.db.cards.find(c=>c.card_id===43).authorization_count,6);
    await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
});

test('seven successful authorizations without amounts retire once and refill the five-card pool',async()=>{
    const f=await setup();
    const withoutAmount=id=>({transaction_id:`external-${id}`,card_id:42,transaction_type:'Authorization',status:'SUCCESS'});
    f.ledger.set(42,Array.from({length:6},(_,i)=>withoutAmount(i)));
    await f.service.synchronize(cfg);
    const oldCard=f.db.cards.find(card=>card.card_id===42);
    assert.equal(oldCard.authorization_count,6);
    assert.equal(oldCard.provider_status,'ACTIVE');
    assert.equal(policy.eligible(oldCard),true);
    assert.equal(f.calls.filter(c=>['deleteCard','createCard'].includes(c.operation)).length,0);
    f.ledger.get(42).push(withoutAmount(6));
    await f.service.synchronize(cfg);
    assert.equal(oldCard.authorization_count,7);
    assert.equal(oldCard.provider_status,'DELETED');
    assert.equal(policy.eligible(oldCard),false);
    assert.deepEqual(f.calls.filter(c=>['deleteCard','createCard'].includes(c.operation)).map(c=>c.operation),['deleteCard','createCard']);
    assert.deepEqual(f.calls.filter(c=>c.operation==='deleteCard').map(c=>c.body.card_id),[42]);
    assert.equal(f.remote.filter(card=>card.status!=='DELETED').length,5);
    assert.equal(f.db.cards.find(card=>card.card_id===100).authorization_count,0);
    await f.service.synchronize(cfg);
    assert.equal(oldCard.authorization_count,7);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
    assert.equal(f.remote.filter(card=>card.status!=='DELETED').length,5);
});

test('the seventh success waits for its authorization and is replaced only after the provider confirms seven',async()=>{
    const f=await setup([6,0,0,0,0]);
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    await Promise.all([f.settle(task,'success'),f.settle(task,'success')]);
    assert.equal(f.db.cards[0].authorization_count,6);
    assert.equal(f.db.cards[0].authorization_pending_count,7);
    const next=await f.claim('pro100');
    assert.equal(await f.store.cardMethods(f.base).reserveCard(42,next.jobKey,'pro100'),null);
    await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(call=>call.operation==='deleteCard').length,0);
    assert.equal(f.db.cards[0].authorization_count,6);
    f.ledger.get(42).push(authorization(6));
    await f.service.synchronize(cfg);
    assert.equal(f.db.cards[0].provider_status,'DELETED');
    assert.equal(f.db.cards.find(card=>card.card_id===100).authorization_count,0);
    assert.equal(f.remote.filter(card=>card.status!=='DELETED').length,5);
    await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(call=>call.operation==='deleteCard').length,1);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,1);
    assert.ok(f.calls.some(call=>call.operation==='cardTransaction'));
});
test('empty pool opens exactly five cards across concurrent synchronizations',async()=>{
    const f=await setup([]);await Promise.all([f.service.synchronize(cfg),f.service.synchronize(cfg)]);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,5);
    assert.equal(f.remote.length,5);
});
test('busy seventh-use card cannot be deleted or cause overfilling; released card is replaced',async()=>{
    const f=await setup([7,0,0,0,0]);f.db.cards[0].active_job='unresolved';
    await f.service.synchronize(cfg);assert.equal(f.calls.filter(c=>['deleteCard','createCard'].includes(c.operation)).length,0);
    f.db.cards[0].active_job=null;await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
});
test('delete timeout uses readonly recovery and permits replacement only after confirmed deletion',async()=>{
    const f=await setup([7,0,0,0,0],{deleteCard:async()=>({success:false})});
    await assert.rejects(f.service.synchronize(cfg));const key=f.db.cards[0].retirement_key;
    assert.ok(key);assert.equal(policy.eligible(f.db.cards[0]),false);
    assert.equal(f.db.cards[0].retirement_state,'unknown');
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    const before=f.calls.length;
    await assert.rejects(f.service.synchronize(cfg),/删除仍未确认/);
    assert.ok(f.calls.slice(before).some(c=>c.operation==='cardDetail'&&c.body.card_id===42));
    assert.deepEqual(f.calls.filter(c=>c.operation==='deleteCard').map(c=>c.key),[key]);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    f.remote[0].status='DELETED';await f.service.synchronize(cfg);
    assert.equal(f.db.cards[0].retirement_state,'confirmed');
    assert.deepEqual(f.calls.filter(c=>c.operation==='deleteCard').map(c=>c.key),[key]);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
});
test('unknown opening resumes same body and key without opening extra cards',async()=>{
    let fail=true;const f=await setup([0,0,0,0],{createCard:async()=>fail?{success:false,status:502}:null});
    await assert.rejects(f.service.synchronize(cfg));assert.equal(f.db.issues.length,1);
    fail=false;f.advance();await f.service.synchronize(cfg);
    const calls=f.calls.filter(c=>c.operation==='createCard');assert.equal(calls.length,2);
    assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);assert.equal(f.remote.length,5);
});

test('confirmed deletion recovers before an expired transaction endpoint can block replacement',async()=>{
    let deleted=false;
    const f=await setup([7,0,0,0,0],{
        deleteCard:async()=>{deleted=true;return {success:false};},
        cardDetail:async body=>deleted&&body.card_id===42
            ?{success:true,data:{card_id:42,status:'DELETED',product_code:'p1',currency:'USD'}}:null,
        cardTransaction:async body=>deleted&&body.card_id===42?{success:false,status:404}:null
    });
    await assert.rejects(f.service.synchronize(cfg));
    assert.equal(f.db.cards[0].retirement_state,'unknown');
    // getCardList still contains this card; only cardDetail reveals its deletion.
    const before=f.calls.length;
    await f.service.synchronize(cfg);
    assert.equal(f.db.cards[0].retirement_state,'confirmed');
    assert.ok(!f.calls.slice(before).some(c=>c.operation==='cardTransaction'&&c.body.card_id===42));
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
    assert.equal(f.db.cards.filter(c=>c.provider_status!=='DELETED').length,5);
});
test('changed credential cannot resume an existing retirement',async()=>{
    const f=await setup([7,0,0,0,0],{deleteCard:async()=>({success:false})});
    await assert.rejects(f.service.synchronize(cfg));
    const before=f.calls.filter(c=>c.operation==='deleteCard').length;
    await assert.rejects(f.service.synchronize({...cfg,api_key:'different'}),/API Key/);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,before);
});
test('missing card after unknown delete requires confirmed DELETED detail before replacement',async()=>{
    let hidden=false;
    const f=await setup([7,0,0,0,0],{
        deleteCard:async()=>{hidden=true;return {success:false};},
        getCardList:async(body,key,remote)=>hidden?{success:true,data:{list:remote.slice(1),total:remote.length-1}}:null
    });
    await assert.rejects(f.service.synchronize(cfg));
    await assert.rejects(f.service.synchronize(cfg),/删除仍未确认/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    f.remote[0].status='DELETED';await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
});
test('transaction API failures stop all lifecycle writes without erasing confirmed counts',async()=>{
    const f=await setup([7,0,0,0,0],{cardTransaction:async()=>{throw Error('transactions unavailable');}});
    await assert.rejects(f.service.synchronize(cfg));
    assert.equal(f.db.cards[0].authorization_count,7);
    assert.equal(f.calls.filter(c=>c.operation==='cardTransaction').length,1);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
});
test('unknown authorization status prevents lifecycle writes and never assumes zero',async()=>{
    const f=await setup([0,0,0,0]);f.db.cards[0].authorization_count=null;
    f.ledger.set(42,[{...authorization(1),status:17}]);
    await assert.rejects(f.service.synchronize(cfg),/未知消费授权状态/);
    assert.equal(f.db.cards[0].authorization_count,null);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('viewing transactions imports external successful authorizations without double counting their settlement',async()=>{
    const f=await setup([0]);
    f.ledger.set(42,[authorization(1),settlement(1)]);
    const result=await f.service.transactions(cfg,42);
    assert.equal(result.authorization_count,1);assert.equal(result.authorization_limit,7);
    assert.equal(result.transactions.length,2);assert.equal(f.db.cards[0].authorization_count,1);
    await f.service.transactions(cfg,42);
    assert.equal(f.db.cards[0].authorization_count,1);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('disabled configuration imports authorization counts without opening or deleting',async()=>{
    const f=await setup([7]);await f.service.synchronize({...cfg,enabled:false});
    assert.equal(f.db.cards[0].authorization_count,7);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('surplus pool directly deletes its most-used idle frozen card without unfreezing it',async()=>{
    const f=await setup([6,1,0,0,0,0]);f.remote[0].status='CANCELLED';await f.service.synchronize(cfg);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
    assert.deepEqual(f.calls.filter(c=>['freezeCard','deleteCard'].includes(c.operation)).map(c=>c.operation),['deleteCard']);
});
test('allocation refreshes authorizations and ignores obsolete activation counters',async()=>{
    const f=await setup([6,0,0,0,0]);f.db.cards[0].activation_count=99;
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.db.cards[0].authorization_count,6);assert.equal(f.db.cards[0].active_job,task.jobKey);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.ok(f.calls.some(call=>call.operation==='cardTransaction'));
});

test('settled authorizations remain counted and later distinct authorizations still increase the total',async()=>{
    const f=await setup([0]);f.ledger.set(42,[authorization('A')]);
    await f.service.transactions(cfg,42);assert.equal(f.db.cards[0].authorization_count,1);
    f.ledger.set(42,[settlement('A'),authorization('B')]);
    await f.service.transactions(cfg,42);assert.equal(f.db.cards[0].authorization_count,2);
    f.ledger.set(42,[settlement('A'),settlement('B')]);
    await f.service.transactions(cfg,42);assert.equal(f.db.cards[0].authorization_count,2);
});
