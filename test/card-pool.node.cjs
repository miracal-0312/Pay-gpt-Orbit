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
const cfg={enabled:true,base_url:'https://orbitcard.test',api_key:'test'};
const settlement=(id,card_id=42)=>({transaction_id:String(id),card_id,transaction_type:'Settlement',status:'success'});
async function setup(counts=[0,0,0,0,0],overrides={}) {
    const f=fixture(), calls=[], remote=[], ledger=new Map(); let clock=Date.now(), next=100;
    for(let i=0;i<counts.length;i++) {
        const card=await f.addCard(42+i); remote.push({...card,status:'ACTIVE'});
        ledger.set(card.card_id,Array.from({length:counts[i]},(_,j)=>settlement(j,card.card_id)));
    }
    const transport={request:async(config,operation,body={},key)=>{
        calls.push({operation,body,key});
        if(overrides[operation]) {const r=await overrides[operation](body,key,remote);if(r)return r;}
        if(operation==='getCardList')return {success:true,data:{list:remote,total:remote.length}};
        if(operation==='cardTransaction') {const rows=ledger.get(body.card_id)||[];return {success:true,data:{list:rows.slice((body.page-1)*body.page_size,body.page*body.page_size),total:rows.length}};}
        if(operation==='cardDetail')return {success:true,data:body.card_ids?{list:body.card_ids.map(id=>remote.find(c=>c.card_id===id))}:remote.find(c=>c.card_id===body.card_id)};
        if(operation==='getProductCode')return {success:true,data:[{product_code:'p1',bin:'55565979',min_initial_amount:20,min_retained_balance:1,remaining_open_card_num:100,gpt_plan_prices:[{id:'plus',price:20,currency:'USD'}]}]};
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
test('counts complete paginated successful settlements without authorization/refund double counting',async()=>{
    const rows=Array.from({length:102},(_,i)=>settlement(i));
    rows.push({...settlement('a'),transaction_type:'Authorization'}, {...settlement('r'),transaction_type:'Refund'}, {...settlement('f'),status:'failed'});
    const calls=[];
    const count=await policy.countTransactions({request:async(c,o,b)=>{calls.push(b.page);return {success:true,data:{list:rows.slice((b.page-1)*100,b.page*100),total:rows.length}};}},cfg,42);
    assert.equal(count,102);assert.deepEqual(calls,[1,2]);
    assert.equal(policy.eligible({transaction_count:5}),true);
    assert.equal(policy.eligible({transaction_count:6}),false);
    assert.equal(policy.eligible({transaction_count:null}),false);
    assert.equal(policy.eligible({transaction_count:0,retirement_key:'pending'}),false);
});
test('malformed, foreign, unknown and incomplete transaction pages fail closed',async()=>{
    for(const data of [{list:[settlement(1,99)],total:1},{list:[{...settlement(1),status:'mystery'}],total:1},{list:[settlement(1),settlement(1)],total:2},{list:[],total:1},{list:[settlement(1)],total:'bad'}])
        await assert.rejects(policy.countTransactions({request:async()=>({success:true,data})},cfg,42));
});
test('six successful settlements delete once and replace to five; five settlements remain usable',async()=>{
    const f=await setup([6,5,0,0,0]);await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
    assert.equal(f.db.cards.find(c=>c.card_id===43).transaction_count,5);
    await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
});
test('empty pool opens exactly five cards across concurrent synchronizations',async()=>{
    const f=await setup([]);await Promise.all([f.service.synchronize(cfg),f.service.synchronize(cfg)]);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,5);
    assert.equal(f.remote.length,5);
});
test('busy sixth-use card cannot be deleted or cause overfilling; released card is replaced',async()=>{
    const f=await setup([6,0,0,0,0]);f.db.cards[0].active_job='unresolved';
    await f.service.synchronize(cfg);assert.equal(f.calls.filter(c=>['deleteCard','createCard'].includes(c.operation)).length,0);
    f.db.cards[0].active_job=null;await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
});
test('delete timeout retains retirement key, excludes allocation and cannot trigger replacement',async()=>{
    let fail=true;const f=await setup([6,0,0,0,0],{deleteCard:async()=>fail?{success:false}:null});
    await assert.rejects(f.service.synchronize(cfg));const key=f.db.cards[0].retirement_key;
    assert.ok(key);assert.equal(policy.eligible(f.db.cards[0]),false);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    fail=false;await f.service.synchronize(cfg);
    assert.deepEqual(f.calls.filter(c=>c.operation==='deleteCard').map(c=>c.key),[key,key]);
});
test('unknown opening resumes same body and key without opening extra cards',async()=>{
    let fail=true;const f=await setup([0,0,0,0],{createCard:async()=>fail?{success:false,status:502}:null});
    await assert.rejects(f.service.synchronize(cfg));assert.equal(f.db.issues.length,1);
    fail=false;f.advance();await f.service.synchronize(cfg);
    const calls=f.calls.filter(c=>c.operation==='createCard');assert.equal(calls.length,2);
    assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);assert.equal(f.remote.length,5);
});
test('changed credential cannot resume an existing retirement',async()=>{
    const f=await setup([6,0,0,0,0],{deleteCard:async()=>({success:false})});
    await assert.rejects(f.service.synchronize(cfg));
    const before=f.calls.filter(c=>c.operation==='deleteCard').length;
    await assert.rejects(f.service.synchronize({...cfg,api_key:'different'}),/API Key/);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,before);
});
test('missing card after unknown delete requires confirmed DELETED detail before replacement',async()=>{
    let hidden=false;
    const f=await setup([6,0,0,0,0],{
        deleteCard:async()=>{hidden=true;return {success:false};},
        getCardList:async(body,key,remote)=>hidden?{success:true,data:{list:remote.slice(1),total:remote.length-1}}:null
    });
    await assert.rejects(f.service.synchronize(cfg));
    await assert.rejects(f.service.synchronize(cfg),/删除仍未确认/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    f.remote[0].status='DELETED';await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
});
test('transaction read failure prevents all lifecycle writes and does not overwrite count',async()=>{
    const f=await setup([6,0,0,0],{cardTransaction:async b=>b.card_id===43?{success:false}:null});
    f.db.cards[0].transaction_count=3;
    await assert.rejects(f.service.synchronize(cfg));assert.equal(f.db.cards[0].transaction_count,3);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('disabled configuration only refreshes counts and never opens or deletes',async()=>{
    const f=await setup([6]);await f.service.synchronize({...cfg,enabled:false});
    assert.equal(f.db.cards[0].transaction_count,6);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('surplus pool trims idle most-used cards to five and frozen retirement unfreezes first',async()=>{
    const f=await setup([5,1,0,0,0,0]);f.remote[0].status='CANCELLED';await f.service.synchronize(cfg);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
    assert.deepEqual(f.calls.filter(c=>['freezeCard','deleteCard'].includes(c.operation)).map(c=>c.operation),['freezeCard','deleteCard']);
});
test('allocation ignores obsolete local plan counters and refreshes provider count before reserving',async()=>{
    const f=await setup([5,0,0,0,0]);f.db.cards[0].successful_plus=99;
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.db.cards[0].transaction_count,5);assert.equal(f.db.cards[0].active_job,task.jobKey);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
});
