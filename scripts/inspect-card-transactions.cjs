'use strict';

// Read-only troubleshooting: never print credentials, full card details or Session data.
function integer(value, minimum = 0) {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function structure(value, depth = 0) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (type !== 'object' || depth >= 3) return type;
    return Object.fromEntries(Object.keys(value)
        .filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 50)
        .map(key => [key, structure(value[key], depth + 1)]));
}

function diagnostic(result, cardId, page) {
    const allowed = ['transaction_id', 'id', 'card_id', 'transaction_type', 'type', 'status',
        'amount', 'authorization_amount', 'settlement_amount', 'currency'];
    const listValid = Array.isArray(result.data?.list);
    const rows = listValid ? result.data.list.slice(0, 20) : [];
    return {
        card_id: cardId, page, success: result.success === true,
        http_status: Number.isSafeInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : null,
        platform_code: Number.isSafeInteger(result.code) ? result.code : null,
        list_valid: listValid,
        pagination: { page: integer(result.data?.page, 1), page_size: integer(result.data?.page_size, 1) },
        total: integer(result.data?.total),
        data_structure: structure(result.data, 2),
        record_structures: rows.map(row => structure(row)),
        records: rows.map(row => Object.fromEntries(allowed
            .filter(key => row && ['string', 'number', 'boolean'].includes(typeof row[key]))
            .map(key => [key, typeof row[key] === 'string' ? row[key].slice(0, 128) : row[key]])))
    };
}

async function main() {
    const cardId = Number(process.argv[2]), page = Number(process.argv[3] || 1);
    if (!Number.isSafeInteger(cardId) || cardId < 1 || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
        throw Object.assign(new Error('Usage: node scripts/inspect-card-transactions.cjs CARD_ID [PAGE]'), { usage: true });
    }
    require('../load-env')();
    const store = require('../mysql-store');
    try {
        const cfg = await store.getGptApiConfig();
        const result = await require('../orbitcard-client').request(cfg, 'cardTransaction', { card_id: cardId, page, page_size: 20 });
        console.log(JSON.stringify(diagnostic(result, cardId, page), null, 2));
        if (!result.success) process.exitCode = 1;
    } finally { await store.close(); }
}

module.exports = { diagnostic };
if (require.main === module) main().catch(error => {
    console.error(error.usage ? error.message : 'Transaction diagnostics failed. Check application logs and platform configuration.');
    process.exitCode = 1;
});
