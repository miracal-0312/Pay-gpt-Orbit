'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
function setup(syncResponse, confirmed = true) {
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('function renderCardRow('),source.indexOf('async function loadCdkPlans('));
    const nodes=new Map();
    const $=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,replaceChildren(){},add(){}});
        return nodes.get(id);
    };
    const card={card_id:42,provider_status:'ACTIVE',balance:'20.00',currency:'USD',history_confirmed:confirmed,
        usage:{plus:{successful:0,limit:4}},last4:'4139'};
    const request=async url=>url.endsWith('/sync')?await syncResponse():{cards:[card],issues:[],fundings:[]};
    const escapeHtml=value=>String(value ?? '').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const api=new Function('$','request','escapeHtml','cardPlans','Option','notice',block+'\nreturn {loadCards,synchronizeCards};')(
        $,request,escapeHtml,{plus:'Plus'},function(){},()=>{});
    return {api,$,card};
}
test('local refresh labels cached balances and does not show green live ACTIVE',async()=>{
    const f=setup(()=>{throw new Error('must not call platform');});
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/本地快照/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/card-provider-status active/);
    assert.match(f.$('cardSyncState').textContent,/不会调用平台/);
});
test('failed platform sync retains visible warning with old balances and re-enables retry',async()=>{
    const f=setup(()=>{throw new Error('detail unavailable');});
    await assert.rejects(f.api.synchronizeCards(),/detail unavailable/);
    assert.match(f.$('cardRows').innerHTML,/同步失败.*旧快照/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/card-provider-status active/);
    assert.match(f.$('cardSyncState').textContent,/不能用于确认/);
    assert.equal(f.$('syncCards').disabled,false);
});
test('successful and partial sync distinguish confirmed rows from stale ones',async()=>{
    const f=setup(()=>({count:1,synced_ids:[42],failed_ids:[],listed_ids:[42],checked_at:'2026-10-21T12:00:00Z',message:'ok'}));
    await f.api.synchronizeCards();
    assert.match(f.$('cardRows').innerHTML,/本次同步：2026/);
    assert.match(f.$('cardRows').innerHTML,/card-provider-status active/);
    await f.api.loadCards({count:0,synced_ids:[],failed_ids:[42],listed_ids:[42],checked_at:'2026-10-21T12:01:00Z'});
    assert.match(f.$('cardRows').innerHTML,/详情读取失败.*旧快照/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/card-provider-status active/);
});

test('unconfirmed cards expose registration links and disappear from the reminder once confirmed',async()=>{
    const f=setup(()=>{throw new Error('local snapshot must not call platform');},false);
    await f.api.loadCards();
    assert.equal(f.$('cardHistoryState').hidden,false);
    assert.match(f.$('cardHistoryState').innerHTML,/1 张卡待登记历史次数/);
    assert.match(f.$('cardHistoryState').innerHTML,/data-open-card-history="42"/);
    assert.match(f.$('cardRows').innerHTML,/id="card-history-42"/);
    f.card.history_confirmed=true;
    await f.api.loadCards();
    assert.equal(f.$('cardHistoryState').hidden,true);
    assert.equal(f.$('cardHistoryState').innerHTML,'');
    assert.doesNotMatch(f.$('cardRows').innerHTML,/id="card-history-42"/);
    assert.match(f.$('cardRows').innerHTML,/修改历史次数/);
    assert.match(f.$('cardRows').innerHTML,/data-update-card-usage="42"/);
});

test('confirmed history correction pre-fills counts and is unavailable for occupied cards',async()=>{
    const f=setup(()=>{});
    f.card.usage.plus.successful=3;
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/data-previous-usage="3" value="3"/);
    assert.match(f.$('cardRows').innerHTML,/修改原因/);
    f.card.active_job='running-job';
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/任务占用中，暂不可修改/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/data-update-card-usage/);
});

test('history editor sends all totals, original values and reason; failed saves preserve edits for retry',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('async function saveCardUsage('),source.indexOf('async function loadCards('));
    const plans={plus:'Plus',pro100:'Pro 100',pro200:'Pro 200',pro500:'Pro 500'};
    const inputs=Object.fromEntries(Object.keys(plans).map(plan=>[plan,{value:plan==='plus'?'2':'0',dataset:{previousUsage:plan==='plus'?'4':'1'},checkValidity:()=>true}]));
    const reason={value:' 人工修正 '},button={disabled:false,dataset:{updateCardUsage:'42'}};
    const requests=[]; let refreshes=0, fail=false;
    const save=new Function('document','$','cardPlans','request','loadCards','notice',block+'\nreturn saveCardUsage;')(
        {querySelector:selector=>inputs[selector.match(/42-(\w+)/)[1]]},()=>reason,plans,
        async(url,body)=>{requests.push({url,body});if(fail)throw new Error('卡片次数已发生变化');return {message:'已修改'};},
        async()=>{refreshes++;},()=>{});
    reason.value=''; await assert.rejects(save(button),/修改原因/); assert.equal(requests.length,0);
    reason.value=' 人工修正 '; await save(button);
    assert.deepEqual(requests[0],{url:'/api/admin/orbitcard/cards/42/usage',body:{usage:{plus:2,pro100:0,pro200:0,pro500:0},
        expected_usage:{plus:4,pro100:1,pro200:1,pro500:1},reason:'人工修正'}});
    assert.equal(refreshes,1); assert.equal(button.disabled,false);
    fail=true; await assert.rejects(save(button),/已发生变化/);
    assert.equal(refreshes,1); assert.equal(button.disabled,false); assert.equal(inputs.plus.value,'2');
});

test('task rows distinguish unallocated payments from legacy records and link history failures to registration',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('function renderTasks('),source.indexOf('async function loadOverview('));
    const node={innerHTML:''};
    const render=new Function('$','escapeHtml','status',block+'\nreturn renderTasks;')(
        ()=>node,value=>String(value??'').replaceAll('<','&lt;'),value=>value);
    render([{provider:'orbitcard',orbitcard_state:'rejected',status:'failed',message:'旧卡历史次数尚未确认'}]);
    assert.match(node.innerHTML,/尚未分配支付卡/);
    assert.match(node.innerHTML,/data-manage-card-history/);
    render([{provider:'history',status:'failed'}]);
    assert.match(node.innerHTML,/历史未绑定/);
    assert.doesNotMatch(node.innerHTML,/data-manage-card-history/);
    render([{provider:'orbitcard',orbitcard_state:'success',status:'success'}]);
    assert.match(node.innerHTML,/未记录支付卡/);
    render([{provider:'orbitcard',orbitcard_state:'success',status:'success',card_id:42}]);
    assert.match(node.innerHTML,/卡 ID：42/);
});
