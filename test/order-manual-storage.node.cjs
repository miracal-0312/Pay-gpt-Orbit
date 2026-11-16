'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const filename = require.resolve('../src/db/mysql-store');
const source = fs.readFileSync(filename, 'utf8');
function storeFixture(row) {
    const queries = [], real = createRequire(filename), module = { exports: {} };
    const core = { runQuery: async (sql, params) => { queries.push({ sql, params }); return [row]; } };
    new Function('require', 'module', 'exports', '__dirname', source)(id => id === './mysql-core' ? core : real(id),
        module, module.exports, path.dirname(filename));
    return { store: module.exports, queries };
}

test('a failed order explicitly released locally does not leave its unused CDK blocked in lists and exports', async () => {
    const row = { id: 7, cdk_code: 'CODE-7', plan_type: 'plus', used_at: null, task_status: 'manual',
        orbitcard_state: 'funding_pending', task_local_released_at: '2026-11-17 16:00:00' };
    const f = storeFixture(row);
    for (const item of [...(await f.store.listCdks()), ...(await f.store.listCdksExportPage())]) {
        assert.equal(item.status, 'unused'); assert.equal(item.orbitcard_pending_confirmation, false);
    }
    assert.deepEqual(await f.store.getCdkRedemptionStatus(row.cdk_code), { status: 'unused', redeemed: false });
    row.task_status = 'success'; row.orbitcard_state = 'success';
    assert.equal((await f.store.getCdkRedemptionStatus(row.cdk_code)).status, 'unused', 'late original success cannot reclaim a released CDK');
    row.task_status = 'manual'; row.orbitcard_state = 'funding_pending';
    row.used_at = 'another-order';
    assert.equal((await f.store.getCdkRedemptionStatus(row.cdk_code)).status, 'processing');
    row.manual_redeemed_at = 'manual-delivery';
    assert.equal((await f.store.getCdkRedemptionStatus(row.cdk_code)).status, 'redeemed');
    row.manual_redeemed_at = null; row.task_local_released_at = null;
    assert.equal((await f.store.getCdkRedemptionStatus(row.cdk_code)).status, 'processing');
});

test('administrator task listings retain independent human result and local release evidence', async () => {
    const row = { job_key: 'job-1', status: 'manual', orbitcard_state: 'funding_pending',
        manual_result: 'success', manual_result_reason: '其他卡已完成', manual_result_by: 'admin@example.test',
        manual_result_at: '2026-11-17 16:00:00', manual_local_released_at: '2026-11-17 16:01:00',
        manual_local_released_by: 'admin@example.test', manual_local_release_reason: '人工核对后解除占用' };
    const f = storeFixture(row), [order] = await f.store.listAdminTaskLogs();
    assert.equal(order.status, 'manual'); assert.equal(order.orbitcard_state, 'funding_pending');
    for (const key of Object.keys(row).filter(key => key.startsWith('manual_'))) assert.equal(order[key], row[key]);
    await f.store.getTaskStatus('job-1');
    assert.match(f.queries.at(-1).sql, /manual_result, manual_result_reason, manual_result_by, manual_result_at/);
    await f.store.getRunningTaskByCdk('CODE-1');
    assert.match(f.queries.at(-1).sql, /cdk_code = \? AND manual_local_released_at IS NULL AND \(/);
});

test('existing databases receive manual result and local release fields without destructive migrations', async () => {
    const columns = [], queries = [];
    const body = source.slice(source.indexOf('async function ensureLegacyColumns('), source.indexOf('async function recoverHistoricalTasks('));
    const migrate = new Function('ensureColumn', 'runQuery', `${body}; return ensureLegacyColumns;`)(
        async (...args) => columns.push(args), async sql => { queries.push(sql); return [{ total: 1, length: 64 }]; });
    await migrate();
    for (const table of ['task_logs', 'orbitcard_admin_orders']) for (const field of ['manual_result', 'manual_result_at', 'manual_local_released_at', 'manual_local_release_reason']) {
        assert.ok(columns.some(([name, column]) => name === table && column === field));
    }
    for (const table of ['orbitcard_card_fundings', 'orbitcard_card_issues']) {
        assert.ok(columns.some(([name, column]) => name === table && column === 'local_released_at'));
    }
    assert.ok(columns.some(([name, column]) => name === 'order_manual_actions' && column === 'release_local_hold'));
    assert.doesNotMatch(queries.join('\n'), /DROP |TRUNCATE |DELETE /i);
});
