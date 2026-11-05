'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createRequire } = require('node:module');
const createDiagnostics = require('../orbitcard-diagnostics');
const { PROVIDER_PLANS } = require('../plan-registry');
const { CardDataError } = require('../orbitcard-card-policy');
const cardApi = require('../orbitcard-cards-client');
const session = { accessToken: 'never-log-access', sessionToken: 'never-log-session', account: {}, user: { email: 'preview@example.test' } };
const settlements = (count, cardId = 42) => Array.from({ length: count }, (_, index) => ({
    transaction_id: `transaction-${index}`, card_id: cardId, transaction_type: 'Settlement', status: 'success'
}));
function fixture() {
    const events = [], calls = [], writes = [], cfg = { base_url: 'https://orbitcard.test', orbitcard_payment_regions: { plus: 'PH' } };
    const product = { product_code: 'p1', min_initial_amount: 10, min_retained_balance: 0, remaining: 10,
        prices: Object.keys(PROVIDER_PLANS).map(plan_type => ({ plan_type, price: '16.00' })) };
    const live = [{ card_id: 42, provider_status: 'ACTIVE', product_code: 'p1', currency: 'USD', balance_amount: '20.00' }];
    const rows = [{ card_id: 42, transaction_count: 0 }];
    const state = { available: '100.00', live, rows, details: live, product, transactions: new Map([[42, []]]) };
    const provider = { fetchPlans: async config => { calls.push(['getSubscriptionPlans',config.auditJobKey]); return { success:true, plans:Object.values(PROVIDER_PLANS).map(type=>({type,name:type})) }; },
        request: async (config, operation, body) => {
            calls.push([operation,config.auditJobKey,body]);
            assert.ok(['getAccountBalance','getSubscriptionPaymentRegions','cardTransaction'].includes(operation), 'Read-only operations only');
            if(operation==='getAccountBalance')return {success:true,data:{available_balance:state.available}};
            if(operation==='cardTransaction') {
                if(state.transactionFailureCardId===body.card_id) return {success:false,status:403,error:'交易读取权限不足'};
                const transactions=state.transactions.get(body.card_id) || [];
                return {success:true,data:{list:transactions.slice((body.page-1)*body.page_size,body.page*body.page_size),total:transactions.length}};
            }
            return {success:true,data:{plan_type:body.plan_type,payment_regions:[{code:'PH',default:true},{code:'US'}]}};
        } };
    const cards = { ...cardApi,
        products: async config => { calls.push(['getProductCode',config.auditJobKey]); return [product]; },
        listCards: async config => { calls.push(['getCardList',config.auditJobKey]); return state.live; },
        cardDetailsInBatches: async (config, ids) => { calls.push(['cardDetail',config.auditJobKey]); if(state.detailError)throw state.detailError;return state.details.filter(card=>ids.includes(card.card_id)); } };
    const write = name => async () => { writes.push(name); throw Error('Diagnostics must not write'); };
    const store = { getGptApiConfig: async()=>cfg, withCardAllocationLock:write('allocation_lock'),
        cardMethods:()=>({ listCards:async()=>state.rows, saveTransactionCount:write('save_count'),
            syncCards:write('sync_cards'), reserveCard:write('reserve_card'), retireCard:write('retire_card') }) };
    const service = createDiagnostics({store,provider,cards,audit:entry=>events.push(entry)});
    return {service,events,calls,writes,state,cfg};
}
test('full preflight checks all four plans with the production selection rules and only read operations', async()=>{
    for(const plan of Object.keys(PROVIDER_PLANS)) {
        const f=fixture(), result=await f.service.preflight({stage:'full',plan_type:plan,session});
        assert.equal(result.ready,true);assert.equal(result.result.selection.action,'pay');
        assert.equal(result.result.selection.card_id,42);assert.equal(result.result.selection.reserved,false);
        assert.deepEqual(result.steps.map(s=>s.step),['session','config','plans','balance','regions','cards']);
        assert.ok(f.calls.every(([,trace])=>trace===result.trace_id));
        assert.ok(f.events.every(e=>e.jobKey===result.trace_id));
        const output=JSON.stringify([result,f.events]);
        for(const secret of ['never-log-access','never-log-session','preview@example.test','prices','16.00'])assert.ok(!output.includes(secret));
        assert.equal(f.state.rows[0].active_job,undefined);
        assert.deepEqual(f.writes,[]);
        assert.ok(f.calls.some(([operation])=>operation==='cardTransaction'));
    }
});
test('preflight models funding and exhausted-card opening using live counts without mutating cards',async()=>{
    const fund=fixture();fund.state.details=[{...fund.state.live[0],balance_amount:'2.00'}];
    const funding=await fund.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(funding.result.selection.action,'fund');assert.equal(funding.result.selection.funding_amount,'14.00');
    const open=fixture();open.state.transactions.set(42,settlements(6));
    const opening=await open.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(opening.result.selection.action,'open');assert.deepEqual(opening.result.selection.opening,{product_code:'p1',amount:'20.00',quantity:1});
    assert.equal(opening.result.selection.skipped[0].reason,'limit_reached');
    assert.equal(open.state.rows[0].transaction_count,0);
    assert.deepEqual(open.writes,[]);
});

test('preflight reads new cards without local counts and exposes only safe settlement summaries',async()=>{
    const f=fixture();f.state.rows=[];
    f.state.transactions.set(42,[{...settlements(1)[0],card_number:'5556597912341234',cvv:'private-cvv',
        merchant:'private-merchant',session_json:{accessToken:'private-transaction-session'}}]);
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,true);assert.equal(result.result.selection.action,'pay');
    const card=result.result.selection.cards[0];
    assert.equal(card.card_id,42);assert.equal(card.transaction_count,1);assert.equal(card.transaction_limit,6);
    assert.ok(Number.isFinite(Date.parse(card.transactions_checked_at)));
    assert.equal(result.result.selection.transactions_complete,true);
    assert.deepEqual(f.state.rows,[]);assert.deepEqual(f.writes,[]);
    const output=JSON.stringify([result,f.events]);
    for(const secret of ['5556597912341234','private-cvv','private-merchant','private-transaction-session'])assert.ok(!output.includes(secret));
});

test('preflight replaces stale low and exhausted counts only in its temporary snapshot',async()=>{
    for(const [savedCount,liveCount,action] of [[0,6,'open'],[6,5,'pay']]) {
        const f=fixture();f.state.rows[0].transaction_count=savedCount;f.state.transactions.set(42,settlements(liveCount));
        const before=structuredClone(f.state.rows);
        const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
        assert.equal(result.passed,true);assert.equal(result.result.selection.action,action);
        assert.equal(result.result.selection.cards[0].transaction_count,liveCount);
        assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
    }
});

test('preflight displays live counts for busy and exhausted cards and skips deleted-card queries',async()=>{
    const f=fixture();
    f.state.live.push({...f.state.live[0],card_id:43},{...f.state.live[0],card_id:44,provider_status:'DELETED'});
    f.state.rows.push({card_id:43,transaction_count:0,active_job:'private-active-job'},{card_id:44,transaction_count:0});
    f.state.transactions.set(42,settlements(6));f.state.transactions.set(43,settlements(3,43));
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,false);assert.equal(result.result.selection.action,'wait');
    assert.deepEqual(result.result.selection.cards.map(card=>[card.card_id,card.transaction_count,card.transaction_limit,card.busy]),
        [[42,6,6,false],[43,3,6,true],[44,null,6,false]]);
    assert.ok(result.result.selection.cards.slice(0,2).every(card=>Number.isFinite(Date.parse(card.transactions_checked_at))));
    assert.deepEqual(f.calls.filter(([operation])=>operation==='cardTransaction').map(([, ,body])=>body.card_id),[42,43]);
    assert.ok(!JSON.stringify([result,f.events]).includes('private-active-job'));assert.deepEqual(f.writes,[]);
});

test('preflight counts every settlement page before deciding a card is exhausted',async()=>{
    const f=fixture();f.state.transactions.set(42,settlements(102));
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,true);assert.equal(result.result.selection.cards[0].transaction_count,102);
    assert.equal(result.result.selection.action,'open');
    assert.deepEqual(f.calls.filter(([operation])=>operation==='cardTransaction').map(([, ,body])=>[body.page,body.page_size]),[[1,100],[2,100]]);
    assert.deepEqual(f.writes,[]);
});

test('transaction permission failures retain confirmed observations and stop selection without stale counts or writes',async()=>{
    const f=fixture();f.state.live.push({...f.state.live[0],card_id:43});
    f.state.rows.push({card_id:43,transaction_count:0});f.state.transactions.set(42,settlements(5));
    f.state.transactionFailureCardId=43;
    const before=structuredClone(f.state.rows);
    const result=await f.service.preflight({stage:'full',plan_type:'plus',session});
    assert.equal(result.passed,false);assert.equal(result.ready,false);
    const selection=result.result.selection;
    assert.equal(selection.action,'wait');assert.equal(selection.card_id,null);assert.equal(selection.candidate_count,0);
    assert.equal(selection.transactions_complete,false);
    assert.deepEqual(selection.cards.map(card=>card.transaction_count),[5,null]);
    assert.ok(Number.isFinite(Date.parse(selection.cards[0].transactions_checked_at)));
    assert.equal(selection.cards[1].transactions_checked_at,null);
    assert.deepEqual(selection.waiting,[{card_id:43,reason:'transactions_unconfirmed'}]);
    assert.ok(!f.calls.some(([operation])=>operation==='cardDetail'));
    assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
});

test('preflight does not turn authorization or unknown settlement status into successful usage',async()=>{
    const authorization=fixture();authorization.state.rows[0].transaction_count=5;
    authorization.state.transactions.set(42,[{...settlements(1)[0],transaction_type:'Authorization',status:'completed'}]);
    const observed=await authorization.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(observed.result.selection.cards[0].transaction_count,0);
    const unknown=fixture();unknown.state.transactions.set(42,[{...settlements(1)[0],status:'unknown-private-status'}]);
    const result=await unknown.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,false);assert.equal(result.result.selection.card_id,null);
    assert.equal(result.result.selection.cards[0].transaction_count,null);
    assert.deepEqual(unknown.writes,[]);
});
test('invalid Session, disabled region, insufficient balance and broken batch details stop the read-only chain',async()=>{
    await assert.rejects(fixture().service.preflight({stage:'session',request_id:'../../bad',session}));
    const invalid=fixture();const bad=await invalid.service.preflight({stage:'full',plan_type:'plus',session:'not-json never-log-access'});
    assert.equal(bad.passed,false);assert.deepEqual(invalid.calls,[]);assert.ok(!JSON.stringify(invalid.events).includes('never-log-access'));
    const region=fixture();region.cfg.orbitcard_payment_regions.plus='JP';
    assert.equal((await region.service.preflight({stage:'full',plan_type:'plus',session})).ready,false);
    assert.ok(!region.calls.some(c=>c[0]==='getCardList'));
    const funds=fixture();funds.state.available='0.01';
    assert.equal((await funds.service.preflight({stage:'cards',plan_type:'plus'})).passed,false);
    assert.ok(!funds.calls.some(c=>c[0]==='getCardList'));
    const batch=fixture();batch.state.detailError=new CardDataError('批量响应异常');
    assert.equal((await batch.service.preflight({stage:'cards',plan_type:'plus'})).passed,false);
    const empty=fixture();empty.state.details=[];
    assert.equal((await empty.service.preflight({stage:'cards',plan_type:'plus'})).passed,false);
});
const logDir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-diag-'));
after(()=>{assert.ok(path.basename(logDir).startsWith('orbit-diag-'));fs.rmSync(logDir,{recursive:true,force:true});});
function logger() {
    const name=path.resolve(__dirname,'../runtime-log.js'),module={exports:{}},real=createRequire(name);
    new Function('require','module','exports','__dirname','process',fs.readFileSync(name,'utf8'))(real,module,module.exports,path.dirname(name),{...process,env:{...process.env,TASK_LOG_DIR:logDir}});
    return module.exports;
}
test('trace pagination reads durable logs after cache clearing and restart, validates boundaries and redacts secrets',async()=>{
    const logs=logger();
    for(let i=0;i<230;i++) logs.push({jobKey:'debug-test',event:'step',text:`中文步骤 ${i}`,data:{sessionToken:'hidden-session',cardNumber:'4111111111111111','X-API-Key':'hidden-key'}});
    logs.clear();const restored=logger(), first=await restored.readTask('debug-test');
    assert.equal(first.entries.length,200);assert.equal(first.has_more,true);
    const second=await restored.readTask('debug-test',first.next_cursor);assert.equal(second.entries.length,30);assert.equal(second.has_more,false);
    assert.equal(second.entries.at(-1).text,'中文步骤 229');
    for(const secret of ['hidden-session','hidden-key','4111111111111111']) assert.ok(!JSON.stringify([first,second]).includes(secret));
    assert.deepEqual((await restored.readTask('missing')).entries,[]);
    for(const cursor of [-1,'abc',1,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(restored.readTask('debug-test',cursor));
    await assert.rejects(restored.readTask('../escape'));
    fs.appendFileSync(restored.taskFile('debug-test'),'\n' + JSON.stringify({text:'blank line followed by a record'}) + '\n');
    const extra=await restored.readTask('debug-test',second.next_cursor);assert.equal(extra.entries.length,1);assert.equal(extra.has_more,false);
    fs.appendFileSync(restored.taskFile('debug-test'),'{"partial":');
    const tail=await restored.readTask('debug-test',extra.next_cursor);assert.equal(tail.entries.length,0);assert.equal(tail.next_cursor,extra.next_cursor);
});
test('diagnostics endpoints enforce secondary auth and never accept arbitrary upstream operations',async t=>{
    const express=require('express'),{once}=require('node:events'),app=express();app.use(express.json());
    const logs=logger();
    require('../orbitcard-diagnostics-http')(app,{store:{getGptApiConfig:async()=>{throw Error('Must not need config for session');}},logs,
        requireSecondaryAuth:(req,res,next)=>req.headers['x-admin-secondary-token']==='test-secondary'?next():res.status(403).json({success:false})});
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    const base=`http://127.0.0.1:${server.address().port}/api/admin/orbitcard/diagnostics`;
    assert.equal((await fetch(`${base}/preflight`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(`${base}/logs/debug-test`)).status,403);
    const headers={'Content-Type':'application/json','x-admin-secondary-token':'test-secondary'};
    const response=await fetch(`${base}/preflight`,{method:'POST',headers,body:JSON.stringify({stage:'session',session})});
    const data=await response.json();assert.equal(data.passed,true);assert.equal(data.ready,false);
    const trace=await (await fetch(`${base}/logs/${data.trace_id}`,{headers})).json();assert.ok(trace.entries.length>=3);
    assert.ok(!JSON.stringify(trace).includes('never-log-access'));
    assert.equal((await fetch(`${base}/preflight`,{method:'POST',headers,body:JSON.stringify({stage:'createSubscription',session})})).status,503);
});
test('admin assets remove reference price views and load the diagnostic workflow',()=>{
    const html=fs.readFileSync(path.resolve(__dirname,'../public/admin.html'),'utf8');
    const script=fs.readFileSync(path.resolve(__dirname,'../public/admin.js'),'utf8');
    const diagnostics=fs.readFileSync(path.resolve(__dirname,'../public/diagnostics.js'),'utf8');
    assert.doesNotMatch(html,/平台推荐价|产品推荐价|pricePreview|refreshPrices/);
    assert.doesNotMatch(script,/loadPricePreview|product\.prices/);
    assert.match(html,/diagnostics\.js/);new Function(diagnostics);
    assert.doesNotMatch(diagnostics,/sessionStorage\.setItem\([^,]*,[^)]*Session/);
});
