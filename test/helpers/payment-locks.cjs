'use strict';
const { createExecutionLocks } = require('../../payment-execution-lock');

// Two services can share this simulated MySQL server while using separate
// connections and local active-job sets. It runs the production lock manager.
module.exports = function lockServer() {
    const owners = new Map(), connections = [];
    const openConnection = async () => {
        const connection = Object.assign(new (require('node:events').EventEmitter)(), { id: connections.length + 1, closed: false,
            async query(sql, [name]) {
                if (this.closed) throw new Error('connection lost');
                if (sql.includes('GET_LOCK')) {
                    if (owners.has(name) && owners.get(name) !== this.id) return [[{ acquired: 0 }]];
                    owners.set(name, this.id); return [[{ acquired: 1 }]];
                }
                if (sql.includes('IS_USED_LOCK')) return [[{ owned: owners.get(name) === this.id ? 1 : 0 }]];
                throw new Error('Unexpected lock query');
            }, destroy() {
                this.closed = true;
                for (const [name, owner] of owners) if (owner === this.id) owners.delete(name);
            }
        });
        connections.push(connection); return connection;
    };
    return { acquirePaymentLock: createExecutionLocks({ openConnection, namespace: 'test' }), owners, connections, openConnection };
};
