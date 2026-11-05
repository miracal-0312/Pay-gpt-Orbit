'use strict';

// Read-only troubleshooting: never print credentials, full card details or Session data.
function diagnostic(result, cardId, page) {
    const allowed = ['transaction_id', 'id', 'card_id', 'transaction_type', 'type', 'status',
        'amount', 'authorization_amount', 'settlement_amount', 'currency'];
    const rows = Array.isArray(result.data?.list) ? result.data.list : [];
    return {
        card_id: cardId, page, success: result.success === true,
        http_status: result.status ?? null, platform_code: result.code ?? null,
        total: Number.isSafeInteger(Number(result.data?.total)) ? Number(result.data.total) : null,
        records: rows.slice(0, 20).map(row => Object.fromEntries(allowed
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
