'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
function setup(syncResponse, transactionResponse, localResponse, applicationResponse) {
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('function renderCardRow('),source.indexOf('async function loadCdkPlans('));
    const nodes=new Map();
    const $=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,replaceChildren(){},add(){}});
        return nodes.get(id);
    };
    const card={card_id:42,provider_status:'ACTIVE',balance:'20.00',currency:'USD',successful_order_count:null,successful_order_limit:7,last4:'4139'};
    const calls=[],notices=[];
    const request=async (url,body)=>{
        calls.push(url);
        if(url.endsWith('/apply'))return applicationResponse(body);
        if(url.endsWith('/sync'))return syncResponse();
        if(url.includes('/transactions?'))return transactionResponse(card);
        if(localResponse)return localResponse(card);
        return {cards:[card],issues:[],fundings:[]};
    };
    const escapeHtml=value=>String(value ?? '').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const api=new Function('$','request','escapeHtml','cardPlans','Option','notice',block+'\nreturn {loadCards,synchronizeCards,loadCardTransactions,applyCard};')(
        $,request,escapeHtml,{plus:'Plus'},function(){},(text,type)=>notices.push({text,type}));
    return {api,$,card,calls,notices};
}
test('local refresh labels cached balances and does not show green live ACTIVE',async()=>{
    const f=setup(()=>{throw new Error('must not call platform');});
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/本地快照/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/card-provider-status active/);
    assert.match(f.$('cardSyncState').textContent,/不会调用平台/);
    assert.match(f.$('cardSyncState').textContent,/API 不可见的网页订单不计入/);
});

test('an idle card below its configured successful order limit remains available',async()=>{
    const f=setup(()=>{});
    f.card.successful_order_count=2;
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/空闲/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/暂不分配|停止分配/);
    assert.match(f.$('cardRows').innerHTML,/满额后自动停用并补开一张/);
});

test('deleted and unavailable cards are omitted from rows after local refresh',async()=>{
    for(const status of ['DELETED','UNAVAILABLE']) {
        const f=setup(()=>{});
        f.card.provider_status=status;
        await f.api.loadCards();
        assert.match(f.$('cardRows').innerHTML,/尚无卡片/);
        assert.doesNotMatch(f.$('cardRows').innerHTML,/data-card-transactions/);
    }
});
test('failed platform sync retains visible warning with old balances and re-enables retry',async()=>{
    const reason='卡片 42 第 1 页：HTTP 403，接口权限不足';
    const f=setup(()=>{throw new Error(reason);});
    await assert.rejects(f.api.synchronizeCards(),{message:reason});
    assert.match(f.$('cardRows').innerHTML,/同步失败.*旧快照/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/card-provider-status active/);
    assert.match(f.$('cardSyncState').textContent,/不能用于确认/);
    assert.ok(f.$('cardSyncState').textContent.includes(reason));
    assert.match(f.$('cardRows').innerHTML,/待同步 笔成功会员订单/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/0 笔成功会员订单/);
    assert.equal(f.$('syncCards').disabled,false);
    assert.equal(f.$('loadCards').disabled,false);
});

test('sync failure details remain plain text and a successful retry clears the old reason',async()=>{
    const reason='<img src=x onerror="alert(1)">';
    let attempts=0;
    const f=setup(()=>{
        if(!attempts++)throw new Error(reason);
        return {count:1,synced_ids:[42],failed_ids:[],listed_ids:[42],checked_at:'2026-11-05T12:00:00Z',message:'ok'};
    });
    Object.defineProperty(f.$('cardSyncState'),'innerHTML',{set(){throw Error('error details must use textContent');}});
    await assert.rejects(f.api.synchronizeCards(),{message:reason});
    assert.ok(f.$('cardSyncState').textContent.includes(reason));
    assert.ok(!f.$('cardRows').innerHTML.includes(reason));
    await f.api.synchronizeCards();
    assert.match(f.$('cardSyncState').textContent,/查询完成/);
    assert.ok(!f.$('cardSyncState').textContent.includes(reason));
    assert.doesNotMatch(f.$('cardRows').innerHTML,/同步失败/);
});

test('sync failure retains the platform reason when the local snapshot also fails to load',async()=>{
    const f=setup(()=>{throw new Error('HTTP 403');},null,()=>{throw new Error('local unavailable');});
    await assert.rejects(f.api.synchronizeCards(),/HTTP 403/);
    assert.match(f.$('cardSyncState').textContent,/HTTP 403.*本地记录也读取失败.*无法确认/);
    assert.match(f.$('cardRows').innerHTML,/同步及本地记录读取失败/);
    assert.equal(f.$('syncCards').disabled,false);
    assert.equal(f.$('loadCards').disabled,false);
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

test('an exhausted card remains visibly unavailable even when the provider is active or missing',async()=>{
    const f=setup(()=>{});
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/待同步/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/data-update-card-usage|data-bind-card/);
    Object.assign(f.card,{successful_order_count:3,quota_exhausted:true,disabled_at:'2026-11-20',disabled_code:'manual'});
    await f.api.loadCards({count:1,synced_ids:[42],failed_ids:[],listed_ids:[42],checked_at:'2026-11-20T12:00:00Z'});
    assert.match(f.$('cardRows').innerHTML,/3 笔成功会员订单 \/ 上限 3 笔/);
    assert.match(f.$('cardRows').innerHTML,/不可用 · 已达成功订单上限/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/data-card-availability|card-provider-status active/);
    for (const status of ['UNAVAILABLE','DELETED']) {
        f.card.provider_status=status; await f.api.loadCards();
        assert.match(f.$('cardRows').innerHTML,/不可用 · 已达成功订单上限/);
        assert.doesNotMatch(f.$('cardRows').innerHTML,/data-card-transactions/);
    }
    Object.assign(f.card,{provider_status:'ACTIVE',successful_order_count:2,quota_exhausted:false,disabled_at:null,retiring:true});
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/待核对旧删卡记录/);
});

test('a pending replacement shows a warning while synchronized card details stay fresh',async()=>{
    const f=setup(()=>({count:1,synced_ids:[42],failed_ids:[],listed_ids:[42],checked_at:'2026-11-20T12:00:00Z',
        message:'已同步',replacement_warning:'账户余额不足'}));
    await f.api.synchronizeCards();
    assert.match(f.$('cardSyncState').textContent,/查询完成.*补开待处理.*账户余额不足/);
    assert.match(f.$('cardRows').innerHTML,/本次同步/);
});

test('manual usage editor is removed',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8'),/cardHistoryState/);
    assert.doesNotMatch(source,/async function saveCardUsage|data-bind-card|data-update-card-usage|cardHistoryState|data-open-card-history|data-manage-card-history/);
});

test('an uncertain card application preserves its original error even when the record refresh fails',async()=>{
    for(const refreshFails of [false,true]) {
        const original=Object.assign(Error('original application pending'),{httpStatus:400});
        const f=setup(null,null,refreshFails?()=>{throw Error('local unavailable');}:undefined,async body=>{
            assert.deepEqual(body,{});throw original;
        });
        await assert.rejects(f.api.applyCard(),error=>error===original);
        assert.deepEqual(f.calls,['/api/admin/orbitcard/cards/apply','/api/admin/orbitcard/cards']);
        assert.match(f.$('cardApplicationState').textContent,/original application pending.*确认原开卡/);
        if(refreshFails)assert.match(f.$('cardApplicationState').textContent,/本地记录刷新失败.*local unavailable/);
        assert.deepEqual(f.notices,[],'an uncertain application must not display success');
    }
});

test('a successful card application stays successful if refreshing the local list fails',async()=>{
    for(const refreshFails of [false,true]) {
        const result={success:true,message:'开卡成功，首充 20 USD',card:{card_id:77}};
        const f=setup(null,null,refreshFails?()=>{throw Error('local unavailable');}:undefined,async body=>{
            assert.deepEqual(body,{});return result;
        });
        assert.equal(await f.api.applyCard(),result);
        assert.deepEqual(f.calls,['/api/admin/orbitcard/cards/apply','/api/admin/orbitcard/cards']);
        assert.match(f.$('cardApplicationState').textContent,/开卡成功，首充 20 USD/);
        if(refreshFails) {
            assert.match(f.$('cardApplicationState').textContent,/刷新失败.*刷新本地记录/);
            assert.match(f.$('cardSyncState').textContent,/当前列表未更新/);
        }
        assert.equal(f.notices.length,1);assert.equal(f.notices[0].type,'success');
    }
});

test('a completed synchronization is not reported as a platform failure when local refresh fails',async()=>{
    const f=setup(()=>({message:'已同步 1 张卡片详情；会员订单新增 2 笔',failed_ids:[]}),null,()=>{throw Error('local unavailable');});
    await f.api.synchronizeCards();
    assert.deepEqual(f.calls,['/api/admin/orbitcard/cards/sync','/api/admin/orbitcard/cards']);
    assert.match(f.$('cardSyncState').textContent,/已同步 1 张.*新增 2 笔.*本地列表刷新失败.*刷新本地记录/);
    assert.doesNotMatch(f.$('cardSyncState').textContent,/平台同步失败/);
    assert.equal(f.$('syncCards').disabled,false);assert.equal(f.$('loadCards').disabled,false);
});

test('viewing transactions refreshes authorization counts without maintaining the pool',async()=>{
    const f=setup(()=>{throw Error('must not maintain pool');},card=>{card.successful_order_count=3;card.authorizations_checked_at='2026-11-05T12:00:00Z';return {data:{transactions:[
        {id:'authorization',transaction_type:'Authorization',status:'completed'},
        {id:'settlement',transaction_type:'Settlement',status:'completed'}
    ]}};});
    f.card.successful_order_count=2;await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/2 笔成功会员订单/);
    f.$('transactionCardId').value='42';f.$('transactionPage').value='1';
    await f.api.loadCardTransactions();
    assert.deepEqual(f.calls,['/api/admin/orbitcard/cards','/api/admin/orbitcard/cards/42/transactions?page=1','/api/admin/orbitcard/cards']);
    assert.match(f.$('cardRows').innerHTML,/3 笔成功会员订单/);
    assert.match(f.$('cardRows').innerHTML,/授权流水仅供对账/);
    assert.equal(JSON.parse(f.$('cardTransactions').textContent).transactions.length,2);
    assert.equal(f.$('loadTransactions').disabled,false);
});

test('transaction query failures replace stale results with an error and preserve the old count',async()=>{
    const f=setup(()=>{},()=>{throw Error('HTTP 403');});
    f.card.successful_order_count=3;await f.api.loadCards();
    f.$('transactionCardId').value='42';f.$('transactionPage').value='1';
    f.$('cardTransactions').textContent='previous response';
    await assert.rejects(f.api.loadCardTransactions(),/HTTP 403/);
    assert.match(f.$('cardTransactions').textContent,/查询失败.*HTTP 403.*授权次数未更新/);
    assert.match(f.$('cardRows').innerHTML,/3 笔成功会员订单/);
    assert.equal(f.$('loadTransactions').disabled,false);
});

test('task rows distinguish unallocated payments from legacy records without obsolete registration actions',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('function renderTasks('),source.indexOf('async function loadOverview('));
    const node={innerHTML:''};
    const render=new Function('$','escapeHtml','status',block+'\nreturn renderTasks;')(
        ()=>node,value=>String(value??'').replaceAll('<','&lt;'),value=>value);
    render([{provider:'orbitcard',orbitcard_state:'rejected',status:'failed',message:'旧卡历史次数尚未确认'}]);
    assert.match(node.innerHTML,/尚未分配支付卡/);
    assert.doesNotMatch(node.innerHTML,/data-manage-card-history/);
    render([{provider:'history',status:'failed'}]);
    assert.match(node.innerHTML,/历史未绑定/);
    assert.doesNotMatch(node.innerHTML,/data-manage-card-history/);
    render([{provider:'orbitcard',orbitcard_state:'success',status:'success'}]);
    assert.match(node.innerHTML,/未记录支付卡/);
    render([{provider:'orbitcard',orbitcard_state:'success',status:'success',card_id:42}]);
    assert.match(node.innerHTML,/卡 ID：42/);
});
