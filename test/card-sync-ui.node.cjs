'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
function setup(syncResponse, transactionResponse, localResponse) {
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const block=source.slice(source.indexOf('function renderCardRow('),source.indexOf('async function loadCdkPlans('));
    const nodes=new Map();
    const $=id=>{
        if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,replaceChildren(){},add(){}});
        return nodes.get(id);
    };
    const card={card_id:42,provider_status:'ACTIVE',balance:'20.00',currency:'USD',authorization_count:null,authorization_limit:7,last4:'4139'};
    const calls=[];
    const request=async url=>{
        calls.push(url);
        if(url.endsWith('/sync'))return syncResponse();
        if(url.includes('/transactions?'))return transactionResponse(card);
        if(localResponse)return localResponse(card);
        return {cards:[card],issues:[],fundings:[]};
    };
    const escapeHtml=value=>String(value ?? '').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const api=new Function('$','request','escapeHtml','cardPlans','Option','notice',block+'\nreturn {loadCards,synchronizeCards,loadCardTransactions};')(
        $,request,escapeHtml,{plus:'Plus'},function(){},()=>{});
    return {api,$,card,calls};
}
test('local refresh labels cached balances and does not show green live ACTIVE',async()=>{
    const f=setup(()=>{throw new Error('must not call platform');});
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/本地快照/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/card-provider-status active/);
    assert.match(f.$('cardSyncState').textContent,/不会调用平台/);
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
    assert.match(f.$('cardRows').innerHTML,/待同步 \/ 7 次成功消费授权/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/0 \/ 7 次成功消费授权/);
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

test('authorization usage shows synchronized counts, pending counts and retirement states',async()=>{
    const f=setup(()=>{}); f.card.authorization_limit=7;
    await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/待同步/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/data-update-card-usage|data-bind-card/);
    f.card.authorization_count=6; await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/6 \/ 7 次成功消费授权/);
    assert.doesNotMatch(f.$('cardRows').innerHTML,/达到上限，停止分配/);
    f.card.authorization_count=7; await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/7 \/ 7 次成功消费授权/);
    assert.match(f.$('cardRows').innerHTML,/达到上限，停止分配/);
    f.card.authorization_count=6;f.card.authorization_pending=true;await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/等待授权同步/);
    f.card.retiring=true; await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/待确认删卡/);
});

test('manual usage editor is removed',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8'),/cardHistoryState/);
    assert.doesNotMatch(source,/async function saveCardUsage|data-bind-card|data-update-card-usage|cardHistoryState|data-open-card-history|data-manage-card-history/);
});

test('shared-pool card application submits no plan and refreshes original records after an uncertain result',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
    const html=fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8');
    assert.doesNotMatch(html,/id="applyPlan"|申请关联套餐/);
    const line=source.split(/\r?\n/).find(line=>line.startsWith("form('applyCardForm',"));
    let submit;
    const calls=[];
    new Function('form','request','notice','loadCards',line)(
        (name,handler)=>{assert.equal(name,'applyCardForm');submit=handler;},
        async(url,body)=>{calls.push({url,body});throw Error('original application pending');},
        ()=>{throw Error('an uncertain application must not display success');},
        async()=>{calls.push({refresh:true});});
    await assert.rejects(submit(),/original application pending/);
    assert.deepEqual(calls,[{url:'/api/admin/orbitcard/cards/apply',body:{}},{refresh:true}]);
});

test('viewing transactions refreshes authorization counts without maintaining the pool',async()=>{
    const f=setup(()=>{throw Error('must not maintain pool');},card=>{card.authorization_count=3;card.authorizations_checked_at='2026-11-05T12:00:00Z';return {data:{transactions:[
        {id:'authorization',transaction_type:'Authorization',status:'completed'},
        {id:'settlement',transaction_type:'Settlement',status:'completed'}
    ]}};});
    f.card.authorization_count=2;await f.api.loadCards();
    assert.match(f.$('cardRows').innerHTML,/2 \/ 7 次成功消费授权/);
    f.$('transactionCardId').value='42';f.$('transactionPage').value='1';
    await f.api.loadCardTransactions();
    assert.deepEqual(f.calls,['/api/admin/orbitcard/cards','/api/admin/orbitcard/cards/42/transactions?page=1','/api/admin/orbitcard/cards']);
    assert.match(f.$('cardRows').innerHTML,/3 \/ 7 次成功消费授权/);
    assert.match(f.$('cardRows').innerHTML,/授权统计时间：2026/);
    assert.equal(JSON.parse(f.$('cardTransactions').textContent).transactions.length,2);
    assert.equal(f.$('loadTransactions').disabled,false);
});

test('transaction query failures replace stale results with an error and preserve the old count',async()=>{
    const f=setup(()=>{},()=>{throw Error('HTTP 403');});
    f.card.authorization_count=3;await f.api.loadCards();
    f.$('transactionCardId').value='42';f.$('transactionPage').value='1';
    f.$('cardTransactions').textContent='previous response';
    await assert.rejects(f.api.loadCardTransactions(),/HTTP 403/);
    assert.match(f.$('cardTransactions').textContent,/查询失败.*HTTP 403.*授权次数未更新/);
    assert.match(f.$('cardRows').innerHTML,/3 \/ 7 次成功消费授权/);
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
