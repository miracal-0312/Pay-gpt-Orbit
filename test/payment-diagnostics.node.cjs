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
const authorization=(id,card_id=42)=>({transaction_id:id,card_id,transaction_type:'Authorization',status:'success',authorization_amount:'15.54',currency:'USD'});
function fixture() {
    const events = [], calls = [], writes = [], cfg = { base_url: 'https://orbitcard.test', orbitcard_payment_regions: { plus: 'PH' },
        orbitcard_plan_prices:Object.fromEntries(Object.keys(PROVIDER_PLANS).map(plan=>[plan,'16.00'])) };
    const product = { product_code: 'p1', min_initial_amount: '10.00', min_retained_balance: '0.00', remaining: 10 };
    const live = [{ card_id: 42, provider_status: 'ACTIVE', product_code: 'p1', currency: 'USD', balance_amount: '20.00' }];
    const rows = [{ card_id: 42, authorization_count: 0 }];
    const state = { available: '100.00', live, rows, details: live, product, transactions:new Map(), savedIds:new Map(), singleDetails:new Map() };
    const persisted=id=>state.savedIds.get(id)||Array.from({length:Number(state.rows.find(row=>row.card_id===id)?.authorization_count)||0},(_,i)=>'saved-'+id+'-'+i);
    const provider = { fetchPlans: async config => { calls.push(['getSubscriptionPlans',config.auditJobKey]); return { success:true, plans:Object.values(PROVIDER_PLANS).map(type=>({type,name:type})) }; },
        request: async (config, operation, body) => {
            calls.push([operation,config.auditJobKey,body]);
            assert.ok(['getAccountBalance','getSubscriptionPaymentRegions','cardTransaction'].includes(operation), 'No financial operation');
            if(operation==='getAccountBalance')return {success:true,data:{available_balance:state.available}};
            if(operation==='cardTransaction') {
                if(state.transactionError===body.card_id)throw Error('private upstream failure');
                const rows=state.transactions.get(body.card_id)||persisted(body.card_id).map(id=>authorization(id,body.card_id));
                return {success:true,data:{list:rows.slice((body.page-1)*body.page_size,body.page*body.page_size),total:rows.length}};
            }
            return {success:true,data:{plan_type:body.plan_type,payment_regions:[{code:'PH',default:true},{code:'US'}]}};
        } };
    const cards = { ...cardApi,
        products: async config => { calls.push(['getProductCode',config.auditJobKey]); return [product]; },
        listCards: async config => { calls.push(['getCardList',config.auditJobKey]); return state.live; },
        cardDetail: async (config,id) => {
            calls.push(['cardDetail',config.auditJobKey,{card_id:id}]);
            if(state.singleDetailError)throw state.singleDetailError;
            return state.singleDetails.get(id)||state.live.find(card=>card.card_id===id);
        },
        cardDetailsInBatches: async (config, ids) => { calls.push(['cardDetail',config.auditJobKey]); if(state.detailError)throw state.detailError;return state.details.filter(card=>ids.includes(card.card_id)); } };
    const write = name => async () => { writes.push(name); throw Error('Diagnostics must not write'); };
    const store = { getGptApiConfig: async()=>cfg, withCardAllocationLock:write('allocation_lock'),
        cardMethods:()=>({ listCards:async()=>{ if(state.countReadError)throw state.countReadError;return state.rows; },
            listAuthorizations:async id=>{if(state.ledgerError)throw state.ledgerError;return persisted(id);},
            syncCards:write('sync_cards'), saveAuthorizations:write('save_authorizations'), reserveCard:write('reserve_card'), retireCard:write('retire_card') }) };
    const service = createDiagnostics({store,provider,cards,audit:entry=>events.push(entry)});
    return {service,events,calls,writes,state,cfg};
}

function managedPool(count=5,balance='20.00') {
    const f=fixture();f.cfg.enabled=true;
    f.state.live=Array.from({length:count},(_,i)=>({...f.state.live[0],card_id:42+i,balance_amount:balance}));
    f.state.details=f.state.live;
    f.state.rows=f.state.live.map(card=>({card_id:card.card_id,authorization_count:0}));
    return f;
}

test('full preflight checks all four plans with readonly authorization queries', async()=>{
    for(const plan of Object.keys(PROVIDER_PLANS)) {
        const f=fixture(), result=await f.service.preflight({stage:'full',plan_type:plan,session});
        assert.equal(result.ready,true);assert.equal(result.result.selection.action,'pay');
        assert.equal(result.result.selection.card_id,42);assert.equal(result.result.selection.reserved,false);
        assert.deepEqual(result.steps.map(s=>s.step),['session','config','plans','balance','regions','cards']);
        assert.ok(f.calls.every(([,trace])=>trace===result.trace_id));assert.ok(f.events.every(e=>e.jobKey===result.trace_id));
        const output=JSON.stringify([result,f.events]);
        for(const secret of ['never-log-access','never-log-session','preview@example.test','prices','16.00'])assert.ok(!output.includes(secret));
        assert.equal(f.state.rows[0].active_job,undefined);assert.deepEqual(f.writes,[]);
        assert.equal(f.calls.filter(([operation])=>operation==='cardTransaction').length,1);
    }
});
test('preflight models funding and exhausted-card replacement from authorization counts',async()=>{
    const fund=fixture();fund.state.details=[{...fund.state.live[0],balance_amount:'2.00'}];
    const funding=await fund.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(funding.result.selection.action,'fund');assert.equal(funding.result.selection.funding_amount,'14.00');
    const open=fixture();open.state.rows[0].authorization_count=7;
    const opening=await open.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(opening.result.selection.action,'open');assert.deepEqual(opening.result.selection.opening,{product_code:'p1',amount:'20.00',quantity:1});
    assert.equal(opening.result.selection.skipped[0].reason,'limit_reached');assert.equal(open.state.rows[0].authorization_count,7);
    assert.deepEqual(open.writes,[]);
});

test('preflight checks the actual funding deficit and does not require account funds for a funded card',async()=>{
    const funded=fixture();funded.state.available='0.00';
    const pay=await funded.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(pay.passed,true);assert.equal(pay.result.selection.action,'pay');assert.deepEqual(funded.writes,[]);
    const sufficient=fixture();sufficient.state.available='14.00';sufficient.state.details=[{...sufficient.state.live[0],balance_amount:'2.00'}];
    const fund=await sufficient.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(fund.passed,true);assert.equal(fund.result.selection.action,'fund');assert.equal(fund.result.selection.funding_amount,'14.00');
    sufficient.state.available='13.99';
    const short=await sufficient.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(short.passed,false);assert.deepEqual(sufficient.writes,[]);
});

test('preflight rejects missing configured USD prices without financial writes',async()=>{
    const f=fixture();f.cfg.orbitcard_plan_prices={};
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,false);assert.deepEqual(f.writes,[]);
});

test('enabled preflight budgets only the selected deficit regardless of pool size',async()=>{
    for(const count of [1,4,5,6,25]) for(const balance of ['20.00','2.00']) {
        const f=managedPool(count,balance),required=balance==='2.00'?'14.00':'0.00';f.state.available=required;
        const before=structuredClone(f.state.rows);
        const enough=await f.service.preflight({stage:'cards',plan_type:'plus'});
        assert.equal(enough.passed,true);
        const maintenance=enough.result.selection.maintenance;
        assert.equal(maintenance.capacity_limit,null);assert.equal(maintenance.auto_refill,false);
        assert.equal(maintenance.current_size,count);assert.equal(maintenance.open_count,0);
        assert.equal(maintenance.opening_amount,'0.00');assert.equal(maintenance.required_balance,required);
        if(Number(required)>0) {
            f.state.available='13.99';
            const short=await f.service.preflight({stage:'cards',plan_type:'plus'});
            assert.equal(short.passed,false);assert.equal(short.result.selection.account_check,'failed');
        }
        assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
    }
});

test('enabled preflight requires no replacement funds when another card can pay',async()=>{
    const f=managedPool();f.state.rows[0].authorization_count=7;f.state.available='0.00';
    const before=structuredClone(f.state.rows);
    const ready=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(ready.passed,true);assert.equal(ready.result.selection.action,'pay');
    assert.deepEqual(ready.result.selection.maintenance.retire_card_ids,[42]);
    assert.equal(ready.result.selection.maintenance.open_count,0);
    assert.equal(ready.result.selection.maintenance.required_balance,'0.00');
    assert.equal(ready.result.selection.card_id,43);assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
});

test('enabled empty-pool preflight budgets one opening plus its payment deficit',async()=>{
    const f=managedPool(0);f.cfg.orbitcard_plan_prices.pro100='100.00';f.state.available='99.99';
    const short=await f.service.preflight({stage:'cards',plan_type:'pro100'});
    assert.equal(short.passed,false);assert.equal(short.result.selection.account_check,'failed');
    assert.equal(short.result.selection.maintenance.open_count,1);
    assert.equal(short.result.selection.maintenance.opening_amount,'20.00');
    assert.equal(short.result.selection.maintenance.funding_amount,'80.00');
    assert.equal(short.result.selection.maintenance.required_balance,'100.00');
    f.state.available='100.00';
    const ready=await f.service.preflight({stage:'cards',plan_type:'pro100'});
    assert.equal(ready.passed,true);assert.equal(ready.result.selection.action,'open');
    assert.deepEqual(f.state.rows,[]);assert.deepEqual(f.writes,[]);
});

test('preflight waits on an uncertain deletion before reading its consumption history',async()=>{
    for(const state of ['ACTIVE','CANCELLED','error']) {
        const f=managedPool();Object.assign(f.state.rows[0],{retirement_key:'private-retirement-key',retirement_state:'unknown'});
        if(state==='error')f.state.singleDetailError=Error('private-provider-error');
        else f.state.singleDetails.set(42,{...f.state.live[0],provider_status:state});
        const before=structuredClone(f.state.rows);
        const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
        assert.equal(result.passed,false);assert.deepEqual(result.result.selection.waiting,[{card_id:42,reason:'retirement_unconfirmed'}]);
        assert.ok(!f.calls.some(([op,,body])=>op==='cardTransaction'&&body.card_id===42));
        assert.ok(!JSON.stringify([result,f.events]).includes('private-'));
        assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
    }
});

test('preflight confirms an unknown deletion readonly before skipping its unavailable transaction API',async()=>{
    const f=managedPool();Object.assign(f.state.rows[0],{retirement_key:'private-retirement-key',retirement_state:'unknown'});
    f.state.singleDetails.set(42,{...f.state.live[0],provider_status:'DELETED'});
    f.state.transactionError=42;f.state.available='20.00';
    const before=structuredClone(f.state.rows);
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,true);assert.equal(result.result.selection.card_id,43);
    assert.equal(result.result.selection.maintenance.current_size,4);
    assert.equal(result.result.selection.maintenance.open_count,0);
    assert.equal(result.result.selection.maintenance.required_balance,'0.00');
    assert.ok(f.calls.some(([op,,body])=>op==='cardDetail'&&body?.card_id===42));
    assert.ok(!f.calls.some(([op,,body])=>op==='cardTransaction'&&body.card_id===42));
    assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
});
test('preflight imports observable external card history in memory without exposing transactions',async()=>{
    const f=fixture();f.state.rows=[];f.state.transactions.set(42,[authorization('private-transaction-one'),authorization('private-transaction-two')]);
    Object.assign(f.state.live[0],{card_number:'5556597912341234',cvv:'private-cvv',merchant:'private-merchant'});
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,true);assert.equal(result.result.selection.action,'pay');
    const card=result.result.selection.cards[0];assert.equal(card.card_id,42);assert.equal(card.authorization_count,2);assert.equal(card.authorization_limit,7);
    assert.ok(Date.parse(card.authorizations_checked_at));assert.deepEqual(f.state.rows,[]);assert.deepEqual(f.writes,[]);
    const output=JSON.stringify([result,f.events]);
    for(const secret of ['5556597912341234','private-cvv','private-merchant','private-transaction'])assert.ok(!output.includes(secret));
});
test('preflight follows the seven-authorization boundary using all transaction pages',async()=>{
    for(const [count,action] of [[0,'pay'],[6,'pay'],[7,'open'],[102,'open']]) {
        const f=fixture();f.state.transactions.set(42,Array.from({length:count},(_,i)=>authorization('live-'+i)));
        const before=structuredClone(f.state.rows), result=await f.service.preflight({stage:'cards',plan_type:'plus'});
        assert.equal(result.passed,true);assert.equal(result.result.selection.action,action);assert.equal(result.result.selection.cards[0].authorization_count,count);
        assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
        if(count===102)assert.deepEqual(f.calls.filter(([operation])=>operation==='cardTransaction').map(call=>call[2].page),[1,2]);
    }
});
test('persisted authorization IDs survive settlement conversion and merge new authorizations once',async()=>{
    const f=fixture();f.state.rows[0].authorization_count=6;
    f.state.transactions.set(42,[{...authorization('saved-42-0'),transaction_type:'Settlement'},authorization('saved-42-1'),authorization('new-authorization')]);
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.result.selection.cards[0].authorization_count,7);assert.equal(result.result.selection.action,'open');
    assert.equal(f.state.rows[0].authorization_count,6);assert.deepEqual(f.writes,[]);
});
test('preflight reads busy but not deleted cards without leaking active job identifiers',async()=>{
    const f=fixture();f.state.live.push({...f.state.live[0],card_id:43},{...f.state.live[0],card_id:44,provider_status:'DELETED'});
    f.state.rows.push({card_id:43,authorization_count:3,active_job:'private-active-job'},{card_id:44,authorization_count:7});f.state.rows[0].authorization_count=7;
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,false);assert.equal(result.result.selection.action,'wait');
    assert.deepEqual(result.result.selection.cards.map(card=>[card.card_id,card.authorization_count,card.busy]),[[42,7,false],[43,3,true],[44,null,false]]);
    assert.deepEqual(f.calls.filter(([op])=>op==='cardTransaction').map(call=>call[2].card_id),[42,43]);
    assert.ok(!JSON.stringify([result,f.events]).includes('private-active-job'));assert.deepEqual(f.writes,[]);
});
test('database count and authorization ledger failures never imply zero usage',async()=>{
    for(const type of ['countReadError','ledgerError']) {
        const f=fixture();f.state[type]=Error('private-db-connection-info');const before=structuredClone(f.state.rows);
        const result=await f.service.preflight({stage:'full',plan_type:'plus',session});
        assert.equal(result.passed,false);assert.equal(result.ready,false);
        assert.ok(!JSON.stringify([result,f.events]).includes('private-db-connection-info'));
        assert.ok(!f.calls.some(([operation])=>operation==='cardDetail'));assert.deepEqual(f.state.rows,before);assert.deepEqual(f.writes,[]);
    }
});
test('one unreadable card halts pool preview even when another card could pay',async()=>{
    const f=fixture();f.state.live.push({...f.state.live[0],card_id:43});f.state.rows.push({card_id:43,authorization_count:0});
    f.state.transactions.set(42,Array.from({length:5},(_,i)=>authorization('live-'+i)));f.state.transactionError=43;
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,false);assert.equal(result.result.selection.action,'wait');assert.equal(result.result.selection.card_id,null);
    assert.deepEqual(result.result.selection.cards.map(card=>card.authorization_count),[5,null]);
    assert.deepEqual(result.result.selection.waiting,[{card_id:43,reason:'authorizations_unconfirmed'}]);
    assert.ok(!f.calls.some(([operation])=>operation==='cardDetail'));assert.deepEqual(f.writes,[]);
});
test('unknown authorization statuses and inconsistent saved counts stop preflight',async()=>{
    const unknown=fixture();unknown.state.transactions.set(42,[{...authorization('unknown'),status:'unrecognized'}]);
    assert.equal((await unknown.service.preflight({stage:'cards',plan_type:'plus'})).passed,false);
    const corrupt=fixture();corrupt.state.rows[0].authorization_count=2;corrupt.state.savedIds.set(42,['only-one']);
    assert.equal((await corrupt.service.preflight({stage:'cards',plan_type:'plus'})).passed,false);assert.deepEqual(corrupt.writes,[]);
});
test('authorization IDs added after the card snapshot do not cause a false count mismatch',async()=>{
    const f=fixture();f.state.rows[0].authorization_count=0;
    f.state.savedIds.set(42,['authorization-added-after-snapshot']);
    f.state.transactions.set(42,[]);
    const result=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(result.passed,true);assert.equal(result.result.selection.action,'pay');
    assert.equal(result.result.selection.cards[0].authorization_count,1);
    assert.equal(f.state.rows[0].authorization_count,0);assert.deepEqual(f.writes,[]);
});
test('an idle card awaiting authorization stays excluded while preflight permits an on-demand replacement',async()=>{
    const f=fixture();f.state.rows[0].authorization_pending_count=1;
    const waiting=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(waiting.passed,true);assert.equal(waiting.result.selection.action,'open');assert.equal(waiting.result.selection.cards[0].authorization_pending,true);
    assert.equal(waiting.result.selection.card_id,null);assert.equal(waiting.result.selection.skipped[0].reason,'authorization_pending');
    f.state.transactions.set(42,[authorization('new')]);
    const ready=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(ready.passed,true);assert.equal(ready.result.selection.action,'pay');assert.equal(ready.result.selection.cards[0].authorization_pending,false);
    assert.equal(f.state.rows[0].authorization_count,0);assert.deepEqual(f.writes,[]);
});

test('preflight excludes a cooling card even with synchronized authorization and a high balance',async()=>{
    const f=fixture();f.state.rows[0].authorization_pending_count=1;
    f.state.rows[0].reuse_after_ms=Date.now()+300000;
    f.state.transactions.set(42,[authorization('new')]);
    const response=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(response.passed,false);
    assert.equal(response.result.selection.action,'wait');
    assert.equal(response.result.selection.waiting[0].reason,'cooldown');
    assert.deepEqual(f.writes,[]);
});
test('preflight permits one on-demand opening beyond five inactive cards',async()=>{
    const f=managedPool(6);
    for(const card of f.state.live)card.provider_status='CANCELLED';
    const response=await f.service.preflight({stage:'cards',plan_type:'plus'});
    assert.equal(response.passed,true);assert.equal(response.result.selection.action,'open');
    assert.equal(response.result.selection.maintenance.open_count,1);
    assert.equal(response.result.selection.maintenance.required_balance,'20.00');
    assert.deepEqual(response.result.selection.waiting,[]);assert.deepEqual(f.writes,[]);
});

test('invalid Session, disabled region, insufficient balance and broken batch details stop the read-only chain',async()=>{
    await assert.rejects(fixture().service.preflight({stage:'session',request_id:'../../bad',session}));
    const invalid=fixture();const bad=await invalid.service.preflight({stage:'full',plan_type:'plus',session:'not-json never-log-access'});
    assert.equal(bad.passed,false);assert.deepEqual(invalid.calls,[]);assert.ok(!JSON.stringify(invalid.events).includes('never-log-access'));
    const region=fixture();region.cfg.orbitcard_payment_regions.plus='JP';
    assert.equal((await region.service.preflight({stage:'full',plan_type:'plus',session})).ready,false);
    assert.ok(!region.calls.some(c=>c[0]==='getCardList'));
    const funds=fixture();funds.state.available='0.01';funds.state.details=[{...funds.state.live[0],balance_amount:'2.00'}];
    assert.equal((await funds.service.preflight({stage:'cards',plan_type:'plus'})).passed,false);
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
