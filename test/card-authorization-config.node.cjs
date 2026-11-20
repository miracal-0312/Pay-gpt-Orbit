'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { prepareConfig } = require('../src/config/orbitcard-config');

function database() {
    const rows = new Map();
    const connection = {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(_sql, keys) { return [[...rows].filter(([key]) => keys.includes(key)).map(([config_key,config_value]) => ({config_key,config_value}))]; },
        async execute(sql, params) {
            if (sql.startsWith('DELETE')) params.forEach(key => rows.delete(key));
            else for (let i=0;i<params.length;i+=2) {
                if (!sql.startsWith('INSERT IGNORE') || !rows.has(params[i])) rows.set(params[i], params[i+1]);
            }
            return [{}];
        }
    };
    const filename = require.resolve('../src/db/mysql-core'), module = {exports:{}};
    const realRequire = createRequire(filename);
    new Function('require','module','exports',fs.readFileSync(filename,'utf8'))(
        id => id === 'mysql2/promise' ? {createPool:()=>({...connection,getConnection:async()=>connection})} : realRequire(id),module,module.exports);
    return {core:module.exports,rows};
}

test('opening selections migrate the legacy product and validate independent multi-select lists', () => {
    assert.deepEqual(prepareConfig({}, {orbitcard_product_code:'legacy'}).orbitcard_product_codes, ['legacy']);
    const selected=prepareConfig({orbitcard_product_codes:['p1','p2','p1'],orbitcard_bins:['555659','53700000']});
    assert.deepEqual(selected.orbitcard_product_codes,['p1','p2']);
    assert.deepEqual(selected.orbitcard_bins,['555659','53700000']);
    assert.deepEqual(prepareConfig({},selected).orbitcard_product_codes,['p1','p2']);
    assert.deepEqual(prepareConfig({orbitcard_product_codes:[]},selected).orbitcard_product_codes,[]);
    for (const value of [null, {}, 'p1', [''], [123]]) assert.throws(()=>prepareConfig({orbitcard_product_codes:value}),/多选列表/);
    for (const value of [null, ['123'], ['555659x'], [555659]]) assert.throws(()=>prepareConfig({orbitcard_bins:value}),/多选列表/);
    assert.equal(Object.hasOwn(prepareConfig({orbitcard_max_authorizations:0}),'orbitcard_max_authorizations'),false);
});

test('opening selections persist across startup and unrelated configuration edits', async () => {
    const {core,rows}=database();
    rows.set('orbitcard_product_code','legacy');
    await core.ensureGptApiConfigDefaults();
    assert.deepEqual((await core.getGptApiConfig()).orbitcard_product_codes,['legacy']);
    await core.saveGptApiConfig({orbitcard_product_codes:['p1','p2'],orbitcard_bins:['555659']});
    await core.ensureGptApiConfigDefaults();
    await core.saveGptApiConfig({orbitcard_max_fee:'2'});
    assert.deepEqual((await core.getGptApiConfig()).orbitcard_product_codes,['p1','p2']);
    assert.deepEqual(JSON.parse(rows.get('orbitcard_bins')),['555659']);
    await assert.rejects(core.saveGptApiConfig({orbitcard_bins:['broken']}),/多选列表/);
    assert.deepEqual((await core.getGptApiConfig()).orbitcard_bins,['555659']);
});

test('admin configuration returns and saves channel and BIN selections', async () => {
    const {core}=database(),routes=new Map();
    const app={get:(url,...handlers)=>routes.set('GET '+url,handlers.at(-1)),post:(url,...handlers)=>routes.set('POST '+url,handlers.at(-1)),use(){},delete(){},put(){},patch(){}};
    require('../src/http/admin-http')(app,{store:core,ensureStoreReady:async()=>{},getTotalActiveJobs:()=>0});
    const invoke=async(method,body)=>{
        const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
        await routes.get(method+' /api/admin/gpt-api')({body},res,error=>{throw error;});return res;
    };
    assert.equal((await invoke('POST',{orbitcard_product_codes:['p1','p2'],orbitcard_bins:['555659']})).statusCode,200);
    const config=(await invoke('GET')).body.config;
    assert.deepEqual(config.orbitcard_product_codes,['p1','p2']);assert.deepEqual(config.orbitcard_bins,['555659']);
    assert.equal(Object.hasOwn(config,'orbitcard_max_authorizations'),false);
    assert.equal((await invoke('POST',{orbitcard_bins:['bad']})).statusCode,400);
});

test('card snapshots expose durable disable status independently of counts and legacy cooldowns', async () => {
    const {core}=database(),routes=new Map();
    const cards=[{card_id:42,successful_order_count:999,provider_status:'ACTIVE',reuse_after_ms:Date.now()+300000},
        {card_id:43,successful_order_count:0,provider_status:'ACTIVE',disabled_at:'2026-11-16',disabled_code:'card_declined',disabled_reason:'卡片被拒绝'}];
    const app={get:(url,...handlers)=>routes.set(url,handlers.at(-1)),post(){}};
    require('../src/http/orbitcard-card-http')(app,{store:{...core,cardMethods:()=>({listCards:async()=>cards,listIssues:async()=>[],listFundings:async()=>[]})},cardService:{},requireSecondaryAuth(){}});
    const res={set(){},json(value){this.body=value;},status(){return this;}};
    await routes.get('/api/admin/orbitcard/cards')({},res);
    assert.equal(res.body.cards[0].usable,false);assert.equal(res.body.cards[0].successful_order_count,999);
    assert.equal(res.body.cards[1].usable,false);assert.equal(res.body.cards[1].disabled_reason,'卡片被拒绝');
    assert.equal(Object.hasOwn(res.body.cards[0],'successful_order_limit'),false);
    assert.equal(Object.hasOwn(res.body.cards[0],'reuse_after_ms'),false);
});

test('manual availability routes require secondary auth, validate reasons and audit the administrator', async () => {
    const f = require('./helpers/card-db.cjs')();
    await f.addCard();
    const routes = new Map(), audit = [], secondary = () => {};
    const app = { get() {}, post: (url, ...handlers) => routes.set(url, handlers) };
    const filename = require.resolve('../src/http/orbitcard-card-http'), realRequire = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        name => name === '../logging/runtime-log' ? { push: entry => audit.push(entry) } : realRequire(name), module, module.exports);
    module.exports(app, { store: { ...f.store, getGptApiConfig: async () => ({ base_url: f.base }) },
        cardService: {}, requireSecondaryAuth: secondary });
    const handlers = routes.get('/api/admin/orbitcard/cards/:cardId/availability');
    assert.equal(handlers[0], secondary);
    async function invoke(body) {
        const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
        await handlers.at(-1)({ params: { cardId: '42' }, body, admin: { email: 'admin@example.test' } }, response);
        return response;
    }
    assert.equal((await invoke({ disabled: true, reason: '' })).statusCode, 400);
    assert.equal((await invoke({ disabled: 'false', reason: 'invalid type' })).statusCode, 400);
    assert.equal(audit.length, 0);
    assert.equal((await invoke({ disabled: true, reason: '人工核对中' })).body.success, true);
    assert.equal(f.db.cards[0].disabled_code, 'manual');
    assert.equal(audit[0].data.admin, 'admin@example.test');
    assert.equal((await invoke({ disabled: false, reason: '已确认可用' })).body.success, true);
    assert.equal(f.db.cards[0].disabled_at, null);
    assert.equal(audit[1].data.disabled, false);
});
