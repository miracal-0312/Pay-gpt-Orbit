'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./mysql-core');
const { normalizePlanType, PLAN_LABELS } = require('./plan-registry');
const { summary } = require('./orbitcard-client');
const { runQuery, runExecute, withTransaction, ensureColumn } = core;

async function initializeBaseData() {
    const rows = await runQuery('SELECT config_key, config_value FROM app_config');
    const saved = Object.fromEntries(rows.map(row => [row.config_key, row.config_value]));
    const defaults = {
        admin_email: process.env.ADMIN_EMAIL || 'admin@vru.cc', admin_password_version: '1',
        admin_secondary_password_version: '1', admin_totp_secret: '', admin_totp_enabled: '0',
        admin_2fa_login_mode: 'either', telegram_on_admin_login: '1',
        admin_login_path: process.env.ADMIN_LOGIN_PATH || 'admin-login',
        admin_panel_path: process.env.ADMIN_PANEL_PATH || 'admin',
        max_concurrent_activations: '1', maintenance_mode: '0', maintenance_mode_drain: '0',
        telegram_bot_token: '', telegram_admin_chat_id: '', telegram_group_chat_id: '',
        telegram_notify_admin: '0', telegram_notify_group: '0', telegram_on_success: '0', telegram_on_failure: '0'
    };
    for (const [key, env] of [['admin_password_hash', 'ADMIN_PASSWORD'], ['admin_secondary_password_hash', 'ADMIN_SECONDARY_PASSWORD']]) {
        if (!saved[key]) {
            if (String(process.env[env] || '').length < 8) throw new Error(`首次安装请配置至少 8 位的 ${env}`);
            defaults[key] = core.createPasswordHash(process.env[env]);
        }
    }
    await withTransaction(async connection => {
        for (const [key, value] of Object.entries(defaults)) {
            const sql = key.endsWith('_password_hash')
                ? "INSERT INTO app_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = IF(config_value IS NULL OR config_value = '', VALUES(config_value), config_value)"
                : 'INSERT IGNORE INTO app_config (config_key, config_value) VALUES (?, ?)';
            await runExecute(sql, [key, value], { connection });
        }
    });
}

async function ensureLegacyColumns() {
    // Add only fields needed by this service. Existing historical tables are never dropped.
    const columns = {
        app_config: { created_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
        cdk_codes: { is_active: 'TINYINT(1) NOT NULL DEFAULT 1', shipped_at: 'TIMESTAMP NULL', used_at: 'TIMESTAMP NULL',
            type: "VARCHAR(16) NOT NULL DEFAULT '自助'", plan_type: "VARCHAR(16) NOT NULL DEFAULT 'plus'", created_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
            updated_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
        task_logs: { token_preview: "VARCHAR(64) NOT NULL DEFAULT ''", session_payload: 'MEDIUMTEXT NULL', cdk_code: 'VARCHAR(32) NULL',
            status: "VARCHAR(32) NOT NULL DEFAULT 'running'", message: 'VARCHAR(255) NULL', progress: 'INT NOT NULL DEFAULT 0',
            display_time: "VARCHAR(64) NOT NULL DEFAULT ''", raw_output: 'MEDIUMTEXT NULL',
            orbitcard_client_order_no: 'VARCHAR(128) NULL', orbitcard_state: 'VARCHAR(32) NULL', orbitcard_plan_type: 'VARCHAR(64) NULL',
            orbitcard_retry_root_job_key: 'VARCHAR(64) NULL', orbitcard_retry_attempt_no: 'TINYINT UNSIGNED NOT NULL DEFAULT 1',
            orbitcard_retry_first_card_id: 'BIGINT UNSIGNED NULL', orbitcard_retry_second_card_id: 'BIGINT UNSIGNED NULL',
            orbitcard_api_key_hash: 'CHAR(64) NULL',
            orbitcard_email: 'VARCHAR(255) NULL', orbitcard_base_url: 'VARCHAR(255) NULL', orbitcard_card_id: 'BIGINT UNSIGNED NULL', orbitcard_issue_key: 'VARCHAR(80) NULL', orbitcard_required_balance: 'DECIMAL(22,8) NULL',
            gpt_api_order_id: 'VARCHAR(128) NULL', gpt_api_raw: 'MEDIUMTEXT NULL',
            created_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP', updated_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' }
    };
    for (const [table, fields] of Object.entries(columns)) for (const [name, definition] of Object.entries(fields)) await ensureColumn(table, name, definition);
    for (const [name, fields] of [['idx_task_cdk_id', 'cdk_code, id'], ['idx_task_orbit_recovery', 'orbitcard_state, updated_at']]) {
        const [index] = await runQuery('SELECT COUNT(*) AS total FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', ['task_logs', name]);
        if (!Number(index?.total)) await runQuery(`ALTER TABLE task_logs ADD INDEX ${name} (${fields})`);
    }
}

async function recoverHistoricalTasks() {
    // Retired tasks have no safe provider identity. Preserve reservations for manual reconciliation.
    return withTransaction(async connection => {
        const options = { connection };
        const rows = await runQuery("SELECT cdk_code FROM task_logs WHERE status = 'running' AND orbitcard_client_order_no IS NULL", [], options);
        for (const code of new Set(rows.map(row => row.cdk_code).filter(Boolean))) {
            await runQuery('SELECT cdk_code FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [code], options);
            await runExecute('UPDATE cdk_codes SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE cdk_code = ?', [code], options);
        }
        await runExecute("UPDATE task_logs SET status = 'manual', message = '历史非 Orbitcard 任务已停止，请人工核对原支付；CDK 保持占用' WHERE status = 'running' AND orbitcard_client_order_no IS NULL", [], options);
        return rows.length;
    });
}

async function ensureReady() {
    await runQuery(fs.readFileSync(path.join(__dirname, 'mysql-schema.sql'), 'utf8'));
    await ensureLegacyColumns();
    await initializeBaseData();
    await core.ensureGptApiConfigDefaults();
    await recoverHistoricalTasks();
}

async function createTaskLog({ tokenPreview, cdkCode, status = 'running', progress = 3 }, options = {}) {
    const jobKey = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
    const displayTime = new Date().toLocaleString('zh-CN', { hour12: false });
    await runExecute(`INSERT INTO task_logs (job_key, token_preview, cdk_code, status, message, progress, display_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [jobKey, String(tokenPreview || '').slice(0, 64), cdkCode || null, status, '等待提交 Orbitcard 订单', progress, displayTime], options);
    return { jobKey, displayTime };
}

async function getTaskStatus(jobKey) {
    const rows = await runQuery(`SELECT job_key, cdk_code, status, message, progress, display_time, updated_at,
        orbitcard_client_order_no, orbitcard_state, orbitcard_plan_type, orbitcard_email, orbitcard_base_url, orbitcard_card_id, orbitcard_issue_key, orbitcard_required_balance,
        orbitcard_retry_root_job_key, orbitcard_retry_attempt_no, orbitcard_retry_first_card_id, orbitcard_retry_second_card_id, orbitcard_api_key_hash,
        gpt_api_order_id, gpt_api_raw FROM task_logs WHERE job_key = ? LIMIT 1`, [String(jobKey)]);
    return rows[0] || null;
}

async function getRunningTaskByCdk(cdk) {
    const rows = await runQuery(`SELECT job_key, status, message, progress, orbitcard_client_order_no, orbitcard_state,
        orbitcard_retry_root_job_key, orbitcard_retry_attempt_no, orbitcard_retry_first_card_id, orbitcard_retry_second_card_id, orbitcard_api_key_hash, orbitcard_email, orbitcard_base_url
        FROM task_logs WHERE cdk_code = ? AND (status IN ('running','manual')
        OR orbitcard_state IN ('prepared','retry_waiting','support_locked','balance_blocked','funding_pending','submitting','pending','manual','success')) ORDER BY id DESC LIMIT 1`, [String(cdk)]);
    return rows[0] || null;
}

async function verifyCdkDetails(cdk) {
    const rows = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? AND is_active = 1', [String(cdk)]);
    return rows[0] || null;
}

async function listCdks() {
    const rows = await runQuery(`SELECT c.*, t.job_key, t.status AS task_status, t.orbitcard_state, t.orbitcard_client_order_no
        FROM cdk_codes c LEFT JOIN task_logs t ON t.id = (SELECT MAX(id) FROM task_logs WHERE cdk_code = c.cdk_code)
        WHERE c.is_active = 1 ORDER BY c.id DESC LIMIT 2000`);
    return rows.map(row => ({ code: row.cdk_code, plan_type: row.plan_type, plan_label: PLAN_LABELS[row.plan_type] || row.plan_type,
        type: row.type, shipped: Boolean(row.shipped_at), created_at: row.created_at, jobKey: row.job_key,
        orbitcard_pending_confirmation: row.task_status === 'manual', orbitcard_balance_blocked: row.orbitcard_state==='balance_blocked',
        orbitcard_support_locked: row.orbitcard_state==='support_locked',
        status: ['running','manual'].includes(row.task_status) || ['balance_blocked','support_locked'].includes(row.orbitcard_state) ? 'processing' : row.used_at ? 'used' : 'unused' }));
}

async function insertCdks(cdks, options = {}) {
    if (options.type && options.type !== '自助') throw new Error('只支持 Orbitcard 自助 CDK');
    const planType = normalizePlanType(options.plan_type || 'plus', { allowLegacy: false });
    const values = [...new Set(cdks.map(value => String(value).trim()).filter(Boolean))];
    if (values.length > 1000 || values.some(value => !/^[a-zA-Z0-9_-]{4,32}$/.test(value))) throw new Error('卡密须为 4-32 位字母、数字、下划线或连字符，单次最多 1000 个');
    let insertedCount = 0;
    await withTransaction(async connection => {
        for (const value of values) {
            const result = await runExecute("INSERT IGNORE INTO cdk_codes (cdk_code, is_active, type, plan_type) VALUES (?, 1, '自助', ?)", [value, planType], { connection });
            insertedCount += Number(result.affectedRows || 0);
        }
    });
    return { insertedCount, duplicateCount: values.length - insertedCount, totalCount: values.length };
}

async function markCdkShipped(cdk) {
    const result = await runExecute('UPDATE cdk_codes SET shipped_at = COALESCE(shipped_at, CURRENT_TIMESTAMP) WHERE cdk_code = ? AND is_active = 1', [String(cdk)]);
    return result.affectedRows > 0;
}

async function deleteCdk(cdk) {
    return withTransaction(async connection => {
        const options = { connection };
        const [code] = await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [String(cdk)], options);
        if (!code) return;
        const tasks = await runQuery('SELECT job_key FROM task_logs WHERE cdk_code = ? LIMIT 1', [String(cdk)], options);
        if (code.used_at || tasks.length) throw new Error('已有使用或任务记录的 CDK 不允许删除');
        await runExecute('DELETE FROM cdk_codes WHERE cdk_code = ? AND used_at IS NULL', [String(cdk)], options);
    });
}

async function listAdminTaskLogs(limit = 200) {
    const rows = await runQuery(`SELECT job_key, display_time, cdk_code, token_preview, status, message, progress, updated_at,
        orbitcard_client_order_no, orbitcard_state, orbitcard_plan_type, orbitcard_card_id, gpt_api_order_id, gpt_api_raw
        FROM task_logs ORDER BY id DESC LIMIT ?`, [Math.min(500, Math.max(1, Number(limit) || 200))]);
    return rows.map(row => ({ id: row.job_key, jobKey: row.job_key, time: row.display_time, cdk: row.cdk_code,
        token: row.token_preview, status: row.status, message: row.message, progress: Number(row.progress),
        provider: row.orbitcard_client_order_no ? 'orbitcard' : 'history', order_id: row.gpt_api_order_id,
        client_order_no: row.orbitcard_client_order_no, orbitcard_state: row.orbitcard_state, card_id: row.orbitcard_card_id,
        order: safeOrder(row.gpt_api_raw) }));
}

function safeOrder(raw) {
    try { return summary(JSON.parse(raw || '{}')); } catch (_) { return {}; }
}

async function listRecentGptApiOrders(limit = 10) {
    return runQuery(`SELECT job_key, cdk_code, status, message, updated_at, orbitcard_client_order_no,
        gpt_api_order_id, gpt_api_raw, NULL AS gpt_api_task_id, NULL AS gpt_api_topup_code
        FROM task_logs WHERE orbitcard_client_order_no IS NOT NULL ORDER BY id DESC LIMIT ?`, [Math.min(50, Math.max(1, Number(limit) || 10))]);
}

async function listRecoverableOrbitcardTasks(limit = 50) {
    return runQuery(`SELECT t.* FROM task_logs t JOIN cdk_codes c ON c.cdk_code = t.cdk_code AND c.is_active = 1
        WHERE t.orbitcard_client_order_no IS NOT NULL
          AND t.orbitcard_state IN ('prepared','balance_blocked','funding_pending','card_pending','submitting','pending','manual','success')
          AND t.id = (SELECT MAX(id) FROM task_logs WHERE cdk_code = t.cdk_code)
          AND (t.orbitcard_state <> 'success' OR JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(t.gpt_api_raw), t.gpt_api_raw, '{}'), '$.fee_status')) = 'charge_pending')
        ORDER BY t.updated_at ASC LIMIT ?`, [Math.min(200, Math.max(1, Number(limit) || 50))]);
}

async function noteQueryAttempt(jobKey) {
    await runExecute('UPDATE task_logs SET updated_at = CURRENT_TIMESTAMP WHERE job_key = ?', [jobKey]);
}

async function getMaxConcurrentActivations() {
    return Math.min(100, Math.max(1, Number(await core.getAppConfigValue('max_concurrent_activations', '1')) || 1));
}

async function saveConfig(config = {}) {
    const values = {};
    if (Object.hasOwn(config, 'max_concurrent_activations')) {
        const count = Number(config.max_concurrent_activations);
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('并发数必须为 1-100 的整数');
        values.max_concurrent_activations = String(count);
    }
    if (Object.hasOwn(config, 'maintenance_mode')) values.maintenance_mode = config.maintenance_mode ? '1' : '0';
    if (Object.hasOwn(config, 'maintenance_mode_drain')) values.maintenance_mode_drain = config.maintenance_mode_drain ? '1' : '0';
    await withTransaction(async connection => {
        for (const [key, value] of Object.entries(values)) await runExecute('INSERT INTO app_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)', [key, value], { connection });
    });
}

async function getAdminData() {
    const [[stats], [cdks], logs, maintenance, max, telegram] = await Promise.all([
        runQuery(`SELECT COUNT(*) AS total, COALESCE(SUM(orbitcard_state = 'success'),0) AS success,
            COALESCE(SUM(orbitcard_state IN ('failed','rejected','balance_blocked','support_locked')),0) AS failed,
            COALESCE(SUM(orbitcard_state IN ('prepared','retry_waiting','funding_pending','card_pending','submitting','pending','manual')),0) AS pending
            FROM task_logs WHERE orbitcard_client_order_no IS NOT NULL`),
        runQuery('SELECT COUNT(*) AS total, COALESCE(SUM(used_at IS NOT NULL),0) AS used FROM cdk_codes WHERE is_active = 1'),
        listAdminTaskLogs(), core.getMaintenanceModeState(), getMaxConcurrentActivations(), core.getTelegramConfig()
    ]);
    return { config: { max_concurrent_activations: max, maintenance_mode: maintenance.enabled, maintenance_mode_drain: maintenance.drain },
        stats: { ...stats, cdk_total: Number(cdks.total || 0), cdk_used: Number(cdks.used || 0) }, logs,
        telegram: { ...telegram, bot_token: '', bot_token_saved: Boolean(telegram.bot_token) } };
}

const cardStore = require('./orbitcard-card-store')({ withTransaction, runQuery, runExecute, getPool: core.getPool });
const orbitcardCdkStore = require('./orbitcard-cdk-store')({ withTransaction, runQuery, runExecute, createTaskLog, settleCardUse: cardStore.settleCardUse });
module.exports = { ...core, ...cardStore, ...orbitcardCdkStore, ensureReady, initializeBaseData, createTaskLog, getTaskStatus,
    getRunningTaskByCdk, verifyCdkDetails, listCdks, insertCdks, markCdkShipped, deleteCdk,
    listAdminTaskLogs, listRecentGptApiOrders, listRecoverableOrbitcardTasks, noteQueryAttempt, getMaxConcurrentActivations, saveConfig, getAdminData, safeOrder };
