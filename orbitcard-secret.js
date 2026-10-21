'use strict';
const crypto = require('node:crypto');

const PREFIX = 'v1';
const CONTEXT = Buffer.from('pay-gpt-orbit/orbitcard-api-secret/v1');

function encryptionKey() {
    const master = process.env.ADMIN_TOKEN_SECRET || '';
    if (Buffer.byteLength(master) < 32) throw new Error('请先配置至少 32 字节的 ADMIN_TOKEN_SECRET');
    return crypto.hkdfSync('sha256', Buffer.from(master), Buffer.alloc(0), CONTEXT, 32);
}

function seal(value) {
    const secret = String(value || '').trim();
    if (!secret || Buffer.byteLength(secret) > 512 || /[\x00-\x1f\x7f]/.test(secret)) {
        throw new Error('Orbitcard API Secret 格式无效');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url')].join(':');
}

function open(ciphertext) {
    if (!ciphertext) return '';
    try {
        const [version, iv, tag, data, extra] = String(ciphertext).split(':');
        if (version !== PREFIX || extra !== undefined) throw new Error('invalid');
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch (_) {
        throw new Error('已保存的 Orbitcard API Secret 无法解密，请在后台重新填写；不要更换原 ADMIN_TOKEN_SECRET');
    }
}

module.exports = { seal, open };
