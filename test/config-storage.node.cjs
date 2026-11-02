'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');

function fixture() {
    let rows = new Map(), pending, fail = false, writes = 0, commits = 0, rollbacks = 0;
    const query = async (sql, keys) => [[...rows].filter(([key]) => keys.includes(key)).map(([config_key, config_value]) => ({ config_key, config_value }))];
    const connection = {
        beginTransaction: async () => { pending = new Map(rows); },
        commit: async () => { rows = pending; commits++; },
        rollback: async () => { pending = null; rollbacks++; },
        release() {},
        execute: async (sql, params) => {
            writes++;
            for (let i = 0; i < params.length; i += 2) {
                pending.set(params[i], params[i + 1]);
                if (fail) throw Error('write failed');
            }
            return [{ affectedRows: params.length / 2 }];
        }
    };
    const filename = require.resolve('../mysql-core'), realRequire = createRequire(filename), module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => id === 'mysql2/promise' ? { createPool: () => ({ query, getConnection: async () => connection }) } : realRequire(id), module, module.exports);
    return { core: module.exports, fail() { fail = true; }, counts: () => ({ writes, commits, rollbacks }) };
}

test('configuration batches commit together, preserve unrelated values and roll back failed writes', async () => {
    const f = fixture();
    await f.core.saveConfigValues({ one: 'old', untouched: 'keep' });
    await f.core.saveConfigValues({ one: 'new', two: 'second' });
    assert.deepEqual(await f.core.getConfigValues(['one', 'two', 'untouched']), { one: 'new', two: 'second', untouched: 'keep' });
    assert.deepEqual(f.counts(), { writes: 2, commits: 2, rollbacks: 0 });
    await f.core.saveConfigValues({}); assert.deepEqual(f.counts(), { writes: 2, commits: 2, rollbacks: 0 });
    assert.equal(await f.core.getAppConfigValue('missing', 'fallback'), 'fallback');
    assert.equal(await f.core.getAppConfigValue('constructor', 'fallback'), 'fallback');
    assert.equal(await f.core.getAppConfigValue('toString', 'fallback'), 'fallback');
    f.fail(); await assert.rejects(f.core.saveConfigValues({ one: 'bad', two: 'bad' }), /write failed/);
    assert.deepEqual(await f.core.getConfigValues(['one', 'two']), { one: 'new', two: 'second' });
    assert.equal(f.counts().rollbacks, 1);
});

test('shared config writes preserve password versions, Telegram token retention and boolean settings', async () => {
    const f = fixture(), verify = require('../admin-auth').verifyPassword;
    const password = await f.core.updateAdminPassword('new-password');
    assert.equal(password.passwordVersion, 2); assert.ok(verify('new-password', password.passwordHash));
    await f.core.updateAdminSecondaryPassword('secondary-password');
    await f.core.updateAdminEmail('ADMIN@example.test');
    const auth = await f.core.getAdminAuthConfig();
    assert.equal(auth.passwordVersion, 3); assert.equal(auth.secondaryPasswordVersion, 2);
    assert.equal(auth.email, 'admin@example.test'); assert.ok(verify('secondary-password', auth.secondaryPasswordHash));
    await f.core.saveTelegramConfig({ bot_token: 'saved-token', admin_chat_id: '10', notify_admin: true });
    await f.core.saveTelegramConfig({ bot_token: '', group_chat_id: '20', notify_group: true });
    assert.deepEqual(await f.core.getTelegramConfig(), { bot_token: 'saved-token', admin_chat_id: '', group_chat_id: '20',
        notify_admin: false, notify_group: true, on_success: false, on_failure: false });
});
