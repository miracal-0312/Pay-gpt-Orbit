'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const policy=require('../orbitcard-pool');
const {AccountBalanceError}=require('../orbitcard-card-policy');
const fixture=require('./helpers/card-db.cjs');
function load(name,mocks) {
    const filename=path.resolve(__dirname,'..',name), real=createRequire(filename), module={exports:{}};
    new Function('require','module','exports',fs.readFileSync(filename,'utf8'))(id=>mocks[id]||real(id),module,module.exports);
    return module.exports;
}
const cfg={enabled:true,base_url:'https://orbitcard.test',api_key:'test',
    orbitcard_max_authorizations:7,
    orbitcard_plan_prices:{plus:'20.00',pro100:'100.00',pro200:'200.00',pro500:'500.00'}};
const authorization=(id,card_id=42)=>({transaction_id:String(id),card_id,transaction_type:'Authorization',status:'approved',authorization_amount:'-15.54'});
const settlement=(id,card_id=42)=>({...authorization(id,card_id),transaction_type:'Settlement'});
async function setup(counts=[0,0,0,0,0],overrides={}) {
    let clock=Date.now(), next=100;
    const f=fixture({now:()=>clock}), calls=[], remote=[], ledger=new Map();
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
    return {...f,service,calls,remote,ledger,advance(ms=120000){clock+=ms;}};
}

test('a verified card failure disables the original card and opens one durable replacement', async () => {
    const f = await setup([200]), task = await f.claim();
    assert.equal(await f.service.allocate(cfg, task.jobKey, 'plus'), 42);
    await f.settle(task, 'submitting');
    const failure = { task_no: 'failed-card-order', client_order_no: task.orbitcardClientOrderNo,
        card_id: 42, plan_type: 'gpt-plus', query_source: 'upstream', status: 'failed',
        subscription_succeeded: false, failureCode: 'card_declined', failureMessage: 'Your card was declined' };
    await f.store.recordOrbitcardPaymentFailure(task.jobKey, { clientOrderNo: task.orbitcardClientOrderNo,
        cardId: 42, orderId: failure.task_no, raw: JSON.stringify(failure) });
    assert.ok(f.db.cards[0].disabled_at);
    assert.equal(f.db.cards[0].disabled_code, 'card_declined');
    assert.equal(f.db.cards[0].active_job, null);
    await f.service.synchronize(cfg);
    assert.ok(f.db.cards[0].disabled_at, 'provider ACTIVE synchronization preserves the local disable marker');
    const next = await f.claim();
    const readyConfig = { ...cfg, orbitcard_plan_prices: { ...cfg.orbitcard_plan_prices, plus: '19.00' } };
    assert.equal(await f.service.allocate(readyConfig, next.jobKey, 'plus', { excludedCardIds: [42] }), 100);
    await f.service.recover(cfg);
    await f.service.recover(cfg);
    assert.equal(f.db.issues.length, 1);
    assert.equal(f.db.issues[0].replacement_for_card_id, 42);
    assert.equal(f.calls.filter(call => call.operation === 'createCard').length, 1);
    assert.equal(f.calls.filter(call => call.operation === 'deleteCard').length, 0);
    await f.store.cardMethods(cfg.base_url).setCardAvailability(42, false, '人工核对后恢复');
    const restored = await f.claim();
    assert.equal(await f.service.allocate(cfg, restored.jobKey, 'plus'), 42);
    await f.settle(restored, 'submitting');
    const repeatedFailure = { ...failure, task_no: 'second-card-order', client_order_no: restored.orbitcardClientOrderNo };
    await f.store.recordOrbitcardPaymentFailure(restored.jobKey, { clientOrderNo: restored.orbitcardClientOrderNo,
        cardId: 42, orderId: repeatedFailure.task_no, raw: JSON.stringify(repeatedFailure) });
    await f.service.recover(cfg);
    assert.equal(f.db.issues.length, 2, 'a new failure after manual restoration receives its own replacement');
});

test('unknown replacement results recover with the original product, body and key', async () => {
    let unavailable = true;
    const f = await setup([0], { createCard: async () => unavailable ? { success: false, status: 502 } : null });
    Object.assign(f.db.cards[0], { disabled_at: new Date().toISOString(), disabled_code: 'card_declined' });
    await f.service.recover(cfg);
    assert.equal(f.db.issues.length, 1);
    unavailable = false;
    f.advance();
    await f.service.recover(cfg);
    const calls = f.calls.filter(call => call.operation === 'createCard');
    assert.equal(f.db.issues.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, calls[1].key);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(f.db.issues[0].state, 'ready');
});

test('manual disable and restore persist across synchronization and serialize with reservations', async () => {
    const f = await setup([999]), methods = f.store.cardMethods(cfg.base_url);
    await methods.setCardAvailability(42, true, '人工核对中');
    await f.service.synchronize(cfg);
    await f.service.recover(cfg);
    assert.equal(f.db.cards[0].disabled_code, 'manual');
    assert.equal(f.calls.filter(call => call.operation === 'createCard').length, 0);
    const task = await f.claim();
    assert.equal(await methods.reserveCard(42, task.jobKey, 'plus'), null);
    await methods.setCardAvailability(42, false, '已确认可用');
    assert.ok(await methods.reserveCard(42, task.jobKey, 'plus'));
    await assert.rejects(methods.setCardAvailability(42, true, '再次停用'), /订单占用/);
    assert.equal(f.db.cards[0].disabled_at, null);
});

test('only card-related verified terminal failures produce a disable reason', () => {
    const { cardFailure } = require('../orbitcard-card-failure');
    for (const failureCode of ['card_declined', 'expired_card', 'insufficient_funds', 'incorrect_cvc']) {
        assert.ok(cardFailure({ failureCode }));
    }
    assert.ok(cardFailure({ failureCode: 'provider_error', failureMessage: '支付卡已过期' }));
    for (const failureMessage of ['Session 已过期', '网络请求超时', '需要完成人机验证', '地区暂不可用']) {
        assert.equal(cardFailure({ failureCode: 'request_failed', failureMessage }), null);
    }
});
test('availability ignores historical counts and rejects disabled or retiring cards', () => {
    for (const successful_order_count of [0, 4, 7, 999, null, undefined]) assert.equal(policy.eligible({successful_order_count}), true);
    assert.equal(policy.eligible({disabled_at:'2026-11-16'}), false);
    assert.equal(policy.eligible({retirement_key:'pending'}), false);
});

test('legacy limit values cannot change the availability decision', () => {
    for (const limit of [0, 1, 4, 99, null]) {
        assert.equal(policy.eligible({successful_order_count:999},limit),true);
        assert.equal(policy.eligible({disabled_at:'2026-11-16'},limit),false);
    }
});

test('historical limits cannot block selection or transactional reservation',async()=>{
    const f=await setup([8]),task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(await f.service.allocate({...cfg,orbitcard_max_authorizations:10},task.jobKey,'plus'),42);
    assert.equal(f.db.cards[0].active_job,task.jobKey);
    const other=await setup([3]),otherTask=await other.claim(),methods=other.store.cardMethods(cfg.base_url);
    assert.ok(await methods.reserveCard(42,otherTask.jobKey,'plus',3));
    assert.ok(await methods.reserveCard(42,otherTask.jobKey,'plus',4));
});

test('maintenance only completes explicit persisted retirement intents',async()=>{
    const lower=await setup([2,3,8]);
    await lower.service.synchronize({...cfg,orbitcard_max_authorizations:3});
    assert.deepEqual(lower.calls.filter(call=>call.operation==='deleteCard').map(call=>call.body.card_id),[]);
    const raising=await setup([3,8]);
    const key=`retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-prepared`;
    await raising.store.cardMethods(cfg.base_url).retireCard(42,key);
    await raising.service.synchronize({...cfg,orbitcard_max_authorizations:20});
    assert.deepEqual(raising.calls.filter(call=>call.operation==='deleteCard').map(call=>call.body.card_id),[42]);
    assert.equal(raising.remote.find(card=>card.card_id===43).status,'ACTIVE');
});

test('twenty concurrent allocation requests reserve five distinct cards without replacement writes', async () => {
    const f = await setup([0, 0, 0, 0, 0], { getCardList: async () => {
        await new Promise(resolve => setImmediate(resolve));
    } });
    const tasks = [];
    for (let index = 0; index < 20; index++) tasks.push(await f.claim());
    const results = await Promise.allSettled(tasks.map(task => f.service.allocate(cfg, task.jobKey, 'plus')));
    const assigned = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const waiting = results.filter(result => result.status === 'rejected');
    assert.equal(assigned.length, 5); assert.equal(new Set(assigned).size, 5);
    assert.equal(waiting.length, 15);
    assert.ok(waiting.every(result => /支付卡正在使用/.test(result.reason.message)));
    assert.equal(new Set(f.db.cards.map(card => card.active_job)).size, 5);
    assert.equal(f.db.uses.filter(use => use.state === 'reserved').length, 5);
    assert.ok(f.calls.every(call => !['createCard', 'rechargeCard', 'createSubscription'].includes(call.operation)));
});

test('a synchronized authorization permits immediate reuse using the live balance',async()=>{
    const f=await setup();
    const first=await f.claim();assert.equal(await f.service.allocate(cfg,first.jobKey,'plus'),42);
    await f.settle(first,'success');
    f.ledger.get(42).push(authorization('new'));
    // The platform still reports the pre-payment card balance.
    const second=await f.claim();assert.equal(await f.service.allocate(cfg,second.jobKey,'plus'),42);
    assert.equal(f.db.cards[0].successful_order_count,1);
    assert.equal(f.remote[0].balance,100);
    assert.equal(f.calls.filter(c=>['rechargeCard','createCard'].includes(c.operation)).length,0);
});

test('historical future cooldown timestamps do not block live card selection',async()=>{
    const f=await setup();
    for(const card of f.db.cards)card.reuse_after_ms=Date.now()+600000;
    const next=await f.claim(),before=f.calls.length;
    f.remote[0].balance=1;
    assert.equal(await f.service.allocate(cfg,next.jobKey,'plus'),43);
    assert.equal(f.calls.slice(before).filter(c=>['rechargeCard','createCard'].includes(c.operation)).length,0);
});

test('platform-confirmed success permits immediate reuse without authorization synchronization',async()=>{
 const f=await setup([0]),first=await f.claim();await f.service.allocate(cfg,first.jobKey,'plus');await f.settle(first,'success');
 f.db.cards[0].authorization_pending_count=99;const next=await f.claim();assert.equal(await f.service.allocate(cfg,next.jobKey,'plus'),42);
 assert.equal(f.db.cards[0].successful_order_count,1);assert.equal(f.calls.filter(c=>c.operation==='cardTransaction').length,0);
});

test('queued requests continue after original settlement without waiting for authorizations',async()=>{
 const f=await setup([0]),first=await f.claim(),next=await f.claim();await f.service.allocate(cfg,first.jobKey,'plus');
 await assert.rejects(f.service.allocate(cfg,next.jobKey,'plus'),require('../orbitcard-card-policy').CardBusyError);
 await f.settle(first,'success');assert.equal(await f.service.allocate(cfg,next.jobKey,'plus',{waitForAvailability:true}),42);assert.equal(f.db.cards[0].successful_order_count,1);
});

test('a busy card remains a waiting candidate alongside another card with unknown provider status',async()=>{
    const {CardBusyError}=require('../orbitcard-card-policy');
    const f=await setup([0,0]),task=await f.claim();
    f.db.cards[0].active_job='manual-existing';f.remote[1].status='UNRECOGNIZED';
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),CardBusyError);
    f.remote[0].status='DELETED';f.db.cards[0].active_job=null;
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),error=>!(error instanceof CardBusyError));
    assert.equal(f.calls.filter(call=>['createCard','rechargeCard'].includes(call.operation)).length,0);
});

test('a settled card with delayed authorization never causes opening while another funded card is usable',async()=>{
    const f=await setup([0,0]),first=await f.claim();
    assert.equal(await f.service.allocate(cfg,first.jobKey,'plus'),42);await f.settle(first,'success');f.advance(300000);
    const next=await f.claim();assert.equal(await f.service.allocate(cfg,next.jobKey,'plus'),42);
    assert.equal(f.calls.filter(call=>['createCard','rechargeCard'].includes(call.operation)).length,0);
    assert.equal(f.db.cards[0].successful_order_count,1);
});

test('frozen idle cards with pending authorizations cannot cause automatic opening',async()=>{
    const f=await setup([0]); f.remote[0].status='FROZEN'; f.db.cards[0].authorization_pending_count=1;
    const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/没有可用|原开卡/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);

});

test('a confirmed frozen idle card does not need payment details when automatic opening is disabled',async()=>{
    const f=await setup([0],{cardDetail:async()=>{throw Error('must not read frozen details');}}); f.remote[0].status='CANCELLED';
    const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/没有可用|原开卡/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);

});

test('unresolved owners and original ownership still prevent replacement of a frozen card',async()=>{
    for(const owner of ['other','self']) {
        const f=await setup([0]),task=await f.claim();f.remote[0].status='CANCELLED';
        await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
        if(owner==='other') f.db.cards[0].active_job='other-job';
        f.db.cards[0].authorization_pending_count=1;
        await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),owner==='other'?/正在使用/:/已预占/);
        assert.equal(f.calls.filter(call=>['createCard','rechargeCard','deleteCard'].includes(call.operation)).length,0);
    }
});

test('an unrelated issue does not block an available existing card',async()=>{
    const f=await setup([0]);f.db.cards[0].authorization_pending_count=1;
    f.db.issues.push({issue_key:'unresolved-opening',scope:f.scope,job_key:'other-job',plan_type:'pro100',state:'unknown'});
    const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.calls.filter(call=>['createCard','rechargeCard'].includes(call.operation)).length,0);
});

test('unknown platform status still waits while order counts do not gate availability', () => {
    const {decideCards}=require('../orbitcard-payment-decision');
    const card={card_id:42,provider_status:'ACTIVE',product_code:'p1',currency:'USD',balance_amount:'20.00'};
    const input={saved:[{card_id:42,successful_order_count:null}],listed:[card],detailed:[card],products:[{product_code:'p1',min_retained_balance:'0'}],jobKey:'new-job',planType:'plus',priceFor:()=>'20'};
    assert.equal(decideCards(input).action,'pay');
    input.listed=[{...card,provider_status:'UNKNOWN'}];input.detailed=[];
    assert.equal(decideCards(input).waiting[0].reason,'status_unconfirmed');
});

test('selection matches each product reserve and excludes prior, busy and disabled cards',()=>{
    const {decideCards}=require('../orbitcard-payment-decision'),money=require('../orbitcard-money');
    const listed=[41,42,43,44,45].map(card_id=>({card_id,provider_status:'ACTIVE',currency:'USD',
        product_code:card_id===41?'higher-reserve':'no-reserve',balance_amount:'20.00'}));
    const saved=listed.map(card=>({card_id:card.card_id,successful_order_count:card.card_id===45?4:0,
        disabled_at:card.card_id===45?'2026-11-16':null, active_job:card.card_id===44?'other-order':null}));
    const decision=decideCards({saved,listed,detailed:[...listed].reverse(),jobKey:'new-job',planType:'plus',
        products:[{product_code:'no-reserve',min_retained_balance:'0.00'},
            {product_code:'higher-reserve',min_retained_balance:'8.00'}],
        excludedCardIds:['42'],priceFor:()=>'16.00'});
    assert.equal(decision.action,'pay');
    assert.deepEqual(decision.candidates.map(candidate=>candidate.card.card_id),[43,41]);
    assert.equal(decision.candidates[1].target,money.units('24.00'));
    assert.equal(decision.candidates[1].deficit,money.units('4.00'));
    assert.ok(decision.skipped.some(card=>card.card_id===42 && card.reason==='previous_payment_attempt'));
    assert.ok(decision.skipped.some(card=>card.card_id===45 && card.reason==='card_error_disabled'));
    assert.deepEqual(decision.waiting,[{card_id:44,reason:'busy'}]);
});

test('allocation uses an existing funded card without requiring money to fill the pool',async()=>{
    const f=await setup([0],{getAccountBalance:async()=>({success:true,data:{available_balance:'0.00'}})});
    const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.remote.length,1);
    assert.equal(f.calls.filter(c=>['getAccountBalance','createCard','rechargeCard','deleteCard'].includes(c.operation)).length,0);
});

test('insufficient account money rejects the exact card deficit before creating a funding intent',async()=>{
    const f=await setup([0],{getAccountBalance:async()=>({success:true,data:{available_balance:'0.50'}})});
    f.remote[0].balance='20.00';
    const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),error=>{
        assert.ok(error instanceof AccountBalanceError);
        assert.match(error.message,/可用 0\.50000000 USD/);
        assert.match(error.message,/所需 1\.00000000 USD/);
        assert.doesNotMatch(error.message,/锁定/);
        return true;
    });
    assert.equal(f.db.tasks.find(row=>row.job_key===task.jobKey).orbitcard_state,'prepared');
    assert.equal(f.db.fundings.length,0);
    assert.equal(f.calls.filter(c=>['createCard','rechargeCard','deleteCard'].includes(c.operation)).length,0);
});

test('allocation rejects an empty pool without opening cards',async()=>{
    const f=await setup([]);
    const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/没有可用|原开卡/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.equal(f.db.issues.length,0);
});

test('allocation cannot open around an unresolved card issue belonging to another plan',async()=>{
    for(const [pendingPlan,currentPlan] of [['pro100','plus'],['plus','pro100']]) {
        for(const state of ['prepared','submitting','pending','unknown']) {
            const f=await setup([]),task=await f.claim(currentPlan);
            f.db.issues.push({issue_key:'other-plan-issue',scope:f.scope,job_key:'other-job',plan_type:pendingPlan,state});
            await assert.rejects(f.service.allocate(cfg,task.jobKey,currentPlan),/没有可用|原开卡/);
            assert.equal(f.calls.filter(c=>['getAccountBalance','createCard','rechargeCard'].includes(c.operation)).length,0);
            assert.equal(f.db.issues.length,1);
        }
    }
});

test('allocation reuses high-count healthy cards without opening replacements',async()=>{
    const f=await setup([7,7,7,7,7]);
    const task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);
});

test('a sparse busy pool waits while legacy cooldown metadata does not block allocation',async()=>{
    for(const state of ['busy','cooldown']) {
        const f=await setup([0]);
        if(state==='busy') f.db.cards[0].active_job='another-job';
        else f.db.cards[0].reuse_after_ms=Date.now()+600000;
        const task=await f.claim();
        if(state==='busy')await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),require('../orbitcard-card-policy').CardBusyError);
        else assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
        assert.equal(f.calls.filter(c=>['createCard','deleteCard','rechargeCard'].includes(c.operation)).length,0);
    }
});
test('synchronization preserves healthy cards at seven and six confirmed uses',async()=>{
    const f=await setup([7,6,0,0,0]);await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
    assert.equal(f.db.cards.find(c=>c.card_id===43).successful_order_count,6);
    await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
});

test('authorization history does not affect card availability',async()=>{
const f=await setup([0]);f.ledger.set(42,Array.from({length:8},(_,i)=>authorization(i)));await f.service.transactions(cfg,42);await f.service.synchronize(cfg);
 assert.equal(f.db.cards[0].authorization_count,8);assert.equal(f.db.cards[0].successful_order_count,0);assert.equal(policy.eligible(f.db.cards[0]),true);assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);
});

test('the seventh confirmed subscription remains reusable after repeated synchronization',async()=>{
const f=await setup([6]);const task=await f.claim();await f.service.allocate(cfg,task.jobKey,'plus');await Promise.all([f.settle(task,'success'),f.settle(task,'success')]);
 assert.equal(f.db.cards[0].successful_order_count,7);assert.equal(f.db.cards[0].authorization_count,6);await f.service.synchronize(cfg);await f.service.synchronize(cfg);
 assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);assert.equal(f.calls.filter(c=>c.operation==='cardTransaction').length,0);
});

test('empty and sparse pools never open or fund cards across concurrent background synchronizations',async()=>{
    for(const count of [0,1,4]) {
        const f=await setup(Array(count).fill(0));
        await Promise.all([f.service.synchronize(cfg),f.service.synchronize(cfg)]);
        await f.service.recover(cfg);
        await f.service.synchronize(cfg);
        assert.equal(f.calls.filter(c=>['createCard','rechargeCard','getAccountBalance','getProductCode'].includes(c.operation)).length,0);
        assert.equal(f.remote.length,count);
        assert.equal(f.db.issues.length,0);
    }
});
test('busy and released high-count cards are preserved during maintenance',async()=>{
    const f=await setup([7,0,0,0,0]);f.db.cards[0].active_job='unresolved';
    await f.service.synchronize(cfg);assert.equal(f.calls.filter(c=>['deleteCard','createCard'].includes(c.operation)).length,0);
    f.db.cards[0].active_job=null;await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,5);
});
test('delete timeout uses readonly recovery and confirms deletion without opening a replacement',async()=>{
    const f=await setup([7,0,0,0,0],{deleteCard:async()=>({success:false})});
    await f.store.cardMethods(cfg.base_url).retireCard(42, `retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-legacy`);
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
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,4);
});
test('background recovery confirms an existing opening with the original identity without replenishing',async()=>{
    let fail=true;const f=await setup([],{createCard:async()=>fail?{success:false,status:502}:null});
    await assert.rejects(f.service.apply(cfg));assert.equal(f.db.issues.length,1);
    fail=false;f.advance();await f.service.recover(cfg);await f.service.synchronize(cfg);
    const calls=f.calls.filter(c=>c.operation==='createCard');assert.equal(calls.length,2);
    assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);assert.equal(f.remote.length,1);
    assert.equal(f.db.issues.length,1);
});

test('confirmed deletion recovers before an expired transaction endpoint can block synchronization',async()=>{
    let deleted=false;
    const f=await setup([7,0,0,0,0],{
        deleteCard:async()=>{deleted=true;return {success:false};},
        cardDetail:async body=>deleted&&body.card_id===42
            ?{success:true,data:{card_id:42,status:'DELETED',product_code:'p1',currency:'USD'}}:null,
        cardTransaction:async body=>deleted&&body.card_id===42?{success:false,status:404}:null
    });
    await f.store.cardMethods(cfg.base_url).retireCard(42, `retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-legacy`);
    await assert.rejects(f.service.synchronize(cfg));
    assert.equal(f.db.cards[0].retirement_state,'unknown');
    // getCardList still contains this card; only cardDetail reveals its deletion.
    const before=f.calls.length;
    await f.service.synchronize(cfg);
    assert.equal(f.db.cards[0].retirement_state,'confirmed');
    assert.ok(!f.calls.slice(before).some(c=>c.operation==='cardTransaction'&&c.body.card_id===42));
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,1);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.equal(f.db.cards.filter(c=>c.provider_status!=='DELETED').length,4);
});

test('allocation never opens a replacement while a deletion awaits maintenance',async()=>{
    const f=await setup([7],{deleteCard:async()=>({success:false})});
    await f.store.cardMethods(cfg.base_url).retireCard(42, `retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-legacy`);
    await assert.rejects(f.service.synchronize(cfg));const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/没有可用|原开卡/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.equal(f.db.cards[0].retirement_state,'unknown');
});

test('a pending deletion with an expired transaction API does not block another funded card',async()=>{
    let deleted=false;
    const f=await setup([7,0],{
        deleteCard:async()=>{deleted=true;return {success:false};},
        cardTransaction:async body=>deleted&&body.card_id===42?{success:false,status:404}:null
    });
    await f.store.cardMethods(cfg.base_url).retireCard(42, `retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-legacy`);
    await assert.rejects(f.service.synchronize(cfg));
    const before=f.calls.length,task=await f.claim();
    assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),43);
    assert.equal(f.calls.slice(before).filter(c=>c.operation==='cardTransaction'&&c.body.card_id===42).length,0);
    assert.equal(f.calls.slice(before).filter(c=>['deleteCard','createCard'].includes(c.operation)).length,0);
});
test('changed credential cannot resume an existing retirement',async()=>{
    const f=await setup([7,0,0,0,0],{deleteCard:async()=>({success:false})});
    await f.store.cardMethods(cfg.base_url).retireCard(42, `retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-legacy`);
    await assert.rejects(f.service.synchronize(cfg));
    const before=f.calls.filter(c=>c.operation==='deleteCard').length;
    await assert.rejects(f.service.synchronize({...cfg,api_key:'different'}),/API Key/);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,before);
});
test('missing card after unknown delete requires confirmed DELETED detail without replacement',async()=>{
    let hidden=false;
    const f=await setup([7,0,0,0,0],{
        deleteCard:async()=>{hidden=true;return {success:false};},
        getCardList:async(body,key,remote)=>hidden?{success:true,data:{list:remote.slice(1),total:remote.length-1}}:null
    });
    await f.store.cardMethods(cfg.base_url).retireCard(42, `retire-${require('node:crypto').createHash('sha256').update(cfg.api_key).digest('hex').slice(0,16)}-legacy`);
    await assert.rejects(f.service.synchronize(cfg));
    await assert.rejects(f.service.synchronize(cfg),/删除仍未确认/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    f.remote[0].status='DELETED';await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
});
test('transaction API failures do not block card metadata or confirmed-order maintenance',async()=>{
const f=await setup([7,0],{cardTransaction:async()=>{throw Error('unavailable');}});await f.service.synchronize(cfg);
 assert.equal(f.db.cards[0].successful_order_count,7);assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);assert.equal(f.calls.filter(c=>c.operation==='cardTransaction').length,0);
});

test('unknown order counts remain statistics and cannot trigger lifecycle writes',async()=>{
    const f=await setup([0,0,0,0]);f.db.cards[0].successful_order_count=null;
    f.ledger.set(42,[{...authorization(1),status:17}]);
    await f.service.synchronize(cfg);
    assert.equal(f.db.cards[0].successful_order_count,null);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('viewing transactions imports external successful authorizations without double counting their settlement',async()=>{
    const f=await setup([0]);
    f.ledger.set(42,[authorization(1),settlement(1)]);
    const result=await f.service.transactions(cfg,42);
    assert.equal(result.authorization_count,1);assert.equal(result.availability_basis,'card_errors');
    assert.equal(result.transactions.length,2);assert.equal(f.db.cards[0].successful_order_count,0);
    await f.service.transactions(cfg,42);
    assert.equal(f.db.cards[0].successful_order_count,0);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('disabled configuration imports authorization counts without opening or deleting',async()=>{
    const f=await setup([7]);await f.service.synchronize({...cfg,enabled:false});
    assert.equal(f.db.cards[0].successful_order_count,7);
    assert.equal(f.calls.filter(c=>['createCard','deleteCard'].includes(c.operation)).length,0);
});
test('synchronization preserves large pools and high-count cards',async()=>{
    const f=await setup([6,1,0,0,0,0,0,7]);f.remote[0].status='CANCELLED';
    await f.service.synchronize(cfg);
    assert.equal(f.remote.filter(c=>c.status!=='DELETED').length,8);
    assert.equal(f.remote[0].status,'CANCELLED');
    assert.deepEqual(f.calls.filter(c=>c.operation==='deleteCard').map(c=>c.body.card_id),[]);
    assert.equal(f.calls.filter(c=>['freezeCard','createCard'].includes(c.operation)).length,0);
});

test('allocation ignores historical order counts and obsolete activation counters',async()=>{
    const f=await setup([6,0,0,0,0]);f.db.cards[0].activation_count=99;
    const task=await f.claim();assert.equal(await f.service.allocate(cfg,task.jobKey,'plus'),42);
    assert.equal(f.db.cards[0].successful_order_count,6);assert.equal(f.db.cards[0].active_job,task.jobKey);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);
    assert.ok(!f.calls.some(call=>call.operation==='cardTransaction'));
});

test('settled authorizations remain counted and later distinct authorizations still increase the total',async()=>{
    const f=await setup([0]);f.ledger.set(42,[authorization('A')]);
    await f.service.transactions(cfg,42);assert.equal(f.db.cards[0].authorization_count,1);
    f.ledger.set(42,[settlement('A'),authorization('B')]);
    await f.service.transactions(cfg,42);assert.equal(f.db.cards[0].authorization_count,2);
    f.ledger.set(42,[settlement('A'),settlement('B')]);
    await f.service.transactions(cfg,42);assert.equal(f.db.cards[0].authorization_count,2);
});

test('manual application opens exactly one card and synchronization does not fill remaining slots',async()=>{
    const f=await setup([]);
    assert.equal((await f.service.apply(cfg)).card_id,100);
    await f.service.synchronize(cfg);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,1);
    assert.equal(f.remote.length,1);
    assert.equal(f.db.issues.length,1);
});

test('manual requests can each open one card beyond five without synchronization trimming them',async()=>{
    const f=await setup(Array(6).fill(0));
    await f.service.apply(cfg);await f.service.apply(cfg);await f.service.synchronize(cfg);
    assert.equal(f.remote.length,8);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,2);
    assert.equal(f.calls.filter(c=>c.operation==='deleteCard').length,0);
});

test('an order cannot open around any number of inactive cards',async()=>{
    const f=await setup(Array(6).fill(0)); for(const card of f.remote)card.status='CANCELLED';
    const task=await f.claim();
    await assert.rejects(f.service.allocate(cfg,task.jobKey,'plus'),/没有可用|原开卡/);
    assert.equal(f.calls.filter(c=>c.operation==='createCard').length,0);

});
