'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const createFundingService=require('../orbitcard-funding-service');
const {cardScope,CardPreparationError,FundingPendingError,FundingAwaitingError}=require('../orbitcard-card-policy');
const {PaymentStoppedError}=require('../payment-automation');

function fixture(overrides={}) {
    let clock=1000000,allowed=true;
    const cfg={base_url:'https://orbitcard.test',api_key:'fixture'};
    const funding={funding_key:'fund-original',job_key:'job-original',scope:cardScope(cfg.base_url),
        credential_hash:crypto.createHash('sha256').update(cfg.api_key).digest('hex'),card_id:42,
        amount:'16.00',target_balance:'21.00',state:'pending',order_no:'ORIGINAL',retry_at:0,
        request_body:JSON.stringify({card_id:42,amount:'16.00'})};
    const saved={...funding},calls=[],sleeps=[];
    const locked={updateFunding:async(_key,patch)=>{if(!['ready','failed'].includes(saved.state)) Object.assign(saved,patch,{retry_at:Math.max(saved.retry_at || 0,patch.retry_at || 0)});},
        deferFunding:async(_key,retryAt)=>{saved.retry_at=Math.max(saved.retry_at || 0,retryAt);},
        syncCards:async cards=>{calls.push({operation:'syncCards',cards});}};
    const api={request:async(_cfg,operation,body,key)=>{
        calls.push({operation,body,key});
        if(overrides.request)return overrides.request(operation,body,key);
        assert.equal(operation,'getCardFlow');
        return {success:true,status:200,data:{card_id:42,type:'recharge',list:[{order_no:'ORIGINAL',amount:'16.00',status:'success'}],total:1}};
    }};
    const cardsApi={cardDetail:async()=>{
        calls.push({operation:'cardDetail'});
        return overrides.cardDetail?overrides.cardDetail():{card_id:42,provider_status:'ACTIVE',currency:'USD',balance_amount:'21.00'};
    }};
    const service=createFundingService({api,cardsApi,audit(){},now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},
        assertPaymentAllowed:async()=>{if(!allowed)throw new PaymentStoppedError('stopped');},withRecoveryOwner:async()=>false});
    return {cfg,funding,saved,locked,service,calls,sleeps,now:()=>clock,advance:ms=>{clock+=ms;},stop:()=>{allowed=false;},
        confirm:(options={readOnly:true})=>service.confirm(cfg,locked,funding,options)};
}

test('read-only funding confirmation queries the exact original flow and marks ready only after sufficient balance',async()=>{
    const f=fixture();const card=await f.confirm();
    assert.equal(card.card_id,42);assert.equal(f.saved.state,'ready');
    assert.deepEqual(f.calls.map(call=>call.operation),['getCardFlow','cardDetail','syncCards']);
    assert.deepEqual(f.calls[0].body,{card_id:42,type:'recharge',page:1,page_size:100});
    assert.deepEqual(f.sleeps,[]);
});

test('read-only confirmation with no original order number never sends funding',async()=>{
    const f=fixture();f.funding.order_no=null;
    await assert.rejects(f.confirm(),error=>error instanceof FundingPendingError && !(error instanceof FundingAwaitingError));
    assert.deepEqual(f.calls,[]);
});

test('known processing funding leaves a resumable wait and honors the provider retry interval',async()=>{
    const f=fixture({request:async()=>({success:true,status:200,retryAfterMs:90000,
        data:{card_id:42,type:'recharge',list:[{order_no:'ORIGINAL',amount:'16.00',status:'processing'}],total:1}})});
    await assert.rejects(f.confirm(),error=>error instanceof FundingAwaitingError && error.retryAfterMs===90000);
    assert.equal(f.saved.state,'pending');assert.equal(f.saved.retry_at,f.now()+90000);
    assert.deepEqual(f.calls.map(call=>call.operation),['getCardFlow']);assert.deepEqual(f.sleeps,[]);
});

test('successful funding with delayed balance performs one read in background mode and then resumes on a later check',async()=>{
    let balance='5.00';
    const f=fixture({cardDetail:async()=>({card_id:42,provider_status:'ACTIVE',currency:'USD',balance_amount:balance})});
    await assert.rejects(f.confirm(),FundingAwaitingError);
    assert.equal(f.calls.filter(c=>c.operation==='cardDetail').length,1);assert.deepEqual(f.sleeps,[]);
    f.advance(5000);balance='21.00';await f.confirm();assert.equal(f.saved.state,'ready');
    assert.equal(f.calls.some(c=>c.operation==='rechargeCard'),false);
});

test('initial confirmation returns after one balance read so the caller can release the allocation lock',async()=>{
    const f=fixture({cardDetail:async()=>({card_id:42,provider_status:'ACTIVE',currency:'USD',balance_amount:'5.00'})});
    const start=f.now();await assert.rejects(f.confirm({}),FundingAwaitingError);
    assert.equal(f.now(),start);assert.deepEqual(f.sleeps,[]);
    assert.equal(f.calls.filter(call=>call.operation==='cardDetail').length,1);
    assert.equal(f.saved.retry_at,start+5000);
    assert.equal(f.saved.state,'pending');assert.equal(f.calls.some(c=>c.operation==='rechargeCard'),false);
});

test('only transient original-flow read failures can be retried automatically',async()=>{
    for(const status of [undefined,0,408,429,500,502,503]) {
        const f=fixture({request:async()=>({success:false,status,retryAfterMs:70000})});
        await assert.rejects(f.confirm(),error=>error instanceof FundingAwaitingError && error.retryAfterMs===70000);
        assert.equal(f.saved.state,'pending');assert.equal(f.calls.length,1);
    }
    for(const status of [400,401,403,404]) {
        const f=fixture({request:async()=>({success:false,status})});
        await assert.rejects(f.confirm(),error=>error instanceof FundingPendingError && !(error instanceof FundingAwaitingError));
    }
});

test('an original flow not yet visible waits without adopting unrelated successful funding',async()=>{
    const f=fixture({request:async()=>({success:true,status:200,
        data:{card_id:42,type:'recharge',list:[{order_no:'OTHER',amount:'16.00',status:'success'}],total:1}})});
    await assert.rejects(f.confirm(),FundingAwaitingError);assert.equal(f.saved.state,'pending');
    assert.equal(f.calls.some(c=>c.operation==='cardDetail'),false);
});

test('foreign or malformed funding evidence is never classified as a resumable delay',async()=>{
    const cases=[
        {card_id:43,type:'recharge',list:[],total:0},
        {card_id:42,type:'refund',list:[],total:0},
        {card_id:42,type:'recharge',list:[{order_no:'ORIGINAL',amount:'17.00',status:'success'}],total:1},
        {card_id:42,type:'recharge',list:[{order_no:'ORIGINAL',amount:'16.00',status:'success',completed:'true'}],total:1},
        {card_id:42,type:'recharge',list:[{order_no:'ORIGINAL',status:'success'}],total:1},
        {card_id:42,type:'recharge',list:[{order_no:'ORIGINAL',amount:'16.00',status:'unexpected'}],total:1}
    ];
    for(const data of cases) {
        const f=fixture({request:async()=>({success:true,status:200,data})});
        await assert.rejects(f.confirm(),error=>error instanceof CardPreparationError && !(error instanceof FundingAwaitingError));
        assert.notEqual(f.saved.state,'ready');assert.equal(f.calls.some(c=>c.operation==='cardDetail'),false);
    }
});

test('confirmed failed or refunded funding persists failure instead of waiting or submitting another payment',async()=>{
    for(const status of ['failed','refunded']) {
        const f=fixture({request:async()=>({success:true,status:200,data:{card_id:42,type:'recharge',
            list:[{order_no:'ORIGINAL',amount:'16.00',status,completed:true}],total:1}})});
        await assert.rejects(f.confirm(),error=>error instanceof CardPreparationError && !(error instanceof FundingPendingError));
        assert.equal(f.saved.state,'failed');assert.deepEqual(f.calls.map(c=>c.operation),['getCardFlow']);
    }
});

test('card data errors remain manual while transient card reads permit delayed recovery',async()=>{
    for(const patch of [{provider_status:'CANCELLED'},{currency:'EUR'},{balance_amount:null}]) {
        const f=fixture({cardDetail:async()=>({card_id:42,provider_status:'ACTIVE',currency:'USD',balance_amount:'21.00',...patch})});
        await assert.rejects(f.confirm(),error=>error instanceof FundingPendingError && !(error instanceof FundingAwaitingError));
    }
    const f=fixture({cardDetail:async()=>{throw Object.assign(new CardPreparationError('temporary read failure'),{transient:true,status:429,retryAfterMs:90000});}});
    await assert.rejects(f.confirm(),error=>error instanceof FundingAwaitingError && error.retryAfterMs===90000);
});

test('saved retry intervals and stopped payment ownership prevent any original-order query',async()=>{
    const f=fixture();f.funding.retry_at=f.now()+90000;
    await assert.rejects(f.confirm(),error=>error instanceof FundingAwaitingError && error.retryAfterMs===90000);
    assert.deepEqual(f.calls,[]);
    f.stop();await assert.rejects(f.confirm(),PaymentStoppedError);assert.deepEqual(f.calls,[]);
});

test('read-only confirmation never accepts a changed credential or funding request body',async()=>{
    for(const patch of [{credential_hash:'another-key'},{request_body:'{"card_id":42,"amount":"99.00"}'}]) {
        const f=fixture();Object.assign(f.funding,patch);
        await assert.rejects(f.confirm(),error=>error instanceof FundingPendingError && !(error instanceof FundingAwaitingError));
        assert.deepEqual(f.calls,[]);
    }
});

test('reconciliation persists the minimum cadence and longer read backoff across a restarted caller',async()=>{
    for(const mode of ['processing','card-rate-limit','flow-network']) {
        const f=fixture(mode==='processing'?{request:async()=>({success:true,status:200,data:{card_id:42,type:'recharge',
            list:[{order_no:'ORIGINAL',amount:'16.00',status:'processing'}],total:1}})}
            :mode==='card-rate-limit'?{cardDetail:async()=>{throw Object.assign(new CardPreparationError('limited'),{transient:true,status:429,retryAfterMs:90000});}}
            :{request:async()=>{throw Object.assign(new Error('network'),{code:'ECONNRESET',retryAfterMs:120000});}});
        const delay=mode==='processing'?5000:mode==='card-rate-limit'?90000:120000;
        await assert.rejects(f.confirm(),FundingAwaitingError);
        assert.equal(f.saved.retry_at,f.now()+delay);
        const count=f.calls.length;
        await assert.rejects(f.service.confirm(f.cfg,f.locked,structuredClone(f.saved),{readOnly:true}),FundingAwaitingError);
        assert.equal(f.calls.length,count,'a fresh caller must observe the persisted delay');
    }
});

test('even an already-ready funding record persists backoff if its live card read is limited',async()=>{
    const f=fixture({cardDetail:async()=>{throw Object.assign(new CardPreparationError('limited'),{transient:true,retryAfterMs:90000});}});
    f.funding.state=f.saved.state='ready';
    await assert.rejects(f.confirm(),FundingAwaitingError);
    assert.equal(f.saved.retry_at,f.now()+90000);
    assert.equal(f.saved.state,'ready');
});
