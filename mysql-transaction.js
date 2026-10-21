'use strict';

// Only database-only callbacks belong here. Never retry an HTTP payment or a
// commit with an unknown result. Each retry starts on a fresh transaction.
module.exports = function createTransactions({ getPool, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 3 }) {
    return async function withTransaction(callback, existingConnection = null) {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const connection = existingConnection || await getPool().getConnection();
            let commitStarted = false, rollbackConfirmed = false, destroyed = false;
            try {
                await connection.beginTransaction();
                const result = await callback(connection);
                commitStarted = true;
                await connection.commit();
                return result;
            } catch (error) {
                try { await connection.rollback(); rollbackConfirmed = true; }
                catch (_) { connection.destroy(); destroyed = true; }
                const conflict = ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code) || [1205,1213].includes(error.errno);
                if (!conflict || commitStarted || !rollbackConfirmed || attempt === attempts) throw error;
            } finally { if (!destroyed && !existingConnection) connection.release(); }
            await sleep(20 * attempt + Math.floor(Math.random() * 30));
        }
    };
};
