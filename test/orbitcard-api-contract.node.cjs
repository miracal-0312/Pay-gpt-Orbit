'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {OPERATIONS} = require('../orbitcard-api-contract');

const requests = {
    getAccountBalance: {}, getProductCode: {}, getSubscriptionPlans: {},
    getSubscriptionPaymentRegions: {plan_type:'gpt-plus'},
    getSubscription: {client_order_no:'persisted-order'},
    getCardList: {page:1,page_size:100},
    cardDetail: {card_ids:[42],reveal_sensitive:false},
    cardTransaction: {card_id:42,page:1,page_size:100},
    getCardFlow: {card_id:42,type:'recharge',page:1,page_size:100},
    createCard: {product_code:'SAVE',amount:'20.00',quantity:1},
    rechargeCard: {card_id:42,amount:'10.50'}, deleteCard: {card_id:42},
    createSubscription: {client_order_no:'persisted-order',plan_type:'gpt-plus',card_id:42,
        session_json:{user:{email:'fixture@example.invalid'},accessToken:'synthetic-token'},authorized:true,max_service_fee:'0.15'}
};
function fixture(t) {
    const originalKey=process.env.ORBITCARD_API_KEY, originalSecret=process.env.ORBITCARD_API_SECRET;
    process.env.ORBITCARD_API_KEY='contract-key'; process.env.ORBITCARD_API_SECRET='contract-secret';
    t.after(()=>{
        if(originalKey===undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY=originalKey;
        if(originalSecret===undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET=originalSecret;
    });
    const calls=[],filename=path.resolve(__dirname,'../orbitcard-client.js'),module={exports:{}},real=createRequire(filename);
    const mocks={axios:{request:async input=>{calls.push(input);return {status:200,data:{code:0,data:{}},headers:{}};}},
        './runtime-log':{push(){}}};
    new Function('require','module','exports',fs.readFileSync(filename,'utf8'))(
        name=>Object.hasOwn(mocks,name)?mocks[name]:real(name),module,module.exports);
    return {api:module.exports,calls,cfg:{base_url:'https://orbitcard.test'}};
}

test('the business operation registry uses only APIs present in the current linked documents',()=>{
    const docs=['Orbitcard-Open-API-V1.md','orbitcard-subscription-api-v1.md']
        .map(file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8')).join('\n');
    const documented=new Set([...docs.matchAll(/\/api\/open\/v1\/([A-Za-z]+)/g)].map(match=>match[1]));
    assert.deepEqual(Object.keys(OPERATIONS).sort(),Object.keys(requests).sort());
    for(const operation of Object.keys(OPERATIONS)) assert.ok(documented.has(operation),operation);
    assert.ok(Object.isFrozen(OPERATIONS));
});

test('all retained business operations send their original JSON to signed current paths',async t=>{
    const f=fixture(t);
    for(const [operation,body] of Object.entries(requests)) {
        const spec=OPERATIONS[operation],key=spec.write?'persisted-intent':'';
        const result=await f.api.request(f.cfg,operation,body,key);
        assert.equal(result.success,true,operation);
        const actual=f.calls.at(-1);
        assert.equal(actual.url,'https://orbitcard.test'+spec.path);
        assert.equal(actual.method,'POST');assert.equal(actual.data,JSON.stringify(body));
        assert.equal(actual.headers['Idempotency-Key'],key||undefined);
        assert.match(actual.headers['X-Signature'],/^[a-f0-9]{64}$/);
    }
});

test('unknown, former, and path-shaped operations cannot reach the transport',async t=>{
    const f=fixture(t);
    for(const operation of ['inspectPay','submitPay','queryTask','../getAccountBalance','getCardList?status=ACTIVE','toString',null,{}]) {
        const result=await f.api.request(f.cfg,operation,{});
        assert.equal(result.success,false);
    }
    assert.equal(f.calls.length,0);
    for(const name of ['PLAN_MAP','DEFAULT_BASE_URL','normalizeBaseUrl']) assert.equal(f.api[name],undefined);
});

test('old fields and invalid monetary values are rejected locally before a write',async t=>{
    const f=fixture(t);
    for(const [operation,body] of [
        ['createCard',{...requests.createCard,plan_type:'plus'}],
        ['createCard',{...requests.createCard,card_number:'synthetic-pan'}],
        ['getProductCode',{gpt_plan_prices:true}],
        ['createSubscription',{...requests.createSubscription,country:'US'}],
        ['rechargeCard',{card_id:42,amount:20}],
        ['rechargeCard',{card_id:42,amount:null}],
        ['rechargeCard',{card_id:42,amount:undefined}],
        ['rechargeCard',{card_id:42,amount:'1e2'}],
        ['createSubscription',{...requests.createSubscription,max_service_fee:0.15}],
        ['getCardList',[]], ['getAccountBalance',null]
    ]) assert.equal((await f.api.request(f.cfg,operation,body,'persisted-intent')).success,false);
    assert.equal(f.calls.length,0);
});

test('every money-affecting operation requires a stable valid key and execution ownership',async t=>{
    const f=fixture(t);
    for(const operation of Object.keys(OPERATIONS).filter(name=>OPERATIONS[name].write)) {
        for(const key of ['', 'short', 'x'.repeat(129), 'line\nbreak', 42])
            assert.equal((await f.api.request(f.cfg,operation,requests[operation],key)).success,false);
        await assert.rejects(f.api.request({...f.cfg,executionGuard:{assertOwned:async()=>{throw Error('ownership lost');}}},
            operation,requests[operation],'persisted-intent'),/ownership lost/);
    }
    assert.equal(f.calls.length,0);
    for(const key of ['12345678','x'.repeat(128)])
        assert.equal((await f.api.request(f.cfg,'createCard',requests.createCard,key)).success,true);
});

test('configured decimal service-fee limits are forwarded unchanged without an undocumented precision cap',async t=>{
    const f=fixture(t), fee='0.123456789';
    const cfg=require('../orbitcard-config').prepareConfig({orbitcard_max_fee:fee});
    const prepared=require('../orbitcard-subscription-service')({}).prepare({cfg,identity:'persisted-order',
        planType:'plus',cardId:42,session:{user:{email:'fixture@example.invalid'},accessToken:'synthetic-token',account:{}}});
    assert.equal((await f.api.request(f.cfg,'createSubscription',prepared.body,'persisted-intent')).success,true);
    assert.equal(JSON.parse(f.calls[0].data).max_service_fee,fee);
});
