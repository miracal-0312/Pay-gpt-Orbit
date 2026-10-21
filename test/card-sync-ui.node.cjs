'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
function setup(syncResponse) {
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('function renderCardRow('),source.indexOf('async function loadCdkPlans('));
    const nodes=new Map();
    const $=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,replaceChildren(){},add(){}});
        return nodes.get(id);
    };
    const card={card_id:42,provider_status:'ACTIVE',balance:'20.00',currency:'USD',history_confirmed:true,
        usage:{plus:{successful:0,limit:4}},last4:'4139'};
    const request=async url=>url.endsWith('/sync')?await syncResponse():{cards:[card],issues:[],fundings:[]};
    const escapeHtml=value=>String(value ?? '').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const api=new Function('$','request','escapeHtml','cardPlans','Option','notice',block+'\nreturn {loadCards,synchronizeCards};')(
        $,request,escapeHtml,{plus:'Plus'},function(){},()=>{});
    return {api,$};
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
