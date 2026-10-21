'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lockServer = require('./helpers/payment-locks.cjs');
const { cdkLockKey, manualLockKeys } = require('../payment-execution-lock');
const createTransactions = require('../mysql-transaction');
const cardFixture = require('./helpers/card-db.cjs');

function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

test('independent connections admit only one CDK owner; manual fulfillment uses the same CDK lock', async () => {
    const db = lockServer();
    const claims = await Promise.all(Array.from({length: 30}, (_,i) => db.acquirePaymentLock(cdkLockKey(i % 2 ? 'CODE-1234' : 'code-1234'))));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await db.acquirePaymentLock(manualLockKeys('request-1', 'CoDe-1234')), null);
    assert.equal(db.owners.size, 1, 'partial lock acquisitions must not leak');
    const owner = claims.find(Boolean); await owner.assertOwned(); await owner.release(); await owner.release();
    const next = await db.acquirePaymentLock(manualLockKeys('request-1', 'CODE-1234'));
    assert.ok(next); assert.equal(await db.acquirePaymentLock(manualLockKeys('REQUEST-1')),null); await next.release();
    assert.equal(db.owners.size, 0); assert.ok(db.connections.every(connection => connection.closed));
});

test('a disconnected owner cannot resume; a new connection can safely recover the same order', async () => {
    const db = lockServer(), first = await db.acquirePaymentLock('manual:request');
    db.connections[0].destroy();
    const next = await db.acquirePaymentLock('manual:request');
    assert.ok(next); await assert.rejects(first.assertOwned(), /connection lost/);
    await first.release(); await next.assertOwned(); await next.release();
    const idle = await db.acquirePaymentLock('manual:idle');
    db.connections.at(-1).emit('error', new Error('idle connection failure'));
    await assert.rejects(idle.assertOwned(), /失效/); await idle.release();
});

function transactionFixture({ commitError, rollbackError } = {}) {
    const connections = [], delays = [];
    const getPool = () => ({ getConnection: async () => {
        const connection = { calls: [], async beginTransaction() { this.calls.push('begin'); },
            async commit() { this.calls.push('commit'); if (commitError) throw commitError; },
            async rollback() { this.calls.push('rollback'); if (rollbackError) throw rollbackError; },
            release() { this.calls.push('release'); }, destroy() { this.calls.push('destroy'); } };
        connections.push(connection); return connection;
    } });
    return { connections, delays, run: createTransactions({ getPool, sleep: async ms => delays.push(ms) }) };
}

test('deadlocks and lock waits retry only after confirmed rollback, with bounded attempts and released connections', async () => {
    const f = transactionFixture(); let attempts = 0;
    assert.equal(await f.run(async () => {
        if (++attempts < 3) throw Object.assign(new Error('conflict'), { code: attempts === 1 ? 'ER_LOCK_DEADLOCK' : 'ER_LOCK_WAIT_TIMEOUT' });
        return 'committed';
    }), 'committed');
    assert.equal(attempts, 3); assert.equal(f.delays.length, 2);
    assert.deepEqual(f.connections.map(c => c.calls), [['begin','rollback','release'],['begin','rollback','release'],['begin','commit','release']]);
    const exhausted = transactionFixture(); let tries = 0;
    await assert.rejects(exhausted.run(async () => { tries++; throw Object.assign(new Error('deadlock'), {errno:1213}); }), /deadlock/);
    assert.equal(tries, 3); assert.equal(exhausted.connections.length, 3);
});

test('business failures, uncertain commits and failed rollback never replay a transaction', async () => {
    for (const options of [{}, {commitError: Object.assign(new Error('commit result unknown'), {errno:1213})}, {rollbackError: new Error('connection lost')}]) {
        const f = transactionFixture(options); let attempts = 0;
        await assert.rejects(f.run(async () => {
            attempts++;
            if (!options.commitError) throw Object.assign(new Error('failure'), options.rollbackError ? {errno:1213} : {});
        }));
        assert.equal(attempts, 1); assert.equal(f.delays.length, 0);
        assert.equal(f.connections[0].calls.at(-1), options.rollbackError ? 'destroy' : 'release');
    }
});

test('database error wrappers preserve conflict codes without changing transaction semantics', async () => {
    const core=require('../mysql-core');
    const conflict=Object.assign(new Error('simulated lock conflict'),{code:'ER_LOCK_DEADLOCK',errno:1213});
    const connection={query:async()=>{throw conflict;},execute:async()=>{throw conflict;}};
    for(const method of ['runQuery','runExecute']) await assert.rejects(core[method]('SELECT 1',[],{connection}),
        error=>error.code==='ER_LOCK_DEADLOCK' && error.errno===1213 && error.cause===conflict);
});

test('a second instance cannot recover or release a foreground CDK, and re-reads state after acquiring ownership', {timeout:5000}, async t => {
    const oldSecret = process.env.ORBITCARD_API_SECRET, oldKey = process.env.ORBITCARD_API_KEY;
    process.env.ORBITCARD_API_SECRET = 'synthetic-only'; process.env.ORBITCARD_API_KEY = 'test-key';
    t.after(() => {
        if (oldSecret === undefined) delete process.env.ORBITCARD_API_SECRET; else process.env.ORBITCARD_API_SECRET = oldSecret;
        if (oldKey === undefined) delete process.env.ORBITCARD_API_KEY; else process.env.ORBITCARD_API_KEY = oldKey;
    });
    const f = cardFixture(), paused = gate(), started = gate(), finished = gate();
    t.after(() => paused.release());
    f.db.cdks.push({ cdk_code:'CODE-TEST',is_active:1,type:'自助',plan_type:'plus',used_at:null });
    Object.assign(f.store, {
        verifyCdkDetails: async () => structuredClone(f.db.cdks[0]),
        getRunningTaskByCdk: async () => structuredClone(f.db.tasks.at(-1) || null),
        getMaintenanceModeState: async () => ({enabled:false}), getMaxConcurrentActivations: async () => 10,
        getGptApiConfig: async () => ({enabled:true,api_key:'test-key',base_url:f.base})
    });
    let submissions = 0, queries = 0;
    const handler = require('../activation-service')({ store:f.store,ensureStoreReady:async()=>{},activeJobs:new Set(),log(){},
        runWorker: async ({task}) => {
            submissions++; started.release(); await paused.promise;
            await f.settle(task,'submitting'); await f.settle(task,'pending'); finished.release();
        } });
    const body = {cdk:'CODE-TEST',session:{user:{email:'fixture@example.test'},account:{},accessToken:'synthetic-only'}};
    const response = () => ({status(code){this.code=code;return this;},json(data){this.data=data;return data;}});
    const first = response(); await handler({body},first); assert.equal(first.data.success,true); await started.promise;
    const stale = structuredClone(f.db.tasks[0]);
    const recovery = require('../order-recovery')({store:f.store,activeJobs:new Set(),audit(){},
        query:{refresh:async ({task})=>{queries++;assert.equal(task.orbitcard_state,'pending');return {success:true,applied:false};}}});
    assert.equal((await recovery.refreshTask(stale)).querySkipped,true);
    const duplicate = response(); await handler({body},duplicate);
    assert.equal(duplicate.data.jobKey, first.data.jobKey); assert.equal(submissions,1);
    assert.ok(f.db.cdks[0].used_at); assert.equal(queries,0);
    paused.release(); await finished.promise; await new Promise(resolve=>setImmediate(resolve));
    await recovery.refreshTask(stale);
    assert.equal(queries,1); assert.equal(f.db.tasks[0].orbitcard_state,'pending'); assert.ok(f.db.cdks[0].used_at);
});

test('late success cannot reopen a released attempt or count a card already released to another order', async () => {
    const f = cardFixture(); await f.addCard(); const task = await f.claim();
    await f.store.cardMethods(f.base).reserveCard(42,task.jobKey,'plus');
    await f.settle(task,'failed');
    assert.equal((await f.settle(task,'success')).applied,false);
    assert.equal(f.db.cdks[0].used_at,null); assert.equal(f.db.cards[0].successful_plus,0);
});

test('a mismatched platform order cannot overwrite an already-bound order', async () => {
    const f = cardFixture(), task = await f.claim(); await f.settle(task,'submitting');
    await f.store.settleOrbitcardTask(task.jobKey,{status:'running',orbitcardState:'pending',gptApiOrderId:'ORIGINAL'});
    assert.equal((await f.store.settleOrbitcardTask(task.jobKey,{status:'success',orbitcardState:'success',gptApiOrderId:'DIFFERENT'})).applied,false);
    assert.equal(f.db.tasks[0].gpt_api_order_id,'ORIGINAL'); assert.equal(f.db.tasks[0].orbitcard_state,'pending');
});

test('funding intent creation rejects a stale reservation, and recovery cannot release a newly committed intent', async () => {
    const f = cardFixture(); await f.addCard(); const task = await f.claim();
    const methods=f.store.cardMethods(f.base); await methods.reserveCard(42,task.jobKey,'plus');
    const intent = {funding_key:'fund-race',job_key:task.jobKey,plan_type:'plus',card_id:42,
        credential_hash:'test',request_body:'{}',amount:'1.00',target_balance:'21.00'};
    await methods.createFunding(intent);
    assert.equal((await f.store.settleOrbitcardTask(task.jobKey,{status:'failed',orbitcardState:'rejected',expectedState:'prepared'})).applied,false);
    assert.ok(f.db.cdks[0].used_at); assert.equal(f.db.cards[0].active_job,task.jobKey);
    f.db.fundings[0].state='failed'; await f.settle(task,'rejected');
    await assert.rejects(methods.createFunding({...intent,funding_key:'fund-stale'}),/支付任务已变更/);
    assert.equal(f.db.fundings.length,1);
});
