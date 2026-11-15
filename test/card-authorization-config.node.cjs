'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { prepareConfig } = require('../orbitcard-config');

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
    const filename = require.resolve('../mysql-core'), module = {exports:{}};
    const realRequire = createRequire(filename);
    new Function('require','module','exports',fs.readFileSync(filename,'utf8'))(
        id => id === 'mysql2/promise' ? {createPool:()=>({...connection,getConnection:async()=>connection})} : realRequire(id),module,module.exports);
    return {core:module.exports,rows};
}

test('authorization limit defaults to four, permits positive safe integers and preserves omitted settings', () => {
    assert.equal(prepareConfig({}).orbitcard_max_authorizations,4);
    for (const value of [1,4,12,1001,Number.MAX_SAFE_INTEGER,'8']) {
        assert.equal(prepareConfig({orbitcard_max_authorizations:value}).orbitcard_max_authorizations,Number(value));
    }
    assert.equal(prepareConfig({orbitcard_max_fee:'2'},{orbitcard_max_authorizations:12}).orbitcard_max_authorizations,12);
    for (const value of [null,undefined,'', ' ',0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,[],{},true]) {
        assert.throws(()=>prepareConfig({orbitcard_max_authorizations:value}),/正安全整数/);
    }
});

test('authorization limit is persisted, returned as a number and not overwritten by startup defaults or unrelated edits', async () => {
    const {core,rows}=database();
    assert.equal((await core.getGptApiConfig()).orbitcard_max_authorizations,4);
    await core.ensureGptApiConfigDefaults();
    assert.equal(rows.get('orbitcard_max_authorizations'),'4');
    await core.saveGptApiConfig({orbitcard_max_authorizations:12});
    assert.equal(rows.get('orbitcard_max_authorizations'),'12');
    await core.ensureGptApiConfigDefaults();
    await core.saveGptApiConfig({orbitcard_max_fee:'2'});
    assert.equal((await core.getGptApiConfig()).orbitcard_max_authorizations,12);
    await assert.rejects(core.saveGptApiConfig({orbitcard_max_authorizations:0}),/正安全整数/);
    assert.equal(rows.get('orbitcard_max_authorizations'),'12');
});

test('admin configuration returns and saves the authorization limit using the same API', async () => {
    const {core}=database(), routes=new Map();
    const app={get:(url,...handlers)=>routes.set('GET '+url,handlers.at(-1)),post:(url,...handlers)=>routes.set('POST '+url,handlers.at(-1)),use(){},delete(){},put(){},patch(){}};
    require('../admin-http')(app,{store:core,ensureStoreReady:async()=>{},getTotalActiveJobs:()=>0});
    const invoke=async(method,body)=>{
        const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
        await routes.get(method+' /api/admin/gpt-api')({body},res,error=>{throw error;});
        return res;
    };
    assert.equal((await invoke('GET')).body.config.orbitcard_max_authorizations,4);
    assert.equal((await invoke('POST',{orbitcard_max_authorizations:9})).statusCode,200);
    assert.equal((await invoke('GET')).body.config.orbitcard_max_authorizations,9);
    assert.equal((await invoke('POST',{orbitcard_max_authorizations:-2})).statusCode,400);
    assert.equal((await invoke('GET')).body.config.orbitcard_max_authorizations,9);
});

test('card snapshots expose the configured limit without obsolete cooldown fields from an older database', async () => {
    const {core}=database(), routes=new Map();
    await core.saveGptApiConfig({orbitcard_max_authorizations:9});
    const oldCard={card_id:42,successful_order_count:3,provider_status:'ACTIVE',reuse_after_ms:Date.now()+300000};
    const app={get:(url,...handlers)=>routes.set(url,handlers.at(-1)),post(){}};
    require('../orbitcard-card-http')(app,{store:{...core,cardMethods:()=>({
        listCards:async()=>[oldCard],listIssues:async()=>[],listFundings:async()=>[]
    })},cardService:{},requireSecondaryAuth(){}});
    const res={set(){},json(value){this.body=value;},status(){return this;}};
    await routes.get('/api/admin/orbitcard/cards')({},res);
    assert.equal(res.body.success,true);
    assert.equal(res.body.cards[0].successful_order_limit,9);
    assert.equal(res.body.cards[0].successful_order_count,3);
    assert.equal(Object.hasOwn(res.body.cards[0],'cooling_down'),false);
    assert.equal(Object.hasOwn(res.body.cards[0],'reuse_after_ms'),false);
    assert.equal(oldCard.reuse_after_ms > Date.now(),true);
});
