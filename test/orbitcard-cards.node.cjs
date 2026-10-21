'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const fixture=require('./helpers/card-db.cjs');
function load(name,mocks) {
    const filename=path.resolve(__dirname,'..',name), real=createRequire(filename), module={exports:{}};
    new Function('require','module','exports',fs.readFileSync(filename,'utf8'))(id => Object.hasOwn(mocks,id)?mocks[id]:real(id),module,module.exports); return module.exports;
}
const product={product_code:'p1',bin:'55565979',min_initial_amount:20,min_retained_balance:1,remaining_open_card_num:100,
    gpt_plan_prices:[{id:'plus',price:20,currency:'USD'},{id:'pro100',price:100,currency:'USD'},{id:'pro200',price:200,currency:'USD'},{id:'pro500',price:500,currency:'USD'}]};
const cfg={enabled:true,base_url:'https://orbitcard.test',api_key:'fixture',orbitcard_safety_margin:'1'};

test('Plus card is serialized and exactly four successes exhaust it',async () => {
    const f=fixture(); await f.addCard(); const m=f.store.cardMethods(f.base);
    for (let n=0;n<4;n++) {
        const first=await f.claim(),second=await f.claim();
        const results=await Promise.all([m.reserveCard(42,first.jobKey,'plus'),m.reserveCard(42,second.jobKey,'plus')]);
        assert.equal(results.filter(Boolean).length,1);
        await f.settle(first,'success'); await f.settle(first,'success');
        assert.equal(f.db.cards[0].successful_plus,n+1);
        await f.settle(second,'rejected');
    }
    const next=await f.claim(); assert.equal(await m.reserveCard(42,next.jobKey,'plus'),null);
    assert.equal(f.db.uses.filter(u => u.state==='consumed').length,4);
});

test('one card accepts four Plus and one of each Pro, with separate limits and mixed order',async () => {
    const f=fixture(); await f.addCard(); const m=f.store.cardMethods(f.base);
    for(const plan of ['plus','pro100','plus','pro200','plus','pro500','plus']) {
        const task=await f.claim(plan); assert.ok(await m.reserveCard(42,task.jobKey,plan)); await f.settle(task,'success');
    }
    for(const plan of ['plus','pro100','pro200','pro500']) {
        const task=await f.claim(plan); assert.equal(await m.reserveCard(42,task.jobKey,plan),null);
    }
    assert.equal(f.db.uses.filter(row => row.state==='consumed').length,7);
});

test('manual and pending hold a card; confirmed failure releases without counting',async () => {
    const f=fixture(); await f.addCard(); const task=await f.claim(),m=f.store.cardMethods(f.base); await m.reserveCard(42,task.jobKey,'plus');
    for (const state of ['submitting','pending','manual']) { await f.settle(task,state); assert.equal(f.db.cards[0].active_job,task.jobKey); }
    await f.settle(task,'failed'); assert.equal(f.db.cards[0].successful_plus,0); assert.equal(f.db.cards[0].active_job,null);
    const next=await f.claim(); assert.ok(await m.reserveCard(42,next.jobKey,'plus'));
});

test('CDK, task, quota and card release all roll back if quota settlement fails',async () => {
    const f=fixture(); await f.addCard(); const task=await f.claim(); await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    f.db.failIncrement=true; await assert.rejects(f.settle(task,'success'),/injected/);
    assert.equal(f.db.tasks[0].orbitcard_state,'prepared'); assert.equal(f.db.uses[0].state,'reserved'); assert.equal(f.db.cards[0].successful_plus,0); assert.ok(f.db.cdks[0].used_at);
    f.db.failIncrement=false; await f.settle(task,'success'); await f.settle(task,'failed');
    assert.equal(f.db.cards[0].successful_plus,1); assert.equal(f.db.tasks[0].status,'success');
});

test('sync does not reset history or active reservations; imports require one-time binding',async () => {
    const f=fixture(); const card=await f.addCard(42,false); const m=f.store.cardMethods(f.base);
    const task=await f.claim(); assert.equal(await m.reserveCard(42,task.jobKey,'plus'),null);
    const counts={plus:2,pro100:1,pro200:0,pro500:0};
    await assert.rejects(m.bindCard(42,counts),/旧充值订单/); await f.settle(task,'rejected');
    await m.bindCard(42,counts); await m.syncCards([{...card,balance:90}]); assert.equal(f.db.cards[0].successful_plus,2);
    await assert.rejects(m.bindCard(42,counts),/已确认/);
    const next=await f.claim(); await m.reserveCard(42,next.jobKey,'plus'); await m.syncCards([card]); assert.equal(f.db.cards[0].active_job,next.jobKey);
});

function serviceFixture(overrides={}) {
    const f=fixture(), calls=[],events=[]; let providerCards=[],clock=Date.now(),accountBalance=10000;
    const transport={request:async (config,operation,body={},key='') => {
        calls.push({operation,body,key});
        if (overrides[operation]) return {status:200,...await overrides[operation](body,key,config)};
        if(operation==='getAccountBalance') return {success:true,status:200,data:{available_balance:accountBalance.toFixed(8)}};
        if (operation==='getCardList') return {success:true,data:{list:providerCards,total:providerCards.length}};
        if (operation==='getProductCode') return {success:true,data:[product]};
        if (operation==='cardDetail') return {success:true,data:body.card_ids?{list:body.card_ids.map(id=>providerCards.find(c=>c.card_id===id))}:providerCards.find(c => c.card_id===body.card_id)};
        if (operation==='createCard') {
            const id=100+providerCards.length; providerCards.push({card_id:id,status:'ACTIVE',product_code:'p1',available_balance:Number(body.amount),currency:'USD',last4:'9876',bin:'55565979'});
            accountBalance-=Number(body.amount);
            return {success:true,status:200,data:{card_id:id,order_no:`OPEN-${id}`,status:'success',completed:true}};
        }
        if(operation==='rechargeCard') {
            const card=providerCards.find(c => c.card_id===body.card_id),balance=Number(card.available_balance ?? card.balance);
            card.available_balance=balance+Number(body.amount);accountBalance-=Number(body.amount);
            return {success:true,status:200,data:{order_no:`FUND-${body.card_id}`,amount:body.amount,status:'success',fee_amount:'0.00',total_debit_amount:body.amount}};
        }
        throw new Error(`Unexpected operation ${operation}`);
    }};
    const api=load('orbitcard-cards-client.js',{'./orbitcard-client':transport});
    const make=load('orbitcard-card-service.js',{'./orbitcard-client':transport,'./orbitcard-cards-client':api});
    const service=make({store:f.store,audit:event => events.push(event),sleep:async ms => {clock+=ms;},now:() => clock,maxIssuePolls:1});
    return {...f,calls,events,api,service,advance:(ms=60000) => {clock+=ms;},setCards:cards => {providerCards=cards;},setAccount:balance => {accountBalance=balance;}};
}

test('live inactive status overrides cached ACTIVE and the next active card is selected',async () => {
    const f=serviceFixture(),a=await f.addCard(42),b=await f.addCard(43);
    f.setCards([{...a,status:'FROZEN'},{...b,status:'ACTIVE'}]);const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),43);
    assert.equal(f.db.cards.find(c => c.card_id===42).active_job,null);
    assert.ok(f.events.some(e => e.event==='card_unavailable' && e.data.card_id===42));
    assert.equal(f.db.issues.length,0);assert.equal(f.db.fundings.length,0);
});

test('a previously managed card missing from the live list is skipped and a new card is opened',async () => {
    const f=serviceFixture();await f.addCard(42);f.setCards([]);const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),100);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,1);
    assert.equal(f.calls.filter(call=>call.operation==='rechargeCard').length,1);
    assert.ok(f.events.some(event=>event.event==='card_unavailable'&&event.data.reason==='missing_from_platform_list'));
});

test('a pending opening owned by another order is never adopted as this payment card',async () => {
    const f=serviceFixture();f.setCards([]);const task=await f.claim();
    f.db.issues.push({issue_key:'card-other',scope:require('../orbitcard-card-policy').cardScope(cfg.base_url),
        job_key:'another-order',plan_type:'plus',state:'pending'});
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/另一笔开卡申请/);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,0);
});

test('an already reserved card missing from the live list cannot trigger a second opening',async () => {
    const f=serviceFixture();await f.addCard(42);const task=await f.claim();
    await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    f.setCards([]);
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/预占卡片/);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,0);
});

test('documented product response automatically supplies the exact createCard fields without membership prices',async () => {
    const documented={product_code:'p1',bin:'55565979',card_type:'PREPAID',network:'MASTERCARD',media:'VIRTUAL',issuing_area:'US',
        remaining_open_card_num:9,open_card_inventory_mode:'local',min_initial_amount:'20.00000000',min_retained_balance:'1.00000000'};
    const f=serviceFixture({getProductCode:async body => {assert.deepEqual(body,{});return {success:true,data:{list:[documented]}};}});
    assert.equal((await f.service.apply(cfg,'pro500')).card_id,100);
    const create=f.calls.find(c=>c.operation==='createCard');assert.deepEqual(create.body,{product_code:'p1',amount:'20.00',quantity:1});
    assert.equal(f.db.issues[0].request_body,JSON.stringify(create.body));assert.equal(f.db.issues[0].issue_key,create.key);
    assert.equal(f.calls[0].operation,'getAccountBalance');assert.equal(f.db.fundings.length,0);
    const event=f.events.find(e=>e.event==='card_issue_prepared');assert.deepEqual(event.data.parameters,create.body);
    const normalized=f.api.normalizeProducts({list:[documented]})[0];assert.equal(normalized.network,'MASTERCARD');
});

test('product limits must be valid decimal amounts and inventory is known before opening',() => {
    const f=serviceFixture();
    for(const bad of [{min_initial_amount:''},{min_retained_balance:true},{remaining_open_card_num:undefined},{remaining_open_card_num:'0.5'},{product_code:'bad\ncode'}]) {
        const rows=f.api.normalizeProducts({list:[{...product,...bad}]});assert.throws(()=>f.api.chooseOpeningProduct(rows,cfg));
    }
    assert.throws(()=>f.api.createCardBody({product_code:'p1',amount:'25.00'}));
    assert.deepEqual(f.api.createCardBody({product_code:'p1',amount:'20.00',cvv:'ignored',plan_type:'plus'}),{product_code:'p1',amount:'20.00',quantity:1});
});

test('a configured product is never silently replaced and pending orders do not acquire new parameters',async () => {
    const f=serviceFixture(),rows=f.api.normalizeProducts({list:[product]});assert.throws(()=>f.api.chooseOpeningProduct(rows,{...cfg,orbitcard_product_code:'missing'}));
    assert.throws(()=>f.api.chooseOpeningProduct(rows,{...cfg,orbitcard_max_initial_amount:'19'}),/首充/);
    const pending=serviceFixture({createCard:async () => ({success:true,data:{order_no:'OPEN-PENDING',status:'pending_confirm',completed:false}})});
    await assert.rejects(pending.service.apply(cfg,'plus'));const original=pending.calls.find(c=>c.operation==='createCard');
    const catalogCount=pending.calls.filter(c=>c.operation==='getProductCode').length;pending.advance();
    await assert.rejects(pending.service.apply({...cfg,orbitcard_product_code:'different'},'plus'));
    const retry=pending.calls.filter(c=>c.operation==='createCard').at(-1);assert.equal(retry.key,original.key);assert.deepEqual(retry.body,original.body);
    assert.equal(pending.calls.filter(c=>c.operation==='getProductCode').length,catalogCount);
});

test('admin product query previews generated opening fields without writing an order or exposing credentials',async t => {
    const express=require('express'),{once}=require('node:events'),app=express(),f=serviceFixture();
    const register=load('orbitcard-card-http.js',{'./orbitcard-cards-client':f.api});
    register(app,{store:{getGptApiConfig:async()=>cfg},cardService:{},requireSecondaryAuth:(req,res,next)=>next(),audit(){}});
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const data=await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/orbitcard/products`)).json();
    assert.deepEqual(data.automatic_application,{product_code:'p1',amount:'20.00',quantity:1});assert.equal(data.application_error,null);
    assert.ok(data.products.every(product=>!Object.hasOwn(product,'prices') && Object.values(product.plans).every(plan=>!plan || !Object.hasOwn(plan,'price'))));
    assert.deepEqual(f.calls.map(c=>c.operation),['getProductCode']);assert.ok(!JSON.stringify(data).includes('api_key'));
});

test('admin region choices are read separately for each plan and expose only valid codes',async t => {
    const express=require('express'),{once}=require('node:events'),app=express(),calls=[];
    const plans={plus:'gpt-plus',pro100:'gpt-pro-5x',pro200:'gpt-pro-20x',pro500:'gpt-pro-25x'};
    const register=load('orbitcard-card-http.js',{'./orbitcard-client':{
        PLAN_MAP:plans,request:async (_,operation,body) => {
            assert.equal(operation,'getSubscriptionPaymentRegions');calls.push(body.plan_type);
            return {success:true,data:{plan_type:body.plan_type,payment_regions:[{code:'PH',default:true},{code:'US'},
                {code:'US'},{code:'not-a-region'}]}};
        }
    }});
    register(app,{store:{getGptApiConfig:async()=>cfg},cardService:{},requireSecondaryAuth:(req,res,next)=>next(),audit(){}});
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const data=await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/orbitcard/payment-regions`)).json();
    assert.deepEqual(calls,Object.values(plans));
    assert.deepEqual(data.regions.plus.options,[
        {code:'PH',default:true},
        {code:'US',default:false}
    ]);
    assert.equal(data.regions.plus.trace.path,'/api/open/v1/getSubscriptionPaymentRegions');
    assert.equal(data.regions.plus.trace.success,true);
    assert.ok(Number.isFinite(data.regions.plus.trace.elapsed_ms));
    const one=await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/orbitcard/payment-regions?plan=pro200`)).json();
    assert.deepEqual(Object.keys(one.regions),['pro200']);
    assert.deepEqual(calls,[...Object.values(plans),plans.pro200]);
    assert.ok(!JSON.stringify(data).includes('api_key'));
});

test('eligible existing card is chosen without issuing; the subscription worker receives its ID',async () => {
    const f=serviceFixture(); const card=await f.addCard(); f.setCards([{...card,status:'ACTIVE'}]); const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42); assert.equal(f.calls.filter(c => c.operation==='createCard').length,0);
    assert.equal(f.db.tasks[0].orbitcard_card_id,42);
});

test('payment retry stays on the requested first card, then excludes it for the second card',async () => {
    const f=serviceFixture(),first=await f.addCard(42),second=await f.addCard(43);
    f.setCards([{...first,status:'ACTIVE',balance:40},{...second,status:'ACTIVE',balance:100}]);
    const same=await f.claim();
    assert.equal(await f.service.allocate(cfg,same.jobKey,'plus',{preferredCardId:42}),42);
    await f.settle(same,'failed');
    const switched=await f.claim();
    assert.equal(await f.service.allocate(cfg,switched.jobKey,'plus',{excludedCardIds:[42]}),43);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,0);
});

test('unknown issuance is durable and a new worker or restart uses the same body/key',async () => {
    let ready=false;
    const f=serviceFixture({createCard:async () => ready?{success:true,data:{card_id:77,order_no:'OPEN-77',status:'success'}}:{success:false,status:502}});
    await assert.rejects(f.service.apply(cfg,'plus'),/原开卡申请仍待确认/);
    assert.equal(f.db.issues.length,1); assert.equal(f.db.issues[0].state,'unknown');
    f.advance(); await assert.rejects(f.service.apply(cfg,'plus')); assert.equal(f.db.issues.length,1);
    const before=f.calls.filter(c => c.operation==='createCard'); assert.equal(before[0].key,before[1].key); assert.deepEqual(before[0].body,before[1].body);
    ready=true; f.advance(); f.setCards([{card_id:77,status:'ACTIVE',product_code:'p1',balance:85,currency:'USD'}]); await f.service.recover({...cfg,enabled:false});
    assert.equal(f.db.issues[0].state,'ready'); assert.equal(f.db.cards[0].history_confirmed,1); assert.equal(f.db.uses.length,0);
});

test('list failures, malformed pages and a budget cap never result in an application',async () => {
    for (const response of [{success:false,status:403},{success:true,data:{}},{success:true,data:{list:[],total:10}}]) {
        const f=serviceFixture({getCardList:async () => response}),task=await f.claim(); await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus')); assert.equal(f.calls.filter(c => c.operation==='createCard').length,0);
    }
    const f=serviceFixture(),task=await f.claim(); await assert.rejects(f.service.apply({...cfg,orbitcard_max_initial_amount:'19'},'plus'),/首充/); assert.equal(f.db.issues.length,0);
});

test('cards are read without sensitive permission and secrets never appear in normalized data',async () => {
    const f=serviceFixture({cardDetail:async body => { assert.equal(body.reveal_sensitive,false); return {success:true,data:{card_id:42,status:'ACTIVE',balance:50,currency:'USD',card_number:'5556597912341234',cvv:'secret-cvv'}}; }});
    const result=await f.api.cardDetail(cfg,42); assert.equal(result.last4,'1234'); assert.ok(!JSON.stringify(result).includes('5556597912341234')); assert.ok(!JSON.stringify(result).includes('secret-cvv'));
});

test('card list pagination continues when the server caps the requested page size',async () => {
    const f=serviceFixture({getCardList:async body => ({success:true,data:{list:[{card_id:body.page,status:'ACTIVE'}],total:2}})});
    assert.deepEqual((await f.api.listCards(cfg)).map(c => c.card_id),[1,2]);
});

test('missing platform plan prices cannot fall back to another plan or retired manual budgets',() => {
    const f=serviceFixture(); const rows=f.api.normalizeProducts([{...product,gpt_plan_prices:[{id:'plus',price:20,currency:'USD'}]}]);
    assert.throws(() => f.api.chooseProduct(rows,'pro500',cfg),/没有符合/);
    assert.equal(f.api.chooseProduct(rows,'plus',cfg).amount,'20.00');
    const documentedRows=f.api.normalizeProducts({list:[{...product,gpt_plan_prices:undefined}]});
    assert.throws(() => f.api.chooseProduct(documentedRows,'pro100',cfg));
    assert.throws(() => f.api.chooseProduct(documentedRows,'pro100',{...cfg,orbitcard_price_pro100:'100'}));
});

test('documented GPT price IDs map to four plans and retain fixed decimal strings',() => {
    const f=serviceFixture();
    const rows=f.api.normalizeProducts({list:[{...product,gpt_plan_prices:[
        {id:'plus',name:'Plus',price:'20.00000000',currency:'USD',source:'config'},
        {id:'pro',name:'Pro 100',price:'100.50',currency:'USD',source:'transaction'},
        {id:'pro_20x',name:'Pro 200',price:'200.00',currency:'USD',source:'config'},
        {id:'pro_max',name:'Pro 100',price:'500.00',currency:'USD',source:'transaction'}
    ]}]});
    assert.equal(f.api.planPrice(rows[0],'plus'),'20.00000000');
    assert.equal(f.api.planPrice(rows[0],'pro100'),'100.50');
    assert.equal(f.api.planPrice(rows[0],'pro200'),'200.00');
    assert.equal(f.api.planPrice(rows[0],'pro500'),'500.00');
    assert.equal(rows[0].prices.find(price => price.plan_type==='pro100').source,'transaction');
    assert.equal(f.api.chooseProduct(rows,'pro500',cfg).price,'500.00');
});

test('CDK redemption stops before card funding or issuing when the product has no USD price',async () => {
    const f=serviceFixture({getProductCode:async()=>({success:true,data:[{...product,gpt_plan_prices:undefined}]})});
    const task=await f.claim();
    await assert.rejects(f.service.allocate({...cfg,orbitcard_price_plus:'1'},task.jobKey,'plus'),/未返回当前套餐的 USD 推荐价/);
    assert.equal(f.calls.some(call => ['createCard','rechargeCard'].includes(call.operation)),false);
});

test('Open API only fulfills status=success with valid numeric card ID and a complete matching order',async () => {
    for(const data of [
        {status:'processing',card_id:77,completed:false,order_no:'OPEN-1'},
        {status:'success',card_id:77,completed:false,order_no:'OPEN-1'},
        {status:'success',card_id:'77',completed:true,order_no:'OPEN-1'},
        {status:'success',card_id:77,completed:true},
        {status:'success',completed:true,order_no:'OPEN-1'},
        {status:'succeeded',card_id:77,order_no:'OPEN-1'}
    ]) {
        const f=serviceFixture({createCard:async () => ({success:true,data})}),task=await f.claim();
        await assert.rejects(f.service.apply(cfg,'plus'));
        assert.equal(f.db.issues.length,1);assert.ok(['pending','unknown'].includes(f.db.issues[0].state));
        assert.equal(f.db.cards.length,0);assert.equal(f.db.uses.length,0);
    }
});

test('only failed/refunded complete orders release an application as a final failure',async () => {
    for(const status of ['failed','refunded']) {
        const f=serviceFixture({createCard:async () => ({success:true,data:{status,completed:true,order_no:'OPEN-FAIL'}})}),task=await f.claim();
        await assert.rejects(f.service.apply(cfg,'plus'),/已确认开卡失败/);assert.equal(f.db.issues[0].state,'failed');assert.equal(f.db.uses.length,0);
    }
});

test('order identity changes stop fulfillment and preserve the original order number',async () => {
    let changed=false;
    const f=serviceFixture({createCard:async () => ({success:true,data:changed?{status:'success',card_id:77,order_no:'WRONG'}:{status:'pending_confirm',order_no:'ORIGINAL',completed:false}})});
    const task=await f.claim(); await assert.rejects(f.service.apply(cfg,'plus'));f.advance();changed=true;
    await assert.rejects(f.service.apply(cfg,'plus'),/归属不一致/);
    assert.equal(f.db.issues[0].order_no,'ORIGINAL');assert.equal(f.db.issues[0].state,'unknown');assert.equal(f.db.cards.length,0);
});

test('Retry-After is persisted and changing credentials or original parameters never sends another request',async () => {
    const f=serviceFixture({createCard:async () => ({success:true,data:{status:'pending_confirm',order_no:'ORIGINAL',completed:false,retry_after_seconds:120}})}),task=await f.claim();
    await assert.rejects(f.service.apply(cfg,'plus'));const count=() => f.calls.filter(c => c.operation==='createCard').length;
    assert.equal(count(),1);f.advance(60000);await assert.rejects(f.service.apply(cfg,'plus'),/重查间隔/);assert.equal(count(),1);
    f.advance(60000);await assert.rejects(f.service.apply({...cfg,api_key:'another-account'},'plus'),/API Key/);assert.equal(count(),1);
    f.db.issues[0].request_body='{"product_code":"p1","amount":"90.00","quantity":1}';
    await assert.rejects(f.service.apply(cfg,'plus'),/原开卡参数/);assert.equal(count(),1);assert.equal(f.db.issues.length,1);
});

test('exhausting one plan does not prevent selecting the same funded card for another plan',async () => {
    const f=serviceFixture();const card=await f.addCard(42,true,4);
    f.setCards([{...card,status:'ACTIVE',balance:1000}]);const task=await f.claim('pro200');
    assert.equal(await f.service.allocate(cfg,task.jobKey,'pro200'),42);
    assert.equal(f.calls.filter(c => c.operation==='createCard').length,0);await f.settle(task,'success');
    assert.equal(f.db.cards[0].successful_plus,4);assert.equal(f.db.cards[0].successful_pro200,1);assert.equal(f.db.cards[0].successful_pro100,0);
});

test('available account balance is checked before cards; frozen, total and card balances cannot bypass the locked CDK',async () => {
    const f=serviceFixture({getAccountBalance:async () => ({success:true,data:{available_balance:'19.99',total_balance:'9999',frozen_balance:'9000',estimated_card_balance:'5000'}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:1000}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/联系管理员/);
    assert.deepEqual(f.calls.map(c => c.operation),['getAccountBalance','getProductCode']);
    assert.equal(f.db.tasks[0].orbitcard_state,'balance_blocked');assert.equal(f.db.tasks[0].status,'failed');assert.equal(f.db.tasks[0].orbitcard_required_balance,'20.00000000');
    assert.ok(f.db.cdks[0].used_at);assert.equal(f.db.issues.length,0);assert.equal(f.db.fundings.length,0);
});

test('restoring account balance only releases the CDK for a fresh Session, never pays automatically',async () => {
    const f=serviceFixture(),task=await f.claim();f.setAccount(0);
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'));
    const recovery=require('../order-recovery')({store:f.store,activeJobs:new Set(),audit() {},checkBalance:task => f.service.canResumeBalance(cfg,task),
        query:{refresh:async () => {throw new Error('must not query a nonexistent subscription');}}});
    await recovery.refreshTask({...f.db.tasks[0]});assert.ok(f.db.cdks[0].used_at);
    f.setAccount(20);f.advance();await recovery.refreshTask({...f.db.tasks[0]});
    assert.equal(f.db.tasks[0].status,'retry');assert.equal(f.db.cdks[0].used_at,null);
    assert.equal(f.calls.filter(c => c.operation==='getProductCode').length,1);
    assert.equal(f.calls.some(c => ['getCardList','createCard','rechargeCard'].includes(c.operation)),false);
});

test('a card with quota but insufficient balance receives only the exact deficit, without creating a new card',async () => {
    const f=serviceFixture();const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.calls[0].operation,'getAccountBalance');assert.equal(f.calls.filter(c => c.operation==='createCard').length,0);
    const request=f.calls.find(c => c.operation==='rechargeCard');assert.deepEqual(request.body,{card_id:42,amount:'16.00'});assert.match(request.key,/^fund-/);
    assert.equal(f.db.fundings[0].state,'ready');assert.equal(f.db.cards[0].successful_plus,0);assert.equal(f.db.cards[0].active_job,task.jobKey);
});

test('a funded card is preferred to another eligible card needing a topup',async () => {
    const f=serviceFixture();const a=await f.addCard(42),b=await f.addCard(43);f.setCards([{...a,status:'ACTIVE',balance:1},{...b,status:'ACTIVE',balance:100}]);const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),43);assert.equal(f.db.fundings.length,0);assert.equal(f.db.issues.length,0);
});

test('unknown topup without an order number is recovered using the original key and exact body',async () => {
    let ready=false;
    const f=serviceFixture({rechargeCard:async body => ready?{success:true,data:{order_no:'FUND-ORIGINAL',amount:body.amount,status:'success'}}:{success:false,status:502}});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/补款结果仍待确认/);assert.equal(f.db.fundings[0].state,'unknown');assert.equal(f.db.cards[0].active_job,task.jobKey);
    await f.settle(task,'funding_pending');f.advance();ready=true;f.setCards([{...card,status:'ACTIVE',balance:21}]);await f.service.recover(cfg);
    const calls=f.calls.filter(c => c.operation==='rechargeCard');assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);
    assert.equal(f.db.fundings[0].state,'ready');assert.equal(f.db.fundings.length,1);assert.equal(f.db.cards[0].successful_plus,0);
});

test('known topup order is confirmed by exact getCardFlow order number, not by unrelated successful flows',async () => {
    const f=serviceFixture({rechargeCard:async body => ({success:true,data:{order_no:'ORIGINAL',amount:body.amount,status:'pending_confirm'}}),
        getCardFlow:async body => ({success:true,data:{card_id:42,type:'recharge',total:2,list:[body.page===1?{order_no:'OTHER',amount:'16.00',status:'success'}:{order_no:'ORIGINAL',amount:'16.00',status:'success'}]}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'));f.advance();f.setCards([{...card,status:'ACTIVE',balance:21}]);await f.service.recover(cfg);
    assert.equal(f.calls.filter(c => c.operation==='rechargeCard').length,1);assert.equal(f.calls.filter(c => c.operation==='getCardFlow').length,2);assert.equal(f.db.fundings[0].state,'ready');
});

test('topup completion must be followed by confirmed sufficient card balance',async () => {
    const f=serviceFixture({rechargeCard:async body => ({success:true,data:{order_no:'ORIGINAL',amount:body.amount,status:'success'}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/余额仍待核对/);assert.equal(f.db.fundings[0].state,'pending');assert.equal(f.db.cards[0].active_job,task.jobKey);assert.ok(f.db.cdks[0].used_at);
});

test('fresh account shortage before topup locks both the selected card and CDK without sending money',async () => {
    let calls=0;
    const f=serviceFixture({getAccountBalance:async () => ({success:true,data:{available_balance:++calls===1?'100.00':'1.00'}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/余额不足/);assert.equal(f.db.tasks[0].orbitcard_state,'balance_blocked');assert.equal(f.db.cards[0].active_job,task.jobKey);assert.equal(f.db.fundings.length,0);
});

test('fixed 20 USD issue never silently raises the amount to satisfy a higher product minimum',() => {
    const f=serviceFixture(),rows=f.api.normalizeProducts([{...product,min_initial_amount:25}]);
    assert.throws(() => f.api.chooseProduct(rows,'plus',cfg),/20 USD/);
});

test('quota-available cards with unsupported state or currency are skipped for a new card',async () => {
    for(const change of [{status:'CANCELLED'},{currency:'EUR'}]) {
        const f=serviceFixture(),card=await f.addCard();f.setCards([{...card,status:'ACTIVE',...change}]);const task=await f.claim();
        assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),101);
        assert.equal(f.db.issues.length,1);
    }
});

test('funding-pending restart never sends a subscription query and releases only after the original topup resolves',async () => {
    const f=serviceFixture({rechargeCard:async body => ({success:true,data:{order_no:'ORIGINAL',amount:body.amount,status:'pending_confirm'}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'));
    const recovery=require('../order-recovery')({store:f.store,activeJobs:new Set(),audit() {},reconcileCards:async () => {},
        query:{refresh:async () => {throw new Error('must not query a nonexistent subscription');}}});
    await recovery.refreshTask({...f.db.tasks[0]});assert.equal(f.db.tasks[0].orbitcard_state,'funding_pending');assert.ok(f.db.cdks[0].used_at);
    await recovery.refreshTask({...f.db.tasks[0]});assert.equal(f.db.cards[0].active_job,task.jobKey);
    f.db.fundings[0].state='ready';await recovery.refreshTask({...f.db.tasks[0]});
    assert.equal(f.db.tasks[0].status,'retry');assert.equal(f.db.cdks[0].used_at,null);assert.equal(f.db.cards[0].active_job,null);assert.equal(f.db.cards[0].successful_plus,0);
});

test('funding Retry-After and changed credential/body cannot cause duplicate topups',async () => {
    const f=serviceFixture({rechargeCard:async body => ({success:true,retryAfterMs:120000,data:{order_no:'ORIGINAL',amount:body.amount,status:'pending_confirm'}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'));
    const moneyCalls=() => f.calls.filter(c => ['rechargeCard','getCardFlow'].includes(c.operation)).length;
    assert.equal(moneyCalls(),1);f.advance(60000);await f.service.recover(cfg);assert.equal(moneyCalls(),1);
    f.advance(60000);await f.service.recover({...cfg,api_key:'another-account'});assert.equal(moneyCalls(),1);
    f.advance();f.db.fundings[0].request_body='{"card_id":42,"amount":"99.00"}';await f.service.recover(cfg);assert.equal(moneyCalls(),1);assert.equal(f.db.fundings.length,1);
});

test('wrong amount on a matching funding flow keeps the card locked and does not fund again',async () => {
    const f=serviceFixture({rechargeCard:async body => ({success:true,data:{order_no:'ORIGINAL',amount:body.amount,status:'pending_confirm'}}),
        getCardFlow:async () => ({success:true,data:{card_id:42,type:'recharge',total:1,list:[{order_no:'ORIGINAL',amount:'999.00',status:'success'}]}})});
    const card=await f.addCard();f.setCards([{...card,status:'ACTIVE',balance:5}]);const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'));f.advance();await f.service.recover(cfg);
    assert.equal(f.db.fundings[0].state,'unknown');assert.equal(f.db.cards[0].active_job,task.jobKey);assert.equal(f.calls.filter(c => c.operation==='rechargeCard').length,1);
});

test('missing account balance fails closed rather than treating totals as available money',async () => {
    const f=serviceFixture({getAccountBalance:async () => ({success:true,data:{total_balance:'999.00'}})}),task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/金额缺失/);assert.deepEqual(f.calls.map(c => c.operation),['getAccountBalance']);assert.equal(f.db.fundings.length,0);assert.equal(f.db.issues.length,0);
});

test('money calculations are decimal-exact and deficits round upward only to cents',() => {
    const money=require('../orbitcard-money');assert.equal(money.cents(money.units('20')+money.units('1')-money.units('20.99999999')),'0.01');
    assert.equal(money.cents(money.units('0.10')+money.units('0.20')),'0.30');assert.throws(() => money.units('NaN'));assert.throws(() => money.units('-1'));
});

test('card allocation failure prevents any subscription create request',async () => {
    const calls=[];
    const worker=load('orbitcard-worker.js',{'./orbitcard-client':{
        PLAN_MAP:{plus:'gpt-plus'},fetchPlans:async () => ({success:true,plans:[{type:'gpt-plus'}]}),
        request:async (_,operation) => {calls.push(operation); return {success:true,data:{payment_regions:[{code:'US',default:true}]}};}
    }});
    const previous=process.env.ORBITCARD_API_SECRET; process.env.ORBITCARD_API_SECRET='fixture';
    try {
        await assert.rejects(worker.run({cfg:{},planType:'plus',clientOrderNo:'allocation-failure',session:{user:{email:'c@example.test'},account:{},accessToken:'secret'},
            selectCard:async () => {throw new Error('card unavailable');}}),/card unavailable/);
        assert.deepEqual(calls,[]);
    } finally {if(previous===undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET=previous;}
});

test('full worker path passes selected card to create and atomically consumes its slot after success',async () => {
    const f=serviceFixture(),card=await f.addCard(100),task=await f.claim(),calls=[];f.setCards([{...card,status:'ACTIVE',balance:50}]);
    const worker=load('orbitcard-worker.js',{'./orbitcard-client':{
        PLAN_MAP:{plus:'gpt-plus'},fetchPlans:async () => ({success:true,plans:[{type:'gpt-plus'}]}),
        summary:require('../orbitcard-client').summary,outcome:require('../orbitcard-client').outcome,captcha:() => null,
        request:async (_,operation,body,key) => {
            calls.push({operation,body,key});
            if(operation==='getSubscriptionPaymentRegions') return {success:true,data:{payment_regions:[{code:'US',default:true}]}};
            if(operation==='createSubscription') return {success:true,data:{task_no:'SUB-1'}};
            return {success:true,data:{task_no:'SUB-1',client_order_no:task.orbitcardClientOrderNo,plan_type:'gpt-plus',card_id:100,status:'succeeded'}};
        }
    }});
    const previous=process.env.ORBITCARD_API_SECRET; process.env.ORBITCARD_API_SECRET='fixture';
    try {
        await worker.run({cfg,planType:'plus',cdk:'CODE-1',clientOrderNo:task.orbitcardClientOrderNo,
            session:{user:{email:'customer@example.test'},account:{},accessToken:'private-session'},
            selectCard:() => f.service.allocate(cfg,task.jobKey,'plus'),onSubmission() {},broadcast() {},sleep:async () => {},maxPolls:1,
            setProgress:(status,progress,message,extra) => f.store.settleOrbitcardTask(task.jobKey,{status,progress,message,...extra})});
        assert.equal(calls.find(c => c.operation==='createSubscription').body.card_id,100);
        assert.equal(f.db.cards[0].successful_plus,1); assert.equal(f.db.cards[0].active_job,null); assert.equal(f.db.tasks[0].status,'success');
        assert.ok(!JSON.stringify(f.db).includes('private-session')); assert.ok(!JSON.stringify(f.events).includes('private-session'));
    } finally {if(previous===undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET=previous;}
});

async function runPaymentCore({ plan = 'plus', balance = 50, empty = false, result = 'success', account = 10000,
    invalidSession = false, count = 1 } = {}) {
    const f = serviceFixture(), requests = [], notices = [], activeJobs = new Set(), activeChallenges = new Map();
    const cards = [];
    if (!empty) for (let n = 0; n < count; n++) cards.push({ ...await f.addCard(42 + n), status: 'ACTIVE', balance });
    f.setCards(cards); f.setAccount(account);
    const task = await f.claim(plan), orders = new Map(), provider = require('../orbitcard-client');
    const transport = { PLAN_MAP: provider.PLAN_MAP, summary: provider.summary, outcome: provider.outcome, captcha: () => null,
        fetchPlans: async () => ({ success: true, plans: Object.values(require('../plan-registry').PROVIDER_PLANS).map(type => ({ type })) }),
        request: async (config, operation, body, key) => {
            requests.push({ operation, body, key, jobKey: config.auditJobKey });
            if (operation === 'createSubscription') {
                const current = f.db.tasks.find(row => row.orbitcard_client_order_no === body.client_order_no);
                assert.equal(current.orbitcard_state, 'submitting');
                assert.equal(f.db.cards.find(row => row.card_id === body.card_id).active_job, current.job_key);
                assert.equal(body.payment_region, undefined);
                assert.equal(key, body.client_order_no);
                const snapshot = { task_no: `SUB-${orders.size + 1}`, client_order_no: key, card_id: body.card_id,
                    targetEmail: body.session_json.user.email, plan_type: body.plan_type,
                    status: result === 'success' ? 'succeeded' : 'failed', subscription_succeeded: result === 'success' };
                orders.set(key, snapshot);
                return result === 'unknown' ? { success: false, status: 504 } : { success: true, data: snapshot };
            }
            assert.equal(operation, 'getSubscription');
            if (result === 'unknown') return { success: false, status: 503 };
            return { success: true, data: orders.get(body.client_order_no) || [...orders.values()].find(row => row.task_no === body.task_no) };
        } };
    const worker = load('orbitcard-worker.js', { './orbitcard-client': transport });
    const store = { ...f.store, getTaskStatus: async key => structuredClone(f.db.tasks.find(row => row.job_key === key)) };
    const core = require('../payment-service')({ store, cardService: f.service, worker: { run: args => worker.run({ ...args, maxPolls: 1 }) },
        activeJobs, activeChallenges, audit: event => f.events.push(event), broadcast() {}, log() {},
        notify: async order => notices.push(order), sleep: async () => {} });
    const previous = process.env.ORBITCARD_API_SECRET; process.env.ORBITCARD_API_SECRET = 'fixture';
    activeJobs.add(task.jobKey);
    try {
        await core.run({ task: { ...task, apiConfig: cfg }, cdk: 'CODE-1', planType: plan,
            session: invalidSession ? {} : { user: { email: 'customer@example.test' }, account: {}, accessToken: 'private-core-session' } });
    } finally { if (previous === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = previous; }
    assert.equal(activeJobs.size, 0); assert.equal(activeChallenges.size, 0);
    assert.ok(!JSON.stringify([f.db, f.events, notices]).includes('private-core-session'));
    return { ...f, requests, notices };
}

test('payment core completes all four plans and settles CDK and card quota exactly once', async () => {
    for (const plan of ['plus', 'pro100', 'pro200', 'pro500']) {
        const f = await runPaymentCore({ plan, balance: 600 });
        assert.equal(f.db.tasks[0].status, 'success'); assert.ok(f.db.cdks[0].used_at);
        assert.equal(f.db.cards[0][`successful_${plan}`], 1); assert.equal(f.db.cards[0].active_job, null);
        assert.equal(f.db.uses[0].state, 'consumed'); assert.equal(f.db.issues.length, 0); assert.equal(f.db.fundings.length, 0);
        assert.deepEqual(f.requests.map(row => row.operation), ['createSubscription', 'getSubscription']);
        assert.equal(f.notices.at(-1).status, 'success');
    }
});

test('payment core funds the exact deficit or opens at 20 USD before submitting membership', async () => {
    const old = await runPaymentCore({ balance: 5 });
    assert.equal(old.db.fundings[0].amount, '16.00'); assert.equal(old.db.fundings[0].state, 'ready');
    assert.equal(old.db.issues.length, 0); assert.equal(old.db.tasks[0].status, 'success');
    const fresh = await runPaymentCore({ empty: true });
    assert.equal(fresh.db.issues.length, 1); assert.equal(fresh.db.issues[0].amount, '20.00');
    assert.equal(fresh.db.fundings[0].amount, '1.00'); assert.equal(fresh.db.tasks[0].status, 'success');
    assert.equal(fresh.calls.filter(row => row.operation === 'createCard').length, 1);
});

test('payment core keeps unknown payments on the original identity and retains CDK and card', async () => {
    const f = await runPaymentCore({ result: 'unknown' });
    assert.equal(f.db.tasks.length, 1); assert.equal(f.db.tasks[0].orbitcard_state, 'manual');
    assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, f.db.tasks[0].job_key);
    assert.equal(f.db.cards[0].successful_plus, 0);
    assert.deepEqual(f.requests.map(row => row.operation), ['createSubscription', 'getSubscription']);
    assert.equal(f.requests[1].body.client_order_no, f.requests[0].key);
});

test('payment core rotates only confirmed failures and locks after three distinct cards', async () => {
    const f = await runPaymentCore({ result: 'failed', count: 3 });
    assert.equal(f.db.tasks.length, 3); assert.equal(f.db.tasks.at(-1).orbitcard_state, 'support_locked');
    assert.ok(f.db.cdks[0].used_at);
    const writes = f.requests.filter(row => row.operation === 'createSubscription');
    assert.equal(new Set(writes.map(row => row.key)).size, 3);
    assert.equal(new Set(writes.map(row => row.body.card_id)).size, 3);
    assert.deepEqual(writes.map(row => row.jobKey), f.db.tasks.map(row => row.job_key));
    assert.ok(f.db.cards.every(row => row.successful_plus === 0 && !row.active_job));
});

test('payment core rejects invalid session before funding and locks an insufficient account before payment', async () => {
    const invalid = await runPaymentCore({ invalidSession: true, empty: true });
    assert.equal(invalid.calls.length, 0); assert.equal(invalid.requests.length, 0); assert.equal(invalid.db.cdks[0].used_at, null);
    const low = await runPaymentCore({ account: 1 });
    assert.equal(low.requests.length, 0); assert.equal(low.db.tasks[0].orbitcard_state, 'balance_blocked');
    assert.ok(low.db.cdks[0].used_at); assert.equal(low.db.fundings.length, 0); assert.equal(low.db.issues.length, 0);
});

test('a transient failure reading preparation records cannot release CDK or the reserved payment card', async () => {
    const f = fixture(), task = await f.claim(); await f.addCard();
    await f.store.cardMethods(f.base).reserveCard(42, task.jobKey, 'plus');
    const store = { ...f.store, getCardIssueForTask: async () => { throw new Error('temporary read failure'); },
        getTaskStatus: async key => structuredClone(f.db.tasks.find(row => row.job_key === key)) };
    const core = require('../payment-service')({ store, cardService: {},
        worker: { run: async () => { throw new Error('preparation interrupted'); } },
        activeJobs: new Set([task.jobKey]), activeChallenges: new Map(), audit() {}, broadcast() {}, log() {}, notify: async () => {} });
    await core.run({ task: { ...task, apiConfig: cfg }, cdk: 'CODE-1', planType: 'plus', session: {} });
    assert.equal(f.db.tasks[0].orbitcard_state, 'prepared'); assert.equal(f.db.tasks[0].status, 'manual');
    assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job, task.jobKey);
    assert.equal(f.db.uses[0].state, 'reserved');
});

test('prepared issuance recovery does not send a remote write after a crash',async () => {
    const f=serviceFixture();
    await f.store.cardMethods(f.base).createIssue({issue_key:'card-original',plan_type:'plus',product_code:'p1',amount:'85.00',credential_hash:'irrelevant',request_body:'{}'});
    await f.service.recover(cfg); assert.equal(f.db.issues[0].state,'failed'); assert.equal(f.calls.length,0);
});

test('advisory allocation lock is always released and lock timeout never runs allocation',async () => {
    const calls=[]; let acquired=1;
    const connection={release() {calls.push('release');},destroy() {calls.push('destroy');}};
    const store=require('../orbitcard-card-store')({openLockConnection:async () => connection,
        runQuery:async (sql,params,options) => {assert.equal(options.connection,connection);calls.push(sql);return [{acquired}];}});
    await assert.rejects(store.withCardAllocationLock(cfg.base_url,async () => {throw new Error('allocation failed');}),/allocation failed/);
    assert.equal(calls.at(-1),'destroy');assert.ok(!calls.includes('release'));
    calls.length=0;acquired=0;
    await assert.rejects(store.withCardAllocationLock(cfg.base_url,async () => {throw new Error('must not execute');}),/支付卡正在分配/);
    assert.equal(calls.length,2);assert.equal(calls.at(-1),'destroy');
});

test('card management HTTP routes require secondary auth for applying and binding',async t => {
    const express=require('express'),{once}=require('node:events'),app=express();app.use(express.json());
    let applications=0,bindings=0;
    const register=load('orbitcard-card-http.js',{'./orbitcard-cards-client':{positiveId:value => Number(value)}});
    register(app,{store:{getGptApiConfig:async () => cfg,withCardAllocationLock:async (_,fn) => fn({bindCard:async () => {bindings++;}}),
        cardMethods:() => ({listCards:async () => [],listIssues:async () => [],listFundings:async () => []})},
        cardService:{apply:async () => {applications++;return {card_id:99};}},audit() {},
        requireSecondaryAuth:(req,res,next) => req.headers['x-secondary']==='valid'?next():res.status(403).json({success:false})});
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
    const base=`http://127.0.0.1:${server.address().port}`;
    const post=(route,body,secondary=false) => fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(secondary?{'x-secondary':'valid'}:{})},body:JSON.stringify(body)});
    for(const route of ['/api/admin/orbitcard/cards/apply','/api/admin/orbitcard/cards/42/bind']) assert.equal((await post(route,{})).status,403);
    assert.equal(applications,0);assert.equal(bindings,0);
    assert.equal((await post('/api/admin/orbitcard/cards/apply',{plan_type:'arbitrary'},true)).status,400);
    assert.equal((await post('/api/admin/orbitcard/cards/apply',{plan_type:'plus'},true)).status,200);assert.equal(applications,1);
    assert.equal((await post('/api/admin/orbitcard/cards/42/bind',{usage:{plus:2,pro100:0,pro200:0,pro500:0}},true)).status,200);assert.equal(bindings,1);
});

test('eligible cards are inspected in one batch without per-card rereads',async () => {
    const f=serviceFixture(),a=await f.addCard(42),b=await f.addCard(43);
    f.setCards([{...a,status:'ACTIVE',balance:5},{...b,status:'ACTIVE',balance:50}]);
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),43);
    const details=f.calls.filter(call=>call.operation==='cardDetail');
    assert.deepEqual(details.map(call=>call.body),[
        {card_ids:[42,43],reveal_sensitive:false}
    ]);
    assert.equal(f.calls.filter(call=>call.operation==='rechargeCard'||call.operation==='createCard').length,0);
});

test('live V1 items/data batch updates balances, status and masked tail without resetting quota',async () => {
    const f=serviceFixture({cardDetail:async () => ({success:true,data:{total:2,succeeded:2,failed:0,items:[
        {index:1,card_id:42,success:true,data:{card_id:42,card_type:'save',status:'ACTIVE',product_code:'p1',
            available_amount:'0.03000000',card_number_masked:'400052******4139',billing_address:'private-address'}},
        {index:2,card_id:43,success:true,data:{card_id:43,card_type:'save',status:'CANCELLED',product_code:'p1',
            available_amount:'20.00000000',card_number_masked:'400052******7464'}}]}})});
    const a=await f.addCard(42),b=await f.addCard(43); f.db.cards[0].successful_plus=2;
    f.setCards([{...a,status:'ACTIVE',balance:20},{...b,status:'ACTIVE',balance:20}]);
    const result=await f.service.synchronize(cfg);
    assert.deepEqual(result.synced_ids,[42,43]); assert.deepEqual(result.failed_ids,[]);
    assert.equal(f.db.cards[0].balance,0.03); assert.equal(f.db.cards[0].currency,'USD');
    assert.equal(f.db.cards[0].last4,'4139'); assert.equal(f.db.cards[0].successful_plus,2);
    assert.equal(f.db.cards[1].provider_status,'CANCELLED');
    assert.ok(!JSON.stringify(f.db.cards).includes('private-address'));
    assert.ok(f.calls.every(call=>['getCardList','cardDetail'].includes(call.operation)));
});

test('partial batch failure syncs confirmed cards and identifies stale card snapshots',async () => {
    const f=serviceFixture({cardDetail:async () => ({success:true,data:{items:[
        {card_id:42,success:true,data:{card_id:42,status:'ACTIVE',balance:'0.03',currency:'USD'}},
        {card_id:43,success:false,error:{code:'provider_unavailable'}}]}})});
    const a=await f.addCard(42),b=await f.addCard(43);f.setCards([{...a,status:'ACTIVE'},{...b,status:'ACTIVE'}]);
    const result=await f.service.synchronize(cfg);
    assert.deepEqual(result.synced_ids,[42]);assert.deepEqual(result.failed_ids,[43]);
    assert.equal(f.db.cards[0].balance,0.03);assert.equal(f.db.cards[1].balance,b.balance);
    // Failed card 43 must never be accepted merely because its cached balance is sufficient.
    await f.api.cardDetails(cfg,[42,43],{allowPartial:true}).then(cards=>assert.deepEqual(cards.map(c=>c.card_id),[42]));
    await assert.rejects(f.api.cardDetails(cfg,[42,43]),/43.*失败/);
});

test('actual V1 balance shape chooses funded card over stale cached balance without a topup',async()=>{
    const live=[
        {card_id:42,card_type:'save',product_code:'p1',status:'ACTIVE',available_amount:'0.03000000'},
        {card_id:43,card_type:'save',product_code:'p1',status:'ACTIVE',available_amount:'25.00000000'}
    ];
    const f=serviceFixture({cardDetail:async body=>({success:true,data:{items:body.card_ids.map(id=>({
        card_id:id,success:true,data:live.find(card=>card.card_id===id)}))}})});
    await f.addCard(42);await f.addCard(43);f.setCards(live);
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),43);
    assert.equal(f.db.cards.find(card=>card.card_id===42).balance,0.03);
    assert.ok(!f.calls.some(call=>['rechargeCard','createCard'].includes(call.operation)));
});

test('batch wrappers reject foreign and duplicate IDs and never trust wrapper success as card status',async () => {
    for(const items of [
        [{card_id:42,success:true,data:{card_id:99,status:'ACTIVE'}}],
        [{card_id:42,success:true,data:{card_id:42,status:'ACTIVE'}},{card_id:42,success:true,data:{card_id:42,status:'ACTIVE'}}],
        [{card_id:99,success:false,error:{code:'missing'}}]
    ]) {
        const f=serviceFixture({cardDetail:async()=>({success:true,data:{items}})});
        await assert.rejects(f.api.cardDetails(cfg,[42,43],{allowPartial:true}),/ID|归属/);
    }
    const f=serviceFixture({cardDetail:async()=>({success:true,data:{items:[{card_id:42,success:true,status:'ACTIVE',data:{card_id:42}}]}})});
    assert.deepEqual(await f.api.cardDetails(cfg,[42,43],{allowPartial:true}),[]);
});

test('save-card USD compatibility preserves explicit currency and rejects invalid balance aliases',()=>{
    const f=serviceFixture();
    assert.equal(f.api.normalizeCard({card_type:'save',available_amount:'0.00',product_code:'p1'}).currency,'USD');
    assert.equal(f.api.normalizeCard({card_type:'save',available_amount:'20',product_code:'p1',currency:'EUR'}).currency,'EUR');
    assert.equal(f.api.normalizeCard({balance:'20'}).currency,'');
    assert.equal(f.api.normalizeCard({available_amount:true}).balance,null);
    assert.equal(f.api.normalizeCard(null).balance,null);
});

test('full batch sync failure is audited without presenting old balances as synchronized',async()=>{
    const f=serviceFixture({cardDetail:async()=>({success:true,data:{unexpected:'secret'}})});
    const a=await f.addCard(42),b=await f.addCard(43);f.setCards([{...a,status:'ACTIVE'},{...b,status:'ACTIVE'}]);
    await assert.rejects(f.service.synchronize(cfg),/响应结构/);
    assert.ok(f.events.some(event=>event.event==='cards_sync_failed'));
    assert.ok(!f.events.some(event=>event.event==='cards_synchronized'));
    assert.ok(!JSON.stringify(f.events).includes('secret'));
});

test('incomplete batch selects its valid card without per-card fallback',async () => {
    const f=serviceFixture({cardDetail:async () => ({success:true,data:{list:[
        {card_id:42,status:'ACTIVE',balance:50,currency:'USD'}]}})});
    const a=await f.addCard(42),b=await f.addCard(43);f.setCards([{...a,status:'ACTIVE'},{...b,status:'ACTIVE'}]);
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.deepEqual(f.calls.filter(call=>call.operation==='cardDetail').map(call=>call.body),
        [{card_ids:[42,43],reveal_sensitive:false}]);
    assert.ok(f.events.some(event=>event.event==='card_unavailable'&&event.data.card_id===43));
});

test('batch with no usable detail locks selection for support without single-card reads',async () => {
    const f=serviceFixture({cardDetail:async () => ({success:true,data:{list:[]}})});
    const a=await f.addCard(42),b=await f.addCard(43);f.setCards([{...a,status:'ACTIVE'},{...b,status:'ACTIVE'}]);
    const task=await f.claim();await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/人工售后/);
    assert.deepEqual(f.calls.filter(call=>call.operation==='cardDetail').map(call=>call.body),
        [{card_ids:[42,43],reveal_sensitive:false}]);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,0);
});

test('foreign or duplicate batch detail stops selection without opening or funding',async () => {
    for(const rows of [
        [{card_id:42,status:'ACTIVE',balance:50,currency:'USD'},{card_id:99,status:'ACTIVE',balance:50,currency:'USD'}],
        [{card_id:42,status:'ACTIVE',balance:50,currency:'USD'},{card_id:42,status:'ACTIVE',balance:50,currency:'USD'}]
    ]) {
        const f=serviceFixture({cardDetail:async () => ({success:true,data:{list:rows}})});
        const a=await f.addCard(42),b=await f.addCard(43);f.setCards([{...a,status:'ACTIVE'},{...b,status:'ACTIVE'}]);
        const task=await f.claim();await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/人工售后/);
        assert.equal(f.calls.filter(call=>['rechargeCard','createCard'].includes(call.operation)).length,0);
    }
});

test('catalog service fee does not block card selection; configured cap is passed to the provider',async () => {
    const previous=process.env.ORBITCARD_API_SECRET;process.env.ORBITCARD_API_SECRET='fixture';
    let selections=0,markers=0,submissions=0;
    const calls=[];
    try {
        const worker=load('orbitcard-worker.js',{'./orbitcard-client':{
            PLAN_MAP:{plus:'gpt-plus'},fetchPlans:async () => ({success:true,plans:[{type:'gpt-plus',service_fee:'0.25000000'}]}),
            summary:() => ({}),outcome:data => data.status==='succeeded'?'success':'pending',captcha:() => null,
            request:async (_,operation,body) => {
                calls.push({operation,body});
                if(operation==='getSubscriptionPaymentRegions') return {success:true,data:{payment_regions:[{code:'US',default:true}]}};
                if(operation==='createSubscription') return {success:true,data:{task_no:'subscription-1'}};
                if(operation==='getSubscription') return {success:true,data:{task_no:'subscription-1',client_order_no:'order-1',
                    plan_type:'gpt-plus',card_id:42,status:'succeeded'}};
                throw Error('unexpected operation');
            }
        }});
        await worker.run({cfg:{...cfg,orbitcard_max_fee:'0.20'},planType:'plus',clientOrderNo:'order-1',
            session:{user:{email:'customer@example.test'},account:{},accessToken:'fixture'},cdk:'fixture',
            selectCard:async () => {selections++;return 42;},
            setProgress:async () => {markers++;},onSubmission:async () => {submissions++;},
            broadcast() {},sleep:async () => {},maxPolls:1});
        assert.equal(selections,1);assert.equal(submissions,1);assert.ok(markers>0);
        assert.equal(calls.find(call=>call.operation==='createSubscription').body.max_service_fee,'0.20');
    } finally {if(previous===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=previous;}
});

test('transaction query filters sensitive fields, rejects foreign ownership and never changes quota',async () => {
    const rows=[{card_id:42,transaction_id:'txn-1',status:'Settlement',amount:'20.00',merchant:'OPENAI',
        card_number:'5556597912341234',cvv:'secret',session_json:{accessToken:'private'}}];
    const f=serviceFixture({cardTransaction:async () => ({success:true,data:{list:rows,total:1}})});
    f.setCards([{card_id:42,status:'ACTIVE',product_code:'p1',balance:'22.00',currency:'USD'}]);
    const result=await f.service.transactions(cfg,42);
    assert.equal(result.transactions[0].transaction_id,'txn-1');assert.equal(result.total,1);
    assert.ok(!JSON.stringify(result).includes('5556597912341234'));
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(f.db.uses.length,0);
    rows[0].card_id=43;
    await assert.rejects(f.service.transactions(cfg,42),/归属不一致/);
    rows[0]=null;
    await assert.rejects(f.service.transactions(cfg,42),/格式无效/);
});

test('HTTP 429 cooldown is shared by API operations for one account but does not block another key',async () => {
    const previous=process.env.ORBITCARD_API_SECRET,previousKey=process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET='fixture';process.env.ORBITCARD_API_KEY='fixture';
    const sent=[];
    try {
        const client=load('orbitcard-client.js',{
            axios:{request:async options => {sent.push(options.url);return {status:429,headers:{'retry-after':'60'},data:{code:429,data:{}}};}},
            './runtime-log':{push() {}}
        });
        const first=await client.request(cfg,'getAccountBalance');
        const second=await client.request(cfg,'getCardList',{page:1});
        process.env.ORBITCARD_API_KEY='another-account';
        const third=await client.request({...cfg,api_key:'fixture'},'getCardList',{page:1});
        assert.equal(first.status,429);assert.equal(second.status,429);assert.ok(second.retryAfterMs>0);
        assert.equal(third.status,429);assert.equal(sent.length,2);
    } finally {
        if(previous===undefined)delete process.env.ORBITCARD_API_SECRET;else process.env.ORBITCARD_API_SECRET=previous;
        if(previousKey===undefined)delete process.env.ORBITCARD_API_KEY;else process.env.ORBITCARD_API_KEY=previousKey;
    }
});

test('batch selection uses one platform snapshot and never rereads candidates before subscription',async () => {
    const f=serviceFixture(),a=await f.addCard(42),b=await f.addCard(43);
    f.setCards([{...a,status:'FROZEN',balance:50},{...b,status:'ACTIVE',balance:50}]);
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),43);
    assert.deepEqual(f.calls.filter(call=>call.operation==='cardDetail').map(call=>call.body),
        [{card_ids:[42,43],reveal_sensitive:false}]);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,0);
});

test('empty inventory or exhausted plan quota automatically opens one card with 20 USD',async () => {
    for(const setup of ['empty','exhausted']) {
        const f=serviceFixture();
        if(setup==='exhausted') {
            const card=await f.addCard(42,true,4);
            f.setCards([{...card,status:'ACTIVE',balance:50}]);
        }
        const task=await f.claim();
        const cardId=await f.service.allocate(cfg,task.jobKey,'plus');
        assert.equal(cardId,setup==='empty'?100:101);
        const opens=f.calls.filter(call=>call.operation==='createCard');
        assert.equal(opens.length,1);
        assert.deepEqual(opens[0].body,{product_code:'p1',amount:'20.00',quantity:1});
        assert.equal(f.db.issues.length,1);
        assert.equal(f.db.issues[0].job_key,task.jobKey);
        assert.equal(f.db.cards.find(card=>card.card_id===cardId).active_job,task.jobKey);
    }
});

test('unknown automatic opening stays bound to the CDK and reuses its original key and body',async () => {
    const f=serviceFixture({createCard:async () => ({success:false,status:502})});
    const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/原开卡申请仍待确认/);
    assert.equal(f.db.issues.length,1);
    assert.equal(f.db.issues[0].job_key,task.jobKey);
    const pendingCard=await f.addCard(77,false);
    f.setCards([{...pendingCard,status:'ACTIVE',balance:20}]);
    f.advance();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/原开卡申请仍待确认/);
    const calls=f.calls.filter(call=>call.operation==='createCard');
    assert.equal(calls.length,2);
    assert.equal(calls[0].key,calls[1].key);
    assert.deepEqual(calls[0].body,calls[1].body);
    assert.equal(f.db.issues.length,1);
});

test('unconfirmed imported history pauses instead of buying another card',async()=>{
    const f=serviceFixture(),card=await f.addCard(42,false);f.setCards([{...card,status:'ACTIVE'}]);
    const task=await f.claim();await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/历史次数尚未确认/);
    assert.ok(!f.calls.some(call=>['createCard','rechargeCard'].includes(call.operation)));
});

test('an original pending opening cannot be bypassed by another funded card',async()=>{
    const f=serviceFixture({createCard:async()=>({success:true,data:{order_no:'OPEN-1',status:'pending_confirm',completed:false}})});
    const task=await f.claim();await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/原开卡申请仍待确认/);
    const available=await f.addCard(42);f.setCards([{...available,status:'ACTIVE',balance:100}]);f.advance();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/原开卡申请仍待确认/);
    assert.equal(f.db.cards[0].active_job,null);assert.equal(f.db.issues.length,1);
    const requests=f.calls.filter(call=>call.operation==='createCard');
    assert.equal(requests.length,2);assert.equal(requests[0].key,requests[1].key);
});

test('a ready original opening resumes its own card without applying account threshold twice',async()=>{
    const f=serviceFixture();const task=await f.claim();
    await assert.rejects(f.service.allocate({...cfg,orbitcard_max_initial_amount:'1'},task.jobKey,'plus'),/上限/);
    const card=await f.addCard(42);f.setCards([{...card,status:'ACTIVE',balance:50}]);
    const methods=f.store.cardMethods(cfg.base_url);
    await methods.createIssue({issue_key:'original-ready',job_key:task.jobKey,plan_type:'plus',product_code:'p1',amount:'20.00',
        credential_hash:require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex'),
        request_body:JSON.stringify({product_code:'p1',amount:'20.00',quantity:1})});
    await methods.completeIssue({issue_key:'original-ready'},card);f.setAccount(0);
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.ok(!f.calls.some(call=>call.operation==='createCard'));
});

test('busy cards wait without spending; unavailable cards can trigger a new card',async () => {
    for(const setup of ['busy','frozen']) {
        const f=serviceFixture(),card=await f.addCard(42);
        f.setCards([{...card,status:setup==='frozen'?'FROZEN':'ACTIVE',balance:50}]);
        if(setup==='busy') f.db.cards[0].active_job='other';
        const task=await f.claim();
        if (setup === 'busy') {
            await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'), /其他订单占用/);
            assert.equal(f.calls.filter(call=>['createCard','rechargeCard'].includes(call.operation)).length,0);
            continue;
        }
        assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),101);
        assert.equal(f.calls.filter(call=>call.operation==='createCard').length,1);
    }
});

test('a confirmed failed card is excluded on the next platform selection',async () => {
    const f=serviceFixture(),a=await f.addCard(42),b=await f.addCard(43),c=await f.addCard(44);
    f.setCards([a,b,c].map(card=>({...card,status:'ACTIVE',balance:50})));
    const first=await f.claim();assert.equal(await f.service.allocate(cfg,first.jobKey,'plus'),42);await f.settle(first,'failed');
    const second=await f.claim();assert.equal(await f.service.allocate(cfg,second.jobKey,'plus',{excludedCardIds:[42]}),43);await f.settle(second,'failed');
    const third=await f.claim();assert.equal(await f.service.allocate(cfg,third.jobKey,'plus',{excludedCardIds:[42,43]}),44);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,0);
});

test('confirmed failed card is excluded and a new card is opened when no unused card remains',async () => {
    const f=serviceFixture(),card=await f.addCard(42);
    f.setCards([{...card,status:'ACTIVE',balance:50}]);
    const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus',{excludedCardIds:[42]}),101);
    assert.equal(f.calls.filter(call=>call.operation==='createCard').length,1);
});
