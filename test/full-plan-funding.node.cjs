'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const fixture = require('./helpers/card-db.cjs');
const money = require('../src/orbitcard/orbitcard-money');
const { AccountBalanceError } = require('../src/orbitcard/orbitcard-card-policy');

async function setup({ plan = 'plus', balance = '5.00', available = '1000.00' } = {}) {
    const f = fixture(), calls = [], events = [];
    const cfg = { enabled: true, base_url: f.base, api_key: 'fixture',
        orbitcard_plan_prices: { plus: '20.00', pro100: '100.00', pro200: '200.00', pro500: '500.00' } };
    let currentBalance = money.units(balance);
    const card = () => ({ card_id: 42, provider_status: 'ACTIVE', product_code: 'p1', bin: '55565979', last4: '1234',
        balance: Number(money.decimal(currentBalance)), balance_amount: money.decimal(currentBalance), currency: 'USD' });
    const cards = { listCards: async () => [card()], cardDetail: async () => card(),
        cardDetailsInBatches: async () => [card()],
        products: async () => { throw new Error('Existing-card payments must not query the opening catalog'); } };
    const api = { request: async (_cfg, operation, body, key) => {
        calls.push({ operation, body, key });
        if (operation === 'getAccountBalance') return { success: true, status: 200, data: { available_balance: available } };
        assert.equal(operation, 'rechargeCard', 'no other remote operation is allowed');
        currentBalance += money.units(body.amount);
        return { success: true, status: 200, data: { order_no: 'funding-original', card_id: 42,
            amount: body.amount, status: 'success', completed: true } };
    } };
    const filename = require.resolve('../src/orbitcard/orbitcard-card-service');
    const real = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => id === './orbitcard-client' ? api : id === './orbitcard-cards-client' ? cards : real(id), module, module.exports);
    const service = module.exports({ store: f.store, audit: entry => events.push(entry) });
    await f.addCard();
    const task = await f.claim(plan);
    return { ...f, cfg, calls, events, task, service, allocate: () => service.allocate(cfg, task.jobKey, plan) };
}

test('each selected plan funds its full amount while retaining the card balance', async () => {
    for (const [plan, amount] of Object.entries({ plus: '20.00', pro100: '100.00', pro200: '200.00', pro500: '500.00' })) {
        const f = await setup({ plan });
        assert.equal(await f.allocate(), 42);
        const writes = f.calls.filter(call => call.operation === 'rechargeCard');
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].body, { card_id: 42, amount });
        assert.equal(f.db.fundings[0].amount, amount);
        assert.equal(f.db.fundings[0].state, 'ready');
        assert.equal(f.db.cards[0].balance, Number(amount) + 5);
        assert.equal(f.events.find(event => event.event === 'card_funding_prepared').text, '已保存按套餐全额补款意图');
    }
});

test('a sub-cent shortfall still uses the full selected plan, and sufficient balance makes no funding request', async () => {
    const almost = await setup({ balance: '19.99999999' });
    await almost.allocate();
    assert.equal(almost.db.fundings[0].amount, '20.00');
    const funded = await setup({ balance: '20.00', available: '0.00' });
    await funded.allocate();
    assert.deepEqual(funded.calls, []);
    assert.deepEqual(funded.db.fundings, []);
});

test('account funds that could cover an old difference cannot authorize a full plan recharge', async () => {
    const f = await setup({ balance: '19.00', available: '19.99' });
    await assert.rejects(f.allocate(), error => error instanceof AccountBalanceError && /联系客服/.test(error.message));
    assert.deepEqual(f.calls.map(call => call.operation), ['getAccountBalance']);
    assert.deepEqual(f.db.fundings, []);
});

test('an empty existing card funds exactly the plan without an opening-product reserve', async () => {
    const f = await setup({ balance: '0.00' });
    assert.equal(await f.allocate(), 42);
    assert.deepEqual(f.calls.map(call => call.operation), ['getAccountBalance', 'rechargeCard']);
    assert.equal(f.db.fundings.length, 1);
    assert.equal(f.db.fundings[0].amount, '20.00');
    assert.equal(money.units(f.db.fundings[0].target_balance), money.units('20.00'));
    assert.equal(f.db.cards[0].active_job, f.task.jobKey);
});

test('recovery preserves an existing difference-based funding body after the new plan rule', async () => {
    const f = await setup();
    const methods = f.store.cardMethods(f.base);
    await methods.reserveCard(42, f.task.jobKey, 'plus');
    const original = { card_id: 42, amount: '16.00' };
    const key = 'original-funding-key';
    await methods.createFunding({ funding_key: key, job_key: f.task.jobKey, plan_type: 'plus', card_id: 42,
        credential_hash: require('node:crypto').createHash('sha256').update(f.cfg.api_key).digest('hex'),
        request_body: JSON.stringify(original), amount: '16.00', target_balance: '21.00' });
    // A prepared intent is known not to have been sent. Its original amount/key
    // must survive deployment of the new full-plan funding rule.
    assert.equal(await f.allocate(), 42);
    const writes = f.calls.filter(call => call.operation === 'rechargeCard');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, original);
    assert.equal(writes[0].key, key);
    assert.equal(f.db.fundings.length, 1);
    assert.equal(f.db.fundings[0].amount, '16.00');
});

test('customer messages include support instructions for old and new insufficient balance results', () => {
    const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function publicText('), source.indexOf('\nfunction message(')), context);
    assert.match(context.publicText('账户可用余额不足；本次会员充值未提交，CDK 已释放'), /联系客服/);
    assert.match(context.publicText('支付卡余额不足，充值已停止'), /联系客服/);
    const current = '账户可用余额不足；充值已停止，请联系客服';
    assert.equal(context.publicText(current), current);
    assert.equal(context.publicText('原补款结果待确认，请勿重复充值'), '原补款结果待确认，请勿重复充值');
});
