'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const factory=require('../src/integrations/email-notifications');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const target='admin@example.test';
const validSnapshot={task_no:'task-1',client_order_no:'client-1',card_id:42,plan_type:'gpt-plus',targetEmail:'customer@example.test',
    status:'succeeded',subscription_succeeded:true,query_source:'upstream',payment:{amount:19.99,currency:'USD'}};
function row(patch={}) {return {source_type:'self_service',record_key:'job-1',business_key:'root-job',client_order_no:'client-1',order_no:'task-1',
    plan_type:'plus',card_id:42,target_email:'customer@example.test',state:'success',snapshot:JSON.stringify(validSnapshot),
    updated_ms:1700000001000,version_key:hash('version'),enabled_since:1700000000000,...patch};}
function fixture({rows=[],send}={}) {
    let clock=1700000001000,configReads=0;
    const config={enabled:true,to_email:target,on_success:true,on_failure:true,on_low_balance:false,enabled_since:1700000000000,
        balance_threshold:'20.00',balance_cooldown_minutes:360};
    const events=new Map(),observations=new Set(),sent=[],audits=[],balances=[],deferred=[],reads=[];
    let getConfig=()=>({...config}),platform={enabled:false,base_url:'https://orbitcard.test',api_key:'key'},result={success:true,status:200,data:{available_balance:'19.99'}};
    const store={getEmailConfig:async()=>{configReads++;return getConfig();},getGptApiConfig:async()=>platform,
        listEmailOrderCandidates:async()=>rows.filter(item=>!observations.has(item.record_key+item.version_key)),
        commitEmailObservation:async(item,email,event)=>{observations.add(item.record_key+item.version_key);
            if(event&&!events.has(event.event_id))events.set(event.event_id,{...event,target_email:email,body:event.text,attempts:0});},
        listPendingEmails:async(email,types)=>[...events.values()].filter(item=>!item.delivered&&item.target_email===email&&types.includes(item.event_type)),
        claimEmailDelivery:async id=>{const event=events.get(id);if(event.claimed||event.delivered)return null;event.claimed=true;return 'lease';},
        finishEmailDelivery:async(id,token,result)=>{const event=events.get(id);event.claimed=false;event.result=result;if(result.ok)event.delivered=true;},
        claimEmailBalanceCheck:async(key,email)=>{reads.push({key,email});return {token:'balance-token'};},
        completeEmailBalanceCheck:async(claim,value)=>balances.push(value),deferEmailBalanceCheck:async(claim,delay)=>deferred.push(delay)};
    const mailer={send:async(cfg,message)=>{sent.push({cfg,message});return send?send(cfg,message):{ok:true};}};
    const provider={request:async(cfg,operation)=>{assert.equal(operation,'getAccountBalance');return result;}};
    const create=()=>factory({store,mailer,provider,now:()=>clock,audit:entry=>audits.push(entry)});
    return {config,rows,store,sent,events,audits,balances,deferred,reads,create,service:create(),advance:ms=>{clock+=ms;},
        get configReads(){return configReads;},setConfig:fn=>{getConfig=fn;},setResult:value=>{result=value;},setPlatform:value=>{platform=value;}};
}

test('only bound upstream success becomes a success email with allowlisted order information',()=>{
    const snapshot={...validSnapshot,session:{accessToken:'never-mail'},card_number:'1234567890123456',cvv:'123',failureMessage:'private raw text'};
    const event=factory.orderEvent(row({snapshot:JSON.stringify(snapshot)}),target);
    assert.equal(event.event_type,'order_success');assert.match(event.text,/自助兑换/);assert.match(event.text,/customer@example.test/);
    assert.match(event.text,/ChatGPT Plus/);assert.match(event.text,/19.99 USD/);assert.doesNotMatch(JSON.stringify(event),/never-mail|1234567890123456|private raw text|cvv/);
    for(const invalid of [{},{...validSnapshot,client_order_no:'wrong'},{...validSnapshot,request_error:{code:'unknown'}},
        {...validSnapshot,subscription_succeeded:null,status:'pending'},{...validSnapshot,result_source:'local'}])
        assert.equal(factory.orderEvent(row({snapshot:JSON.stringify(invalid)}),target),null);
});

test('retrying and pending results are not failures; final unverified stops are clearly review notifications',()=>{
    for(const state of ['retry_waiting','pending','manual','funding_pending','preparing'])assert.equal(factory.orderEvent(row({state}),target),null);
    const failure=factory.orderEvent(row({state:'support_locked',snapshot:JSON.stringify({...validSnapshot,status:'failed',subscription_succeeded:false,
        failureCode:'card_declined',failureMessage:'accessToken=do-not-mail'})}),target);
    assert.equal(failure.event_type,'order_failure');assert.doesNotMatch(failure.text,/do-not-mail/);
    const review=factory.orderEvent(row({state:'rejected',snapshot:null}),target);
    assert.equal(review.event_type,'order_review');assert.match(review.text,/没有足够证据/);assert.doesNotMatch(review.subject,/充值失败/);
    assert.match(factory.orderEvent(row({source_type:'admin',mode:'fulfillment'}),target).text,/管理员人工交付/);
    assert.match(factory.orderEvent(row({source_type:'admin',mode:'test'}),target).text,/管理员测试/);
});

test('event identity survives refresh, retries and worker restart without duplicate sends',async()=>{
    const f=fixture({rows:[row()]});await f.service.tick();assert.equal(f.sent.length,1);
    f.rows[0].version_key=hash('refreshed');await f.create().tick();assert.equal(f.sent.length,1);
    const retryRow=row({record_key:'attempt-2',client_order_no:'client-2',snapshot:JSON.stringify({...validSnapshot,client_order_no:'client-2'}),version_key:hash('retry')});
    f.rows.push(retryRow);await f.service.tick();assert.equal(f.sent.length,1);
    assert.match(f.sent[0].message.messageId,/^<[a-f0-9]{64}@pay-gpt-orbit\.local>$/);
});

test('disabling notifications, changing recipient or turning off a category before send holds the queued mail',async()=>{
    for(const patch of [{enabled:false},{to_email:'new@example.test'},{on_success:false}]){
        const f=fixture({rows:[row()]});f.setConfig(()=>({...f.config,...(f.configReads>1?patch:{})}));
        await f.service.tick();assert.equal(f.sent.length,0);assert.equal([...f.events.values()][0].result.deferred,true);
    }
});

test('disabled categories consume observations instead of sending old results when later enabled',async()=>{
    const f=fixture({rows:[row()]});f.config.on_success=false;f.config.on_failure=false;
    await f.service.tick();f.config.on_success=true;await f.service.tick();assert.equal(f.sent.length,0);
});

test('balance monitoring reads a paused account, rejects invalid data and never substitutes zero on API errors',async()=>{
    const f=fixture();f.config.on_low_balance=true;await f.service.tick();assert.equal(f.balances[0].low,true);
    const originalKey=f.reads[0].key;
    f.setPlatform({enabled:false,base_url:'https://orbitcard.test',api_key:'other-key'});await f.service.tick();assert.notEqual(f.reads[1].key,originalKey);
    for(const result of [{success:false,status:429,retryAfterMs:900000},{success:true,status:200,data:{}},
        {success:true,status:500,data:{available_balance:'0.00'}},
        {success:true,status:200,requestError:{code:'bad'},data:{available_balance:'0.00'}}]){
        const before=f.balances.length;f.setResult(result);await f.service.tick();assert.equal(f.balances.length,before);
    }
    assert.ok(f.deferred.includes(900000));
    f.setResult({success:true,status:200,data:{available_balance:'20.00'}});await f.service.tick();assert.equal(f.balances.at(-1).low,false);
});

test('order scanning failure does not suppress delivery or affect a caller, and logging never includes raw errors',async()=>{
    const f=fixture({rows:[row()]});await f.service.tick();f.events.values().next().value.delivered=false;
    f.store.listEmailOrderCandidates=async()=>{throw Error('database-secret');};await f.service.tick();
    assert.equal(f.sent.length,2);assert.doesNotMatch(JSON.stringify(f.audits),/database-secret/);
});

test('overlapping ticks share work; stop waits for current SMTP and starts no more emails',async()=>{
    let release;
    const f=fixture({rows:[row(),row({record_key:'second',business_key:'second',version_key:hash('two')})],send:()=>new Promise(resolve=>{release=resolve;})});
    const first=f.service.tick();assert.equal(f.service.tick(),first);
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    const stopping=f.service.stop();release({ok:true});await Promise.all([first,stopping]);
    assert.equal(f.sent.length,1);await f.service.tick();assert.equal(f.sent.length,1);
});

test('explicit test email works with notifications off and uses fixed content with one-minute throttling',async()=>{
    const f=fixture();f.config.enabled=false;
    assert.equal((await f.service.testEmail()).success,true);assert.equal(f.sent[0].cfg.to_email,target);
    assert.match(f.sent[0].message.text,/不会发起任何开卡、充值或订阅/);
    assert.equal((await f.service.testEmail()).success,false);assert.equal(f.sent.length,1);
    f.advance(60000);assert.equal((await f.service.testEmail()).success,true);assert.equal(f.sent.length,2);
});
