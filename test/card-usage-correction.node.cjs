'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/card-db.cjs');
const counts = (plus = 0, pro100 = 0, pro200 = 0, pro500 = 0) => ({plus, pro100, pro200, pro500});
const input = (usage, expected_usage) => ({usage, expected_usage, reason:'人工核对修正', adminEmail:'admin@example.test'});
const update = (f, data, id = 42) => f.store.withCardAllocationLock(f.base, m => m.updateCardUsage(id, data));

test('confirmed card totals can be corrected up or down with atomic audit and survive sync', async () => {
    const f = fixture();
    const card = await f.addCard(42, true, 4);
    f.db.uses.push({job_key:'historical-success',scope:f.scope,card_id:42,plan_type:'plus',state:'consumed'});
    assert.equal((await update(f, input(counts(2,1,1,1), counts(4)))).changed, true);
    assert.deepEqual(f.db.usageChanges[0], {scope:f.scope,card_id:42,before:counts(4),after:counts(2,1,1,1),
        reason:'人工核对修正',admin_email:'admin@example.test'});
    assert.equal(f.db.uses[0].state, 'consumed');
    await f.store.cardMethods(f.base).syncCards([card]);
    assert.equal(f.db.cards[0].successful_plus, 2);
    assert.equal(f.db.cards[0].successful_pro500, 1);
    assert.equal(f.db.cards[0].history_confirmed, 1);
    await update(f, input(counts(), counts(2,1,1,1)));
    assert.equal(f.db.cards[0].successful_plus, 0);
    assert.equal(f.db.usageChanges.length, 2);
});

test('corrections immediately affect reservations and subsequent success increments normally', async () => {
    const f = fixture(); await f.addCard(42, true, 4);
    await update(f, input(counts(3), counts(4)));
    const task = await f.claim(); const m = f.store.cardMethods(f.base);
    assert.ok(await m.reserveCard(42, task.jobKey, 'plus'));
    await assert.rejects(update(f, input(counts(2), counts(3))), /任务占用/);
    await f.settle(task, 'success');
    assert.equal(f.db.cards[0].successful_plus, 4);
    await f.settle(task, 'success');
    assert.equal(f.db.cards[0].successful_plus, 4);
});

test('rejects invalid counts, stale values, missing reasons, unconfirmed or nonexistent cards', async () => {
    const f = fixture(); await f.addCard(42, true, 3);
    for (const usage of [counts(-1), counts(5), counts(1,2), counts(0,0,2), counts(0,0,0,2), counts(1.5),
        counts('1'), {...counts(), extra:1}, {plus:1}, null]) {
        await assert.rejects(update(f, input(usage, counts(3))), /历史成功次数/);
    }
    await assert.rejects(update(f, input(counts(1), counts(2))), /已发生变化/);
    await assert.rejects(update(f, {...input(counts(1), counts(3)), expected_usage:null}), /历史成功次数/);
    for (const reason of ['', '   ', 'x'.repeat(256), {}]) {
        await assert.rejects(update(f, {...input(counts(1), counts(3)), reason}), /修改原因/);
    }
    await assert.rejects(update(f, input(counts(1), counts(3)), 999), /不存在/);
    f.db.cards[0].history_confirmed = 0;
    await assert.rejects(update(f, input(counts(1), counts(3))), /请先登记/);
    assert.equal(f.db.cards[0].successful_plus, 3);
    assert.equal(f.db.usageChanges.length, 0);
});

test('unsettled reservations and legacy unknown orders block corrections', async () => {
    const f = fixture(); await f.addCard();
    f.db.uses.push({scope:f.scope,card_id:42,state:'reserved'});
    await assert.rejects(update(f, input(counts(1), counts())), /未结算/);
    f.db.uses.length = 0;
    f.db.tasks.push({job_key:'legacy',status:'manual',orbitcard_client_order_no:'old-order'});
    await assert.rejects(update(f, input(counts(1), counts())), /旧充值订单/);
});

test('audit failure rolls back correction; concurrent stale submissions cannot overwrite changes', async () => {
    const f = fixture(); await f.addCard(42, true, 3);
    f.db.failUsageAudit = true;
    await assert.rejects(update(f, input(counts(1), counts(3))), /audit failure/);
    assert.equal(f.db.cards[0].successful_plus, 3);
    assert.equal(f.db.usageChanges.length, 0);
    f.db.failUsageAudit = false;
    const results = await Promise.allSettled([update(f, input(counts(1), counts(3))), update(f, input(counts(2), counts(3)))]);
    assert.equal(results[0].status, 'fulfilled');
    assert.match(results[1].reason.message, /已发生变化/);
    assert.equal(f.db.cards[0].successful_plus, 1);
    assert.equal(f.db.usageChanges.length, 1);
    assert.equal((await update(f, input(counts(1), counts(1)))).changed, false);
    assert.equal(f.db.usageChanges.length, 1);
});

test('usage correction HTTP requires secondary auth and records authenticated operator under allocation lock', async t => {
    const express = require('express'), {once} = require('node:events');
    const f = fixture(); await f.addCard(42, true, 3);
    const app = express(); app.use(express.json());
    app.use((req,res,next) => {req.admin={email:'authenticated@example.test'}; next();});
    let locks = 0; const events = [];
    require('../orbitcard-card-http')(app, {store:{...f.store,getGptApiConfig:async () => ({base_url:f.base}),
        withCardAllocationLock:async (base,fn) => {locks++;return f.store.withCardAllocationLock(base,fn);}}, cardService:{},
        requireSecondaryAuth:(req,res,next) => req.headers['x-secondary']==='valid' ? next() : res.sendStatus(403),
        audit:event => events.push(event)});
    const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
    const post = (data, auth = true, id = 42) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/orbitcard/cards/${id}/usage`, {
        method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-secondary':'valid'}:{})},body:JSON.stringify(data)});
    assert.equal((await post(input(counts(1),counts(3)),false)).status,403);
    assert.equal(locks,0);
    assert.equal((await post(input(counts(1),counts(3)),true,'invalid')).status,400);
    const result = await post(input(counts(1),counts(3)));
    assert.equal(result.status,200); assert.equal((await result.json()).changed,true);
    assert.equal(locks,1); assert.equal(f.db.usageChanges[0].admin_email,'authenticated@example.test');
    assert.equal(events[0].event,'card_usage_corrected');
    assert.equal((await post(input(counts(2),counts(3)))).status,400);
    assert.equal(f.db.cards[0].successful_plus,1);
});
