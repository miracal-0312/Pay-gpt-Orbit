'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const createService=require('../orbitcard-manual-service');
const createStore=require('../orbitcard-manual-store');
const {cardScope,FundingAwaitingError,FundingPendingError,CardPreparationError,AccountBalanceError,FUNDING_POLL_MS,FUNDING_WAIT_MS}=require('../orbitcard-card-policy');
const {PaymentStoppedError}=require('../payment-automation');
const providerHelpers=require('../orbitcard-client');
const id='17aad0bb-5eb7-4771-93f5-1ebd049b29e0';

function fixture({confirm,waitMs=FUNDING_WAIT_MS,sleepHook,initialDelay=FUNDING_POLL_MS}={}) {
    process.env.ORBITCARD_API_SECRET='fixture-secret';
    let clock=Date.now(),order=null,fundingState='pending';
    const calls=[],waits=[],activeJobs=new Set(),session={user:{email:'buyer@example.test'},account:{},accessToken:'private-session'};
    const cfg={enabled:true,base_url:'https://orbitcard.test',api_key:'fixture',orbitcard_plan_prices:{plus:'20.00'}};
    const clone=value=>value==null?value:structuredClone(value);
    const store={...require('./helpers/payment-locks.cjs')(),getGptApiConfig:async()=>cfg,getMaxConcurrentActivations:async()=>5,
        assertPaymentAllowed:async()=>{if(!order || !['preparing','funding_waiting','prepared','submitting','pending'].includes(order.state))throw new PaymentStoppedError('stopped');},
        assertFundingReconciliationAllowed:async()=>{if(!order || !['funding_waiting','funding_review','funding_pending'].includes(order.state))throw new PaymentStoppedError('stopped');},
        getManualOrder:async()=>clone(order),listManualOrders:async()=>order?[clone(order)]:[],
        listRecoverableManualOrders:async()=>order?[clone(order)]:[],noteManualQueryAttempt:async()=>{},
        prepareManualOrder:async input=>{
            order={request_id:input.requestId,client_order_no:`manual-${input.requestId}`,scope:cardScope(input.baseUrl),
                api_key_hash:input.apiKeyHash,plan_type:input.planType,plan_name:input.planName,target_email:input.targetEmail,
                card_id:42,mode:input.mode,cdk_code:input.cdkCode,state:'preparing'};return clone(order);
        },
        waitManualFunding:async(_id,key,message)=>{assert.equal(key,order.client_order_no);assert.ok(['preparing','funding_waiting'].includes(order.state));order.state='funding_waiting';order.message=message;return clone(order);},
        reviewManualFunding:async(_id,key,message)=>{assert.equal(key,order.client_order_no);assert.ok(['funding_waiting','funding_review'].includes(order.state));order.state='funding_review';order.message=message;return clone(order);},
        markManualPrepared:async(_id,key,card)=>{assert.equal(order.state,'funding_waiting');assert.equal(key,order.client_order_no);assert.equal(card,42);order.state='prepared';return clone(order);},
        claimManualSubmission:async()=>{if(order.state!=='prepared')return false;order.state='submitting';return true;},
        settleManualOrder:async(_id,change)=>{Object.assign(order,change);return clone(order);},
        releaseManualFunding:async(_id,key,message)=>{if(!['funding_waiting','funding_review','funding_pending'].includes(order.state)||!['ready','failed'].includes(fundingState))return null;order.state='failed';order.message=message;order.released=true;return clone(order);},
        pauseManualPreparation:async()=>{if(['preparing','funding_waiting','funding_review','funding_pending'].includes(order.state))order.state='funding_pending';},
        failManualPreparation:async()=>{throw new Error('must retain existing funding');}
    };
    const provider={...providerHelpers,fetchPlans:async()=>({success:true,plans:[{type:'gpt-plus',name:'Plus'}]}),
        request:async(_cfg,operation,body,key)=>{
            calls.push({operation,body,key});
            const snapshot={task_no:'SUB-1',client_order_no:order.client_order_no,card_id:42,plan_type:'gpt-plus',
                targetEmail:'buyer@example.test',status:'succeeded',subscription_succeeded:true};
            if(operation==='createSubscription')assert.equal(order.state,'submitting');
            return {success:true,status:200,data:snapshot};
        }
    };
    const cardService={allocate:async()=>{throw new FundingAwaitingError('funding pending',initialDelay);},
        confirmFunding:async(...args)=>{calls.push({operation:'confirmFunding'});if(confirm)return confirm(...args);fundingState='ready';return 42;}};
    const options={store,activeJobs,provider,cardService,audit(){},now:()=>clock,fundingWaitMs:waitMs,
        sleep:async ms=>{waits.push(ms);clock+=ms;if(sleepHook)await sleepHook(ms);}};
    const service=createService(options);
    return {service,store,cardService,cfg,session,calls,waits,activeJobs,options,get order(){return order;},
        advance:ms=>{clock+=ms;},setFunding:value=>{fundingState=value;},
        input:{requestId:id,planType:'gpt-plus',mode:'test',session,authorized:true}};
}

async function until(check) {for(let n=0;n<50;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('background continuation did not finish');}

test('administrator funding wait preserves the original execution lock and submits once after asynchronous confirmation',async()=>{
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const f=fixture({sleepHook:()=>gate});
    const accepted=await f.service.create(f.input);assert.equal(accepted.state,'funding_waiting');
    const other=createService({...f.options,activeJobs:new Set()});
    await assert.rejects(other.create(f.input),error=>error.status===409);
    await other.recover();assert.equal(f.calls.filter(c=>c.operation==='confirmFunding').length,0);
    release();await until(()=>f.order.state==='success'&&f.activeJobs.size===0);
    assert.deepEqual(f.waits,[FUNDING_POLL_MS]);
    assert.equal(f.calls.filter(c=>c.operation==='confirmFunding').length,1);
    assert.equal(f.calls.filter(c=>c.operation==='createSubscription').length,1);
});

test('administrator funding retry honors longer Retry-After and never reallocates or resends funding',async()=>{
    let reads=0;const f=fixture({initialDelay:15000,confirm:async()=>{if(++reads===1)throw new FundingAwaitingError('pending',30000);return 42;}});
    await f.service.create(f.input);await until(()=>f.order.state==='success');
    assert.deepEqual(f.waits,[15000,30000]);assert.equal(reads,2);
    assert.equal(f.calls.filter(c=>c.operation==='createSubscription').length,1);
});

test('administrator funding timeout creates a review that can only reconcile and release without a subscription',async()=>{
    const f=fixture({waitMs:2*FUNDING_POLL_MS+1,confirm:async()=>{throw new FundingAwaitingError('pending');}});
    await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    assert.deepEqual(f.waits,[FUNDING_POLL_MS,FUNDING_POLL_MS,1]);
    assert.equal(f.order.state,'funding_review');assert.equal(f.calls.filter(c=>c.operation==='createSubscription').length,0);
    await assert.rejects(f.store.assertPaymentAllowed(),PaymentStoppedError);
    assert.equal((await f.service.create(f.input)).state,'funding_review');
    f.cardService.confirmFunding=async()=>{f.setFunding('ready');return 42;};
    await f.service.recover();assert.equal(f.order.released,true);assert.equal(f.order.state,'failed');
    assert.match(f.order.message,/最新 Session/);assert.equal(f.calls.filter(c=>c.operation==='createSubscription').length,0);
});

test('expired administrator Session exits automatic payment while original funding remains recoverable',async()=>{
    let f;f=fixture({sleepHook:async()=>{f.session.expires='2000-01-01T00:00:00Z';}});
    await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    assert.equal(f.order.state,'funding_review');assert.match(f.order.message,/Session 已过期/);
    assert.equal(f.calls.length,0);
    f.setFunding('ready');await f.service.recover();assert.equal(f.order.released,true);
});

test('explicit administrator handoff stops funding continuation and recovery never reopens it',async()=>{
    let f;f=fixture({sleepHook:async()=>{f.order.state='support_locked';}});
    await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    assert.equal(f.order.state,'support_locked');assert.equal(f.calls.length,0);
    await f.service.recover();assert.equal(f.calls.length,0);
});

test('restart recovery queries only the original funding and respects per-order read intervals',async()=>{
    for(const retryAfterMs of [FUNDING_POLL_MS,90000]) {
        const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
        let reads=0;f.cardService.confirmFunding=async()=>{reads++;throw new FundingAwaitingError('pending',retryAfterMs);};
        const restarted=createService({...f.options,activeJobs:new Set()});
        await restarted.recover();await restarted.recover();assert.equal(reads,1);
        f.advance(retryAfterMs-1);await restarted.recover();assert.equal(reads,1);
        f.advance(1);await restarted.recover();assert.equal(reads,2);
        assert.equal(f.order.state,'funding_review');assert.equal(f.calls.filter(c=>c.operation==='createSubscription').length,0);
    }
});

test('insufficient account balance fails immediately and releases the prepared card and CDK before any funding intent',async()=>{
    const f=fixture(),cdk={cdk_code:'TEST-CDK',used_at:'reserved'},card={card_id:42,active_job:`manual-${id}`};
    const store=createStore({
        withTransaction:async action=>action({}),
        runQuery:async(sql)=>{
            if(sql.includes('FROM orbitcard_admin_orders'))return [structuredClone(f.order)];
            if(sql.includes('FROM orbitcard_card_issues'))return [];
            if(sql.includes('FROM orbitcard_card_fundings'))return [];
            if(sql.includes('FROM cdk_codes'))return [structuredClone(cdk)];
            if(sql.includes('FROM orbitcard_managed_cards'))return [structuredClone(card)];
            throw new Error(`Unexpected query: ${sql}`);
        },
        runExecute:async(sql,params)=>{
            if(sql.includes('UPDATE orbitcard_managed_cards SET active_job = NULL'))card.active_job=null;
            else if(sql.includes('UPDATE cdk_codes SET used_at = NULL'))cdk.used_at=null;
            else if(sql.includes("UPDATE orbitcard_admin_orders SET state = 'failed'"))Object.assign(f.order,{state:'failed',message:params[0]});
            else throw new Error(`Unexpected write: ${sql}`);
            return {affectedRows:1};
        }
    });
    f.store.failManualPreparation=store.failManualPreparation;
    f.cardService.allocate=async()=>{throw new AccountBalanceError('账户可用余额不足');};
    await assert.rejects(f.service.create({...f.input,mode:'fulfillment',cdkCode:cdk.cdk_code}),error=>error.status===409&&/账户可用余额不足/.test(error.message));
    assert.equal(f.order.state,'failed');assert.equal(card.active_job,null);assert.equal(cdk.used_at,null);
    assert.equal(f.activeJobs.size,0);assert.deepEqual(f.waits,[]);assert.deepEqual(f.calls,[]);
});

test('administrator recovery selects funding waits, reviews and preparation incidents after five seconds',async()=>{
    let query;const store=createStore({runQuery:async sql=>{query=sql;return [];}});
    await store.listRecoverableManualOrders();
    assert.match(query,/state IN \('funding_waiting','funding_review','funding_pending','card_pending'\).*INTERVAL 5 SECOND/);
});

test('confirmed funding failure releases preparation while mismatched funding remains locked for reconciliation',async()=>{
    for(const failed of [true,false]) {
        let f;f=fixture({confirm:async()=>{if(failed){f.setFunding('failed');throw new CardPreparationError('funding failed');}throw new FundingPendingError('wrong identity');}});
        await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
        assert.equal(f.order.state,failed?'failed':'funding_pending');assert.equal(Boolean(f.order.released),failed);
        assert.equal(f.calls.filter(c=>c.operation==='createSubscription').length,0);
    }
});

test('a different configured API account cannot release or resume waiting administrator funding',async()=>{
    const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    f.cfg.api_key='different-account';await f.service.recover();
    assert.equal(f.order.state,'funding_review');assert.equal(f.order.released,undefined);assert.equal(f.calls.length,0);
});

test('administrator funding waits five seconds per check and stops automatically at 120 seconds',async()=>{
    const f=fixture({confirm:async()=>{throw new FundingAwaitingError('pending');}});
    await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    assert.equal(f.order.state,'funding_review');assert.equal(f.waits.reduce((total,ms)=>total+ms,0),120000);
    assert.equal(f.waits.length,24);assert.ok(f.waits.every(ms=>ms===5000));
    assert.equal(f.calls.filter(call=>call.operation==='confirmFunding').length,23);
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,0);
});

test('a longer Retry-After cannot extend the administrator funding automation deadline',async()=>{
    const f=fixture({initialDelay:180000});
    await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    assert.deepEqual(f.waits,[120000]);assert.equal(f.order.state,'funding_review');assert.deepEqual(f.calls,[]);
});

test('late funding completion or a Session expiring during confirmation creates review without submitting',async()=>{
    for(const expires of [true,false]) {
        let f;f=fixture({confirm:async()=>{f.setFunding('ready');if(expires)f.session.expires='2000-01-01T00:00:00Z';else f.advance(FUNDING_WAIT_MS);return 42;}});
        await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
        assert.equal(f.order.state,'funding_review');assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,0);
        f.cardService.confirmFunding=async()=>42;
        await f.service.recover();assert.equal(f.order.released,true);
    }
});

test('a restarted funding waiter first becomes review and cannot resume its subscription',async()=>{
    const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    f.order.state='funding_waiting';
    f.cardService.confirmFunding=async()=>{assert.equal(f.order.state,'funding_review');f.setFunding('ready');return 42;};
    await createService({...f.options,activeJobs:new Set()}).recover();
    assert.equal(f.order.released,true);assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,0);
});

test('administrator funding incidents keep checking the original funding after errors without resubmitting',async()=>{
    const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    f.order.state='funding_pending';
    let reads=0;
    f.cardService.confirmFunding=async()=>{
        reads++;
        if(reads===1)throw new FundingPendingError('original response identity is incomplete');
        f.setFunding('ready');return 42;
    };
    await f.service.recover();await f.service.refresh(id);
    assert.equal(reads,1);assert.equal(f.order.state,'funding_pending');assert.equal(f.order.released,undefined);
    f.advance(59999);await f.service.recover();assert.equal(reads,1);
    f.advance(1);await f.service.refresh(id);
    assert.equal(reads,2);assert.equal(f.order.released,true);assert.equal(f.order.state,'failed');
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,0);
});

test('manual refresh of a funding incident observes longer original Retry-After',async()=>{
    const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    f.order.state='funding_pending';let reads=0;
    f.cardService.confirmFunding=async()=>{reads++;throw new FundingAwaitingError('original funding pending',90000);};
    await f.service.refresh(id);await f.service.recover();assert.equal(reads,1);
    f.advance(89999);await f.service.refresh(id);assert.equal(reads,1);
    f.advance(1);await f.service.refresh(id);assert.equal(reads,2);
    assert.equal(f.order.state,'funding_pending');assert.equal(f.order.released,undefined);
});

test('a full recovery batch rotates cooling funding orders so later orders can reconcile',async()=>{
    const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    const rows=Array.from({length:11},(_,index)=>({...structuredClone(f.order),request_id:`queue-${index}`,
        client_order_no:`manual-queue-${index}`,state:'funding_review',updated_at:f.options.now()-20000+index}));
    const reads=new Map(),noted=[];
    f.store.listRecoverableManualOrders=async()=>rows.filter(row=>row.updated_at<=f.options.now()-FUNDING_POLL_MS)
        .sort((a,b)=>a.updated_at-b.updated_at).slice(0,10).map(row=>structuredClone(row));
    f.store.getManualOrder=async requestId=>structuredClone(rows.find(row=>row.request_id===requestId));
    f.store.assertFundingReconciliationAllowed=async()=>{};
    f.store.noteManualQueryAttempt=async requestId=>{noted.push(requestId);rows.find(row=>row.request_id===requestId).updated_at=f.options.now();};
    f.cardService.confirmFunding=async(_cfg,jobKey)=>{
        reads.set(jobKey,(reads.get(jobKey)||0)+1);throw new FundingAwaitingError('processing',90000);
    };
    await f.service.recover();
    assert.equal(reads.size,10);assert.equal(reads.has('manual-queue-10'),false);
    f.advance(FUNDING_POLL_MS);await f.service.recover();
    assert.equal(reads.get('manual-queue-10'),1,'the eleventh order must get a turn before earlier Retry-After expires');
    assert.ok([...reads.values()].every(count=>count===1),'rotation must not bypass per-order Retry-After');
    assert.equal(noted.length,20,'cooldown skips must still rotate the bounded queue');
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,0);
});

test('an exceptional preparation recovery and failed queue timestamp cannot abort later orders',async()=>{
    const f=fixture({waitMs:1});await f.service.create(f.input);await until(()=>f.activeJobs.size===0);
    const first={...structuredClone(f.order),request_id:'broken',client_order_no:'manual-broken',state:'card_pending'};
    const second={...structuredClone(f.order),request_id:'later',client_order_no:'manual-later',state:'funding_review'};
    const active={...structuredClone(f.order),request_id:'active',client_order_no:'manual-active',state:'prepared'};
    const rows=[first,second,active],noted=[];let reads=0;
    f.store.listRecoverableManualOrders=async()=>rows;
    f.store.getManualOrder=async requestId=>structuredClone(rows.find(row=>row.request_id===requestId));
    f.store.assertFundingReconciliationAllowed=async()=>{};
    f.store.failManualPreparation=async()=>{throw new Error('database unavailable');};
    f.store.pauseManualPreparation=async()=>{throw new Error('database unavailable');};
    f.store.noteManualQueryAttempt=async requestId=>{noted.push(requestId);if(requestId==='broken')throw new Error('timestamp write unavailable');};
    f.cardService.confirmFunding=async()=>{reads++;throw new FundingAwaitingError('pending');};
    f.activeJobs.add(active.client_order_no);
    await f.service.recover();
    assert.equal(reads,1);assert.deepEqual(noted,['broken','later']);
    assert.equal(f.calls.filter(call=>call.operation==='createSubscription').length,0);
});

test('recovery queue rotation leaves preparation deadlines and final results untouched',async()=>{
    const rows=['preparing','prepared','pending','funding_pending','success','failed'].map(state=>({request_id:state,state,updated_at:1}));
    const store=createStore({runExecute:async(sql,[requestId])=>{
        assert.match(sql,/SET updated_at = CURRENT_TIMESTAMP WHERE request_id = \?/);
        const states=/state IN \(([^)]+)\)/.exec(sql)[1].split(',').map(value=>value.trim().replaceAll("'",''));
        const row=rows.find(item=>item.request_id===requestId);
        if(states.includes(row.state))row.updated_at=100;
    }});
    for(const row of rows)await store.noteManualQueryAttempt(row.request_id);
    assert.deepEqual(rows.map(row=>[row.state,row.updated_at]),[
        ['preparing',1],['prepared',1],['pending',100],['funding_pending',100],['success',1],['failed',1]
    ]);
});
