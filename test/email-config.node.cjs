'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createEmailConfig = require('../src/integrations/email-config');

const valid = { enabled: true, smtp_host: 'SMTP.example.test', smtp_port: 587, smtp_secure: false,
    smtp_user: 'login@example.test', smtp_password: 'fixture-smtp-password', from_email: 'Sender@Example.test',
    to_email: 'Admin@Example.test', on_low_balance: true, on_success: true, on_failure: true,
    balance_threshold: '20.00', balance_cooldown_minutes: 360 };

function fixture() {
    const values = {}, env = { ADMIN_TOKEN_SECRET: 'fixture-only-key-with-at-least-32-bytes' };
    let clock = 1700000000000, writes = 0;
    const config = createEmailConfig({ env, now: () => clock,
        getConfigValues: async keys => Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]])),
        saveConfigValues: async next => { writes++; Object.assign(values, next); } });
    return { ...config, values, env, advance() { clock += 1000; }, writes: () => writes };
}

test('email notifications default off and expose no SMTP credential', async () => {
    const f = fixture(), config = await f.getPublicEmailConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.smtp_port, 465); assert.equal(config.smtp_secure, true);
    assert.equal(config.balance_threshold, '50.00'); assert.equal(config.balance_cooldown_minutes, 360);
    assert.equal(config.enabled_since, 0); assert.equal(config.smtp_password_saved, false);
    assert.equal(Object.hasOwn(config, 'smtp_password'), false);
});

test('SMTP passwords are encrypted at rest, blank updates preserve them, and public responses never contain them', async () => {
    const f = fixture(), saved = await f.saveEmailConfig(valid);
    assert.equal(saved.smtp_host, 'smtp.example.test'); assert.equal(saved.from_email, 'Sender@example.test');
    assert.equal(saved.smtp_password_saved, true); assert.equal(saved.smtp_password_error, false);
    assert.equal(saved.enabled_since, 1700000000000);
    assert.equal(JSON.stringify(saved).includes(valid.smtp_password), false);
    assert.equal(JSON.stringify(f.values).includes(valid.smtp_password), false);
    assert.match(f.values.email_smtp_password, /^gcm1\./);
    assert.equal((await f.getEmailConfig()).smtp_password, valid.smtp_password);
    const encrypted = f.values.email_smtp_password;
    await f.saveEmailConfig({ smtp_password: '', balance_threshold: '005.5' });
    assert.equal(f.values.email_smtp_password, encrypted);
    assert.equal((await f.getEmailConfig()).balance_threshold, '5.50');
    assert.equal((await f.getPublicEmailConfig()).smtp_password_saved, true);
    await f.saveEmailConfig({ enabled: false, clear_password: true });
    assert.equal(f.values.email_smtp_password, '');
    assert.equal((await f.getPublicEmailConfig()).smtp_password_saved, false);
});

test('enable cutoff only moves on a new enable transition and cannot be supplied by the browser', async () => {
    const f = fixture();
    await f.saveEmailConfig({ ...valid, enabled_since: 1 });
    f.advance();
    await f.saveEmailConfig({ enabled: true, balance_threshold: '50', enabled_since: 2 });
    assert.equal((await f.getEmailConfig()).enabled_since, 1700000000000);
    await f.saveEmailConfig({ enabled: false });
    f.advance(); await f.saveEmailConfig({ enabled: true });
    assert.equal((await f.getEmailConfig()).enabled_since, 1700000002000);
});

test('switching administrator recipient starts a fresh observation window without replaying old orders', async () => {
    const f = fixture();
    await f.saveEmailConfig(valid);
    f.advance();
    await f.saveEmailConfig({ to_email: 'new-admin@example.test' });
    assert.equal((await f.getEmailConfig()).enabled_since, 1700000001000);
    f.advance();
    await f.saveEmailConfig({ to_email: 'NEW-ADMIN@EXAMPLE.TEST', smtp_host: 'other-smtp.example.test', balance_threshold: '50' });
    assert.equal((await f.getEmailConfig()).enabled_since, 1700000001000);
    assert.equal((await f.getEmailConfig()).smtp_password, valid.smtp_password);
    await f.saveEmailConfig({ enabled: false, to_email: 'future-admin@example.test' });
    assert.equal((await f.getEmailConfig()).enabled_since, 1700000001000);
    f.advance();
    await f.saveEmailConfig({ enabled: true });
    assert.equal((await f.getEmailConfig()).enabled_since, 1700000003000);
});

test('rotated encryption key does not lock administrators out of repairing or disabling email', async () => {
    const f = fixture(); await f.saveEmailConfig(valid);
    f.env.ADMIN_TOKEN_SECRET = 'new-fixture-key-with-at-least-32-bytes';
    const publicConfig = await f.getPublicEmailConfig();
    assert.equal(publicConfig.smtp_password_saved, true); assert.equal(publicConfig.smtp_password_error, true);
    await assert.rejects(f.getEmailConfig(), error => error.code === 'EMAIL_CONFIG_INVALID' && !error.message.includes('fixture'));
    await f.saveEmailConfig({ enabled: false });
    await f.saveEmailConfig({ smtp_password: 'replacement-password', enabled: true });
    assert.equal((await f.getEmailConfig()).smtp_password, 'replacement-password');
    assert.equal((await f.getPublicEmailConfig()).smtp_password_error, false);
});

test('tampered ciphertext cannot be adopted as plaintext and can be explicitly cleared', async () => {
    const f = fixture(); await f.saveEmailConfig(valid);
    f.values.email_smtp_password = 'attacker-plaintext-password';
    assert.equal((await f.getPublicEmailConfig()).smtp_password_error, true);
    await assert.rejects(f.getEmailConfig(), /无法解密/);
    await f.saveEmailConfig({ enabled: false, clear_password: true });
    assert.equal((await f.getEmailConfig()).smtp_password, '');
});

test('strict fields reject header injection, multiple recipients, URLs and invalid toggles before writing', async () => {
    const invalid = [
        { enabled: 'true' }, { smtp_secure: 'false' }, { on_failure: 0 }, { clear_password: 'false' },
        { smtp_host: 'https://smtp.example.test' }, { smtp_host: 'smtp.example.test:465' },
        { smtp_host: 'smtp.example.test\r\nAUTH secret' }, { smtp_user: 'user\nsecret' },
        { from_email: 'Sender <sender@example.test>' }, { to_email: 'a@example.test,b@example.test' },
        { to_email: 'a@example.test\r\nBcc:attacker@example.test' }, { smtp_password: 'secret\npart' },
        { smtp_port: 0 }, { smtp_port: 65536 }, { smtp_port: '465evil' }, { smtp_port: false },
        { balance_threshold: '-1' }, { balance_threshold: '1.001' }, { balance_threshold: '1e3' },
        { balance_cooldown_minutes: 0 }, { balance_cooldown_minutes: 10081 }, { balance_cooldown_minutes: true },
        { smtp_user: 'x'.repeat(255) }, { smtp_password: 'x'.repeat(1025) }
    ];
    for (const change of invalid) {
        const f = fixture();
        await assert.rejects(f.saveEmailConfig({ ...valid, ...change }), error => error.code === 'EMAIL_CONFIG_INVALID');
        assert.equal(f.writes(), 0);
    }
});

test('enabling requires complete transport details and encryption refuses a weak application secret', async () => {
    for (const field of ['smtp_host', 'smtp_user', 'smtp_password', 'from_email', 'to_email']) {
        const f = fixture();
        await assert.rejects(f.saveEmailConfig({ ...valid, [field]: '' }), /请填写 SMTP/);
        assert.equal(f.writes(), 0);
    }
    const f = fixture(); f.env.ADMIN_TOKEN_SECRET = 'short';
    await assert.rejects(f.saveEmailConfig(valid), /32 字节/);
    assert.equal(f.writes(), 0);
    await f.saveEmailConfig({ enabled: false, smtp_host: 'smtp.example.test' });
    assert.equal((await f.getPublicEmailConfig()).enabled, false);
});
