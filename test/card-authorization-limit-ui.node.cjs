'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../public/admin.js'),'utf8');
const html=fs.readFileSync(require.resolve('../public/admin.html'),'utf8');
function inputFixture() {
    const nodes={apiEnabled:{checked:true},baseUrl:{value:'https://orbitcard.test'},maxInitialAmount:{value:''},maxFee:{value:''},productCodes:{selectedOptions:[{value:'p1'},{value:'p2'}]},cardBins:{selectedOptions:[{value:'555659'},{value:'537000'}]}};
    const block=source.slice(source.indexOf('function apiInput()'),source.indexOf('function renderCardRow('));
    const input=new Function('$','cardPlans','selectedOpeningValues',block+'\nreturn apiInput;')(id=>nodes[id],{},id=>Array.from(nodes[id].selectedOptions,option=>option.value));
    return {nodes,input};
}
test('opening settings provide independent multi-select channels and BINs in the existing save form',()=>{
    const form=html.match(/<form id="apiForm"[^>]*>[\s\S]*?<\/form>/)[0];
    assert.match(form,/<select id="productCodes" multiple/);assert.match(form,/<select id="cardBins" multiple/);
    assert.match(form,/保存配置/);assert.doesNotMatch(form,/id="cardAuthorizationLimit"/);
    assert.match(html,/id="cardAvailabilityReason"[^>]*required/);
});
test('configuration serializes multiple product codes and BINs while an empty selection allows all',()=>{
    const f=inputFixture();assert.deepEqual(f.input().orbitcard_product_codes,['p1','p2']);assert.deepEqual(f.input().orbitcard_bins,['555659','537000']);
    f.nodes.productCodes.selectedOptions=[];assert.deepEqual(f.input().orbitcard_product_codes,[]);
    assert.equal(Object.hasOwn(f.input(),'orbitcard_max_authorizations'),false);
});
test('configuration reload migrates a saved singular product and preserves multiple choices',async()=>{
    const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',dataset:{}});return nodes.get(id);};
    const block=source.slice(source.indexOf('async function loadApi()'),source.indexOf('let openingProducts ='));
    let config={base_url:'https://orbitcard.test',orbitcard_product_code:'legacy'},selection;
    const load=new Function('$','request','cardPlans','renderPaymentRegionOptions','renderOpeningChoices','let savedBaseUrl,paymentRegionLoadSequence=0;'+block+'\nreturn loadApi;')(node,async()=>({config}),{},()=>{},(_products,codes,bins)=>{selection={codes,bins};});
    await load();assert.deepEqual(selection,{codes:['legacy'],bins:[]});
    config={base_url:'https://orbitcard.test',orbitcard_product_codes:['p1','p2'],orbitcard_bins:['555659','537000']};
    await load();assert.deepEqual(selection,{codes:['p1','p2'],bins:['555659','537000']});
});
test('backend validation failures preserve the edited opening selections',async()=>{
    const f=inputFixture(),calls=[];let handler,reloads=0,reject=false;
    const block=source.slice(source.indexOf("form('apiForm'"),source.indexOf('const diagnosticLines'));
    new Function('form','request','apiInput','notice','loadApi',block)((_id,fn)=>{handler=fn;},async(url,body)=>{calls.push({url,body});if(reject)throw Error('invalid choices');return {message:'saved'};},f.input,()=>{},async()=>{reloads++;});
    await handler();assert.equal(calls[0].url,'/api/admin/gpt-api');assert.deepEqual(calls[0].body.orbitcard_product_codes,['p1','p2']);
    reject=true;await assert.rejects(handler(),/invalid choices/);assert.equal(reloads,1);assert.deepEqual(f.input().orbitcard_product_codes,['p1','p2']);
});
test('card rows enforce the usage limit and offer manual restore below the limit',()=>{
    const block=source.slice(source.indexOf('function renderCardRow('),source.indexOf('async function loadCards('));
    const render=new Function('escapeHtml',block+'\nreturn renderCardRow;')(value=>String(value??'').replaceAll('<','&lt;'));
    const card={card_id:42,successful_order_count:999,provider_status:'ACTIVE'};
    assert.match(render(card),/999 笔成功会员订单/);assert.doesNotMatch(render(card),/data-card-availability/);
    card.successful_order_count=2;
    assert.match(render(card),/人工停用/);
    card.disabled_at='2026-11-16';card.disabled_reason='<invalid card>';
    assert.match(render(card),/恢复使用/);assert.match(render(card),/&lt;invalid card>/);
    assert.doesNotMatch(render(card),/card-provider-status active/);
});
