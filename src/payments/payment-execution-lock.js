'use strict';
const crypto = require('node:crypto');

function cdkLockKey(cdk) {
    if (!/^[a-zA-Z0-9_-]{4,32}$/.test(String(cdk || ''))) throw new Error('无效的 CDK 执行锁标识');
    return `cdk:${cdk.toLowerCase()}`;
}
function manualLockKeys(requestId, cdk) {
    return [`manual:${String(requestId).toLowerCase()}`, ...(cdk ? [cdkLockKey(cdk)] : [])];
}

// Dedicated connections never consume the query pool while a network payment is
// running. GET_LOCK is nonblocking: contenders cannot exhaust the pool waiting.
function createExecutionLocks({ openConnection, namespace = '' }) {
    return async function acquirePaymentLock(keys) {
        keys = [...new Set(Array.isArray(keys) ? keys : [keys])].sort();
        if (!keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 256)) throw new Error('无效的执行锁');
        const names = keys.map(key => 'oc-run-' + crypto.createHash('sha256').update(`${namespace}\0${key}`).digest('hex').slice(0, 56));
        const connection = await openConnection();
        let closed = false, lost = false;
        connection.on?.('error', () => { lost = true; });
        connection.on?.('end', () => { lost = true; });
        const release = async () => {
            if (closed) return;
            closed = true;
            // Destroy rather than pool: disconnect releases every lock even if
            // RELEASE_LOCK itself fails, and cannot leak an owner into reuse.
            connection.destroy();
        };
        try {
            for (const name of names) {
                const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
                if (Number(rows[0]?.acquired) !== 1) { await release(); return null; }
            }
            return { release, async assertOwned() {
                if (closed || lost) throw new Error('支付执行锁已失效，停止当前操作');
                for (const name of names) {
                    const [rows] = await connection.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [name]);
                    if (Number(rows[0]?.owned) !== 1) throw new Error('支付执行权已变更，停止当前操作');
                }
            } };
        } catch (error) { await release(); throw error; }
    };
}
module.exports = { createExecutionLocks, cdkLockKey, manualLockKeys };
