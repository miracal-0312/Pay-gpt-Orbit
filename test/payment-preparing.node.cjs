'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fixture=require('./helpers/card-db.cjs');

async function setup({card=false,funding=false,review=false,legacy=false}={}) {
    const f=fixture(),cdk='PREPARING-CDK';
    const credential=crypto.createHash('sha256').update('test-key').digest('hex');
    f.db.cdks.push({cdk_code:cdk,type:'自助',is_active:1,plan_type:'plus',used_at:null});
    const task=await f.store.createOrbitcardTask({cdk,planType:'plus',email:'customer@example.test',baseUrl:f.base,apiKeyHash:credential});
    if(legacy) f.db.tasks[0].orbitcard_state='prepared';
    const methods=f.store.cardMethods(f.base);
    const change=(orbitcardState,extra={})=>f.store.settleOrbitcardTask(task.jobKey,{
        status:'running',orbitcardState,progress:10,message:orbitcardState,
        expectedState:f.db.tasks[0].orbitcard_state,expectedClientOrderNo:task.orbitcardClientOrderNo,...extra
    });
    if(card||funding||review) {
        await f.addCard();
        await methods.reserveCard(42,task.jobKey,'plus');
    }
    if(funding||review) {
        await methods.createFunding({funding_key:'fund-original',job_key:task.jobKey,plan_type:'plus',card_id:42,
            credential_hash:credential,request_body:'{"card_id":42,"amount":"16.00"}',amount:'16.00',target_balance:'21.00000000'});
        await methods.updateFunding('fund-original',{state:'pending',order_no:'ORIGINAL-FUND'});
    }
    if(review) assert.equal((await change('funding_review')).applied,true);
    return {...f,task,methods,change,credential};
}

test('real self-service task creation starts preparing and reserves the CDK before any card action',async()=>{
    const f=await setup();
    assert.equal(f.task.orbitcardState,'preparing');
    assert.equal(f.db.tasks[0].orbitcard_state,'preparing');
    assert.ok(f.db.cdks[0].used_at);
    assert.equal(f.db.cards.length,0);assert.equal(f.db.fundings.length,0);assert.equal(f.db.issues.length,0);
});

test('preparing cannot become prepared without a ready owned card or skip directly to submission',async()=>{
    const f=await setup();
    assert.equal((await f.change('prepared')).applied,false);
    assert.equal((await f.change('submitting')).applied,false);
    await f.addCard();await f.methods.reserveCard(42,f.task.jobKey,'plus');
    assert.equal((await f.change('prepared',{expectedClientOrderNo:'wrong-order'})).applied,false);
    assert.equal((await f.change('prepared',{expectedClientOrderNo:undefined})).applied,false);
    assert.equal((await f.change('prepared')).applied,true);
    assert.equal((await f.change('submitting')).applied,true);
});

test('preparing permits original issue linkage and funding while their intent states remain prepared',async()=>{
    const f=await setup({card:true});
    const issue=await f.methods.createIssue({issue_key:'issue-original',job_key:f.task.jobKey,plan_type:'plus',product_code:'p1',
        amount:'20.00',credential_hash:f.credential,request_body:'{"product_code":"p1","amount":"20.00","quantity":1}'});
    await f.methods.attachIssue(f.task.jobKey,issue.issue_key);
    assert.equal(f.db.issues[0].state,'prepared');
    assert.equal((await f.change('prepared')).applied,false);
    await f.methods.updateIssue(issue.issue_key,{state:'ready',card_id:42});
    await f.methods.createFunding({funding_key:'fund-original',job_key:f.task.jobKey,plan_type:'plus',card_id:42,
        credential_hash:f.credential,request_body:'{"card_id":42,"amount":"16.00"}',amount:'16.00',target_balance:'21.00000000'});
    assert.equal(f.db.fundings[0].state,'prepared');
    assert.equal((await f.change('prepared')).applied,false);
    await f.methods.updateFunding('fund-original',{state:'ready',order_no:'ORIGINAL-FUND'});
    assert.equal((await f.change('prepared')).applied,true);
});

test('historical prepared tasks retain their ability to reserve and fund a card',async()=>{
    const f=await setup({legacy:true,funding:true});
    assert.equal(f.db.tasks[0].orbitcard_state,'prepared');
    assert.equal(f.db.cards[0].active_job,f.task.jobKey);
    assert.equal(f.db.fundings[0].state,'pending');
});

test('a preparing task rejected before a money intent releases its card and CDK together',async()=>{
    const f=await setup({card:true});
    assert.equal((await f.change('rejected',{status:'failed'})).applied,true);
    assert.equal(f.db.cdks[0].used_at,null);assert.equal(f.db.cards[0].active_job,null);
    assert.equal(f.db.uses[0].state,'released');
});

test('funding wait cannot become prepared until its original funding is ready',async()=>{
    const f=await setup({funding:true});
    assert.equal((await f.change('funding_waiting')).applied,true);
    assert.equal((await f.change('prepared')).applied,false);
    await f.methods.updateFunding('fund-original',{state:'ready'});
    assert.equal((await f.change('prepared')).applied,true);
});

test('funding review is a manual ticket and cannot reopen automatic payment or release an unresolved debit',async()=>{
    const f=await setup({review:true});
    assert.equal(f.db.tasks[0].status,'manual');
    for(const state of ['preparing','prepared','submitting','pending','success','failed','rejected']) {
        assert.equal((await f.change(state)).applied,false,state);
    }
    assert.equal(f.db.tasks[0].orbitcard_state,'funding_review');
    assert.ok(f.db.cdks[0].used_at);assert.equal(f.db.cards[0].active_job,f.task.jobKey);
});

test('funding review releases only a confirmed ready or failed original funding with explicit ownership',async()=>{
    for(const state of ['ready','failed']) {
        const f=await setup({review:true});await f.methods.updateFunding('fund-original',{state});
        assert.equal((await f.change('rejected',{expectedClientOrderNo:undefined})).applied,false);
        assert.equal((await f.change('rejected',{expectedClientOrderNo:'wrong-order'})).applied,false);
        assert.equal((await f.change('rejected',{status:state==='ready'?'retry':'failed'})).applied,true);
        assert.equal(f.db.cdks[0].used_at,null);assert.equal(f.db.cards[0].active_job,null);
        assert.equal(f.db.uses[0].state,'released');
    }
});

test('funding review rejects release when original funding or card ownership no longer matches',async()=>{
    for(const mismatch of ['scope','plan','credential','card','reservation','manual-redemption']) {
        const f=await setup({review:true});await f.methods.updateFunding('fund-original',{state:'ready'});
        if(mismatch==='scope') f.db.fundings[0].scope='other-platform';
        if(mismatch==='plan') f.db.fundings[0].plan_type='pro100';
        if(mismatch==='credential') f.db.fundings[0].credential_hash='different-account';
        if(mismatch==='card') f.db.fundings[0].card_id=99;
        if(mismatch==='reservation') f.db.cards[0].active_job='another-job';
        if(mismatch==='manual-redemption') f.db.cdks[0].manual_redeemed_at='2026-11-10';
        assert.equal((await f.change('rejected',{status:'retry'})).applied,false,mismatch);
        assert.equal(f.db.tasks[0].orbitcard_state,'funding_review');assert.ok(f.db.cdks[0].used_at);
    }
});

test('funding review release rolls back when card release fails',async()=>{
    const f=await setup({review:true});await f.methods.updateFunding('fund-original',{state:'ready'});
    f.db.failRelease=true;
    await assert.rejects(f.change('rejected',{status:'retry'}),/injected card release/);
    assert.equal(f.db.tasks[0].orbitcard_state,'funding_review');assert.equal(f.db.tasks[0].status,'manual');
    assert.ok(f.db.cdks[0].used_at);assert.equal(f.db.cards[0].active_job,f.task.jobKey);
});

test('a review mismatch can tighten into manual funding_pending without releasing funds or card',async()=>{
    const f=await setup({review:true});
    assert.equal((await f.change('funding_pending')).applied,true);
    assert.equal(f.db.tasks[0].status,'manual');assert.equal(f.db.tasks[0].orbitcard_state,'funding_pending');
    assert.ok(f.db.cdks[0].used_at);assert.equal(f.db.cards[0].active_job,f.task.jobKey);
    assert.equal((await f.change('prepared')).applied,false);
});

test('a preparing selection failure can enter support without pretending funds are prepared',async()=>{
    const f=await setup({card:true});
    assert.equal((await f.store.lockOrbitcardSupport(f.task.jobKey,'preparing','selection failed',{cardSelectionExhausted:true})).applied,true);
    assert.equal(f.db.tasks[0].orbitcard_state,'support_locked');assert.ok(f.db.cdks[0].used_at);
    assert.equal(f.db.cards[0].active_job,null);
});
