'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('../src/integrations/smtp-mailer');

const config = { enabled: false, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: true,
    smtp_user: 'login@example.test', smtp_password: 'fixture-password', from_email: 'sender@example.test', to_email: 'admin@example.test' };
const message = { subject: '充值成功', text: '任务 order-42 已完成', messageId: '<event-42@pay-gpt-orbit.local>' };

test('mail transport uses only saved destination and plain text with verified TLS and bounded timeouts', async () => {
    const calls = []; let transportOptions, closed = 0;
    const mailer = createMailer({ createTransport: options => {
        transportOptions = options;
        return { sendMail: async value => { calls.push(value); return { accepted: ['admin@example.test'], messageId: 'untrusted-returned-id' }; },
            close() { closed++; } };
    } });
    assert.deepEqual(await mailer.send(config, { ...message, to: 'attacker@example.test', from: 'attacker@example.test',
        attachments: [{ path: '/secret' }], html: { path: 'https://attacker.example.test' }, bcc: 'attacker@example.test' }),
    { ok: true, messageId: message.messageId });
    assert.equal(transportOptions.secure, true); assert.equal(transportOptions.requireTLS, false);
    assert.deepEqual(transportOptions.tls, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    assert.equal(transportOptions.logger, false); assert.equal(transportOptions.debug, false);
    assert.equal(transportOptions.pool, false); assert.equal(transportOptions.maxRecipients, 1);
    assert.equal(transportOptions.disableFileAccess, true); assert.equal(transportOptions.disableUrlAccess, true);
    for (const field of ['connectionTimeout','greetingTimeout','socketTimeout','dnsTimeout']) assert.ok(transportOptions[field] > 0 && transportOptions[field] <= 15000);
    assert.equal(calls[0].to, config.to_email); assert.equal(calls[0].from, config.from_email);
    assert.deepEqual(calls[0].envelope, { from: config.from_email, to: [config.to_email] });
    assert.equal(calls[0].text, message.text); assert.equal(calls[0].messageId, message.messageId);
    assert.equal(Object.hasOwn(calls[0], 'attachments'), false); assert.equal(Object.hasOwn(calls[0], 'html'), false);
    assert.equal(Object.hasOwn(calls[0], 'bcc'), false); assert.ok(calls[0].signal instanceof AbortSignal);
    assert.equal(closed, 1);
});

test('STARTTLS cannot silently downgrade and SMTP errors never leak response or credential text', async () => {
    for (const [code, expected] of [['EAUTH','smtp_auth'],['ETLS','smtp_tls'],['CERT_HAS_EXPIRED','smtp_tls'],
        ['ETIMEDOUT','smtp_timeout'],['EABORT','smtp_timeout'],['EENVELOPE','smtp_recipient'],['ECONNRESET','smtp_transport']]) {
        let closed = false;
        const mailer = createMailer({ createTransport: options => {
            assert.equal(options.requireTLS, true); assert.equal(options.ignoreTLS, false); assert.equal(options.opportunisticTLS, false);
            return { sendMail: async () => { throw Object.assign(new Error('private password and Session value'), { code,
                response: 'private SMTP response', command: 'AUTH private' }); }, close() { closed = true; } };
        } });
        const result = await mailer.send({ ...config, smtp_secure: false, smtp_port: 587 }, message);
        assert.equal(result.ok, false); assert.equal(result.error_code, expected);
        assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(closed, true);
    }
});

test('invalid configuration, headers and non-string content never open a connection', async () => {
    let connections = 0;
    const mailer = createMailer({ createTransport: () => { connections++; throw new Error('unexpected'); } });
    for (const input of [{ ...config, to_email: 'a@example.test,b@example.test' }, { ...config, smtp_secure: 'false' }, null]) {
        assert.equal((await mailer.send(input, message)).error_code, 'smtp_config');
    }
    for (const invalid of [{ ...message, subject: 'valid\r\nBcc:attacker@example.test' }, { ...message, text: { path: '/etc/passwd' } },
        { ...message, text: 'x'.repeat(32769) }, { ...message, messageId: '<test@example.test>\r\nBcc:x' },
        { ...message, messageId: '' }, null]) {
        assert.equal((await mailer.send(config, invalid)).error_code, 'smtp_message');
    }
    assert.equal(connections, 0);
});

test('only an SMTP acceptance for the configured administrator is marked successful', async () => {
    for (const response of [undefined, {}, { accepted: [] }, { accepted: ['other@example.test'] }]) {
        const mailer = createMailer({ createTransport: () => ({ sendMail: async () => response }) });
        assert.equal((await mailer.send(config, message)).error_code, 'smtp_recipient');
    }
});

test('concurrent sends are bounded and failed connections release capacity', async () => {
    const pending = [];
    const mailer = createMailer({ createTransport: () => ({ sendMail: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }) });
    const first = mailer.send(config, message), second = mailer.send(config, message);
    assert.equal((await mailer.send(config, message)).error_code, 'smtp_busy');
    pending[0].reject(new Error('private')); assert.equal((await first).error_code, 'smtp_transport');
    const third = mailer.send(config, message);
    assert.equal(pending.length, 3);
    pending[1].resolve({ accepted: [config.to_email] }); pending[2].resolve({ accepted: [config.to_email] });
    assert.equal((await second).ok, true); assert.equal((await third).ok, true);
});
