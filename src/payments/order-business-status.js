'use strict';

const FAILED_STATES = new Set(['failed', 'rejected', 'balance_blocked', 'support_locked']);

// The saved manual result closes the business order independently of the
// provider record. Keeping one durable source also closes previously handled
// orders and prevents a later reconciliation response from reopening them.
function projectBusinessOrder(row = {}) {
    const manualResult = ['success', 'failed'].includes(row.manual_result) ? row.manual_result : null;
    const state = row.orbitcard_state || row.state || row.status || null;
    return {
        business_status: manualResult ? 'closed' : state,
        business_result: manualResult || (state === 'success' ? 'success' : FAILED_STATES.has(state) ? 'failed' : null),
        business_closed_at: manualResult ? row.manual_result_at || null : null
    };
}

module.exports = { projectBusinessOrder };
