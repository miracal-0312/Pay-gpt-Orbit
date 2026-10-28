'use strict';
const crypto = require('node:crypto');
const axios = require('axios');
const MAX_DELIVERY_ATTEMPTS = 3;

function readConfig(env = process.env) {
    const url = String(env.CDK_REDEMPTION_WEBHOOK_URL || '').trim();
    const source = String(env.CDK_REDEMPTION_SOURCE || '').trim();
    const secret = String(env.CDK_REDEMPTION_WEBHOOK_SECRET || '');
    if (!url) return null;
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error('核销通知地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.href.length > 512) {
        throw new Error('核销通知地址必须是无凭据、无查询参数的 HTTPS 地址');
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source) || Buffer.byteLength(secret) < 32) {
        throw new Error('请配置固定的 CDK_REDEMPTION_SOURCE 和至少 32 字节的核销通知密钥');
    }
    return { url: parsed.href, source, secret };
}

function sign(secret, timestamp, payload) {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

module.exports = function createRedemptionWebhook({ runQuery, runExecute, env = process.env,
    now = Date.now, request = options => axios.request(options) }) {
    let running = false;
    async function enqueue({ cdk, orderId }, options) {
        const config = readConfig(env);
        if (!config || !cdk) return;
        if (!options?.connection) throw new Error('核销通知必须与核销结果在同一事务中保存');
        // MySQL accepts case-insensitive CDK lookups; notify the shop with the stored spelling.
        const [code] = await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? LIMIT 1', [cdk], options);
        if (!code?.cdk_code) throw new Error('核销凭证对应的 CDK 不存在');
        cdk = code.cdk_code;
        const eventId = crypto.createHash('sha256').update(JSON.stringify([config.source, cdk])).digest('hex');
        const payload = JSON.stringify({ version: 1, event_id: eventId, event_type: 'cdk.redeemed',
            source: config.source, cdk, order_id: orderId, redeemed_at: new Date(now()).toISOString() });
        await runExecute(`INSERT INTO cdk_redemption_outbox (event_id, source, target_url, payload)
            VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_id = event_id`,
        [eventId, config.source, config.url, payload], options);
    }

    async function deliverPending() {
        if (running) return;
        const config = readConfig(env);
        if (!config) return;
        running = true;
        try {
            // Persisted targets prevent a configuration change from sending old receipts to another shop.
            const events = await runQuery(`SELECT event_id, payload, attempts FROM cdk_redemption_outbox
                WHERE delivered_at IS NULL AND source = ? AND target_url = ?
                AND next_attempt_at <= ? AND lease_until <= ? AND attempts < ? ORDER BY next_attempt_at, created_at LIMIT 10`,
            [config.source, config.url, now(), now(), MAX_DELIVERY_ATTEMPTS]);
            for (const event of events) {
                const token = crypto.randomUUID(), claimedAt = now();
                const claimed = await runExecute(`UPDATE cdk_redemption_outbox SET lease_token = ?, lease_until = ?, attempts = attempts + 1
                    WHERE event_id = ? AND delivered_at IS NULL AND next_attempt_at <= ? AND lease_until <= ? AND attempts < ?`,
                [token, claimedAt + 60000, event.event_id, claimedAt, claimedAt, MAX_DELIVERY_ATTEMPTS]);
                if (claimed.affectedRows !== 1) continue;
                let errorCode = null;
                try {
                    const timestamp = String(Math.floor(now() / 1000));
                    const result = await request({ method: 'POST', url: config.url, data: event.payload,
                        headers: { 'Content-Type': 'application/json', 'X-Redemption-Timestamp': timestamp,
                            'X-Redemption-Signature': sign(config.secret, timestamp, event.payload) },
                        timeout: 10000, maxRedirects: 0, maxContentLength: 16384,
                        validateStatus: () => true, transformRequest: [value => value] });
                    if (result.status !== 200 || result.data?.status_code !== 0
                        || result.data?.data?.event_id !== event.event_id || result.data?.data?.received !== true) {
                        errorCode = `http_${Number(result.status) || 0}_not_acknowledged`;
                    }
                } catch (_) { errorCode = 'transport_error'; }
                if (errorCode) {
                    const delay = Math.min(3600000, 5000 * 2 ** Math.min(10, Number(event.attempts) || 0));
                    await runExecute(`UPDATE cdk_redemption_outbox SET lease_token = NULL, lease_until = 0,
                        next_attempt_at = ?, last_error = ? WHERE event_id = ? AND lease_token = ?`,
                    [now() + delay, errorCode, event.event_id, token]);
                } else {
                    await runExecute(`UPDATE cdk_redemption_outbox SET delivered_at = CURRENT_TIMESTAMP,
                        lease_token = NULL, lease_until = 0, last_error = NULL WHERE event_id = ? AND lease_token = ?`,
                    [event.event_id, token]);
                }
            }
        } finally { running = false; }
    }
    return { enqueue, deliverPending };
};
module.exports.readConfig = readConfig;
module.exports.sign = sign;
