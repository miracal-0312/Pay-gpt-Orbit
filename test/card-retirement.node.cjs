'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./helpers/card-db.cjs');
const createReconciler = require('../src/orbitcard/orbitcard-retirement');
const { positiveId } = require('../src/orbitcard/orbitcard-cards-client');
const cfg = { api_key: 'retirement-test', base_url: 'https://orbitcard.test' };
const key = `retire-${crypto.createHash('sha256').update(cfg.api_key).digest('hex').slice(0, 16)}-saved`;

async function setup(state = 'unknown') {
    const f = fixture(), card = await f.addCard(42, true, 3), reads = [];
    const row = f.db.cards[0];
    Object.assign(row, { retirement_key: key, retirement_state: state });
    let detail = card;
    const locked = f.store.cardMethods(f.base);
    const reconcile = createReconciler({ cardsApi: { positiveId, async cardDetail(config, id) {
        reads.push(id);
        if (detail instanceof Error) throw detail;
        return detail;
    } } });
    return { row, card, reads, setDetail(value) { detail = value; },
        run(snapshot, config = cfg) { return reconcile(config, locked, row, snapshot); } };
}

test('a matching deleted snapshot confirms a historical retirement without a detail lookup', async () => {
    const f = await setup();
    assert.equal(await f.run({ ...f.card, provider_status: 'DELETED' }), true);
    assert.equal(f.row.retirement_state, 'confirmed');
    assert.equal(f.row.provider_status, 'DELETED');
    assert.deepEqual(f.reads, []);
});

test('historical prepared and uncertain retirements reconcile using detail reads only', async () => {
    for (const state of [null, 'prepared', 'unknown']) {
        const f = await setup(state);
        assert.equal(await f.run(), false);
        assert.equal(f.row.retirement_state, state);
        f.setDetail({ ...f.card, provider_status: 'DELETED' });
        assert.equal(await f.run(), true);
        assert.equal(f.row.retirement_state, 'confirmed');
        assert.equal(f.row.retirement_key, key);
        assert.deepEqual(f.reads, [42, 42]);
    }
});

test('invalid credentials, mismatched detail and network errors preserve historical retirement state', async () => {
    const f = await setup();
    await assert.rejects(f.run(undefined, { ...cfg, api_key: 'changed' }), /API Key/);
    assert.deepEqual(f.reads, []);
    f.setDetail({ ...f.card, card_id: 43, provider_status: 'DELETED' });
    await assert.rejects(f.run(), /缺少相符的卡 ID/);
    f.setDetail(Error('network failure'));
    await assert.rejects(f.run(), /network failure/);
    assert.equal(f.row.retirement_state, 'unknown');
    assert.equal(f.row.provider_status, 'ACTIVE');
});
