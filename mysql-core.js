// Database transport, administrator security and Orbitcard configuration.
'use strict';
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const orbitcardConfig = require('./orbitcard-config');
const { normalizeAdminPaths } = require('./admin-paths');
let pool = null;
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_NAME = process.env.DB_NAME || 'plus_papay';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DEFAULT_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@vru.cc').trim().toLowerCase();
const DEFAULT_ADMIN_LOGIN_PATH = String(process.env.ADMIN_LOGIN_PATH || 'admin-login').trim().toLowerCase();
const DEFAULT_ADMIN_PANEL_PATH = String(process.env.ADMIN_PANEL_PATH || 'admin').trim().toLowerCase();
const GPT_API_CONFIG_KEYS = [
    'gpt_api_enabled', 'gpt_api_base_url', 'gpt_api_protocol_version',
    'orbitcard_max_fee', 'orbitcard_product_code', 'orbitcard_safety_margin', 'orbitcard_max_initial_amount', 'orbitcard_payment_regions'
];

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME,
            charset: 'utf8mb4',
            waitForConnections: true,
            connectionLimit: Number(process.env.DB_POOL_LIMIT || 20),
            queueLimit: 0,
            namedPlaceholders: false,
            multipleStatements: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000
        });
    }

    return pool;
}

function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

async function runQuery(sql, params = [], options = {}) {
    const executor = options.connection || getPool();

    try {
        const [rows] = await executor.query(sql, params);
        return rows;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function runExecute(sql, params = [], options = {}) {
    const executor = options.connection || getPool();

    try {
        const [result] = await executor.execute(sql, params);
        return result;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function withTransaction(callback) {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function ensureGptApiConfigDefaults() {
    await withTransaction(async connection => {
        const options = { connection };
        const keys = [...GPT_API_CONFIG_KEYS, ...orbitcardConfig.RETIRED_CONFIG_KEYS];
        const rows = await runQuery(`SELECT config_key, config_value FROM app_config WHERE config_key IN (${keys.map(() => '?').join(', ')}) FOR UPDATE`, keys, options);
        const saved = Object.fromEntries(rows.map(row => [row.config_key, row.config_value]));
        const defaults = { gpt_api_enabled: '0', gpt_api_base_url: orbitcardConfig.DEFAULT_BASE_URL,
            orbitcard_max_fee: '',
            orbitcard_product_code: '', orbitcard_safety_margin: '1', orbitcard_max_initial_amount: '',
            orbitcard_payment_regions: '{}',
        };
        for (const [key, value] of Object.entries(defaults)) {
            if (saved[key] == null) await runExecute('INSERT IGNORE INTO app_config (config_key, config_value) VALUES (?, ?)', [key, value], options);
        }
        for (const [key, value] of Object.entries(orbitcardConfig.migrationValues(saved))) {
            await runExecute(`INSERT INTO app_config (config_key, config_value) VALUES (?, ?)
                ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`, [key, value], options);
        }
        const retired = orbitcardConfig.RETIRED_CONFIG_KEYS;
        await runExecute(`DELETE FROM app_config WHERE config_key IN (${retired.map(() => '?').join(', ')})`, retired, options);
        // Keep legacy credentials until both environment values are present, then remove
        // them from the database. They are never used for requests in either case.
        if (String(process.env.ORBITCARD_API_KEY || '').trim() && String(process.env.ORBITCARD_API_SECRET || '').trim()) {
            await runExecute('DELETE FROM app_config WHERE config_key IN (?, ?)',
                ['gpt_api_key', 'orbitcard_api_secret_ciphertext'], options);
        }
    });
}

async function getGptApiConfig() {
    const rows = await runQuery(`SELECT config_key, config_value FROM app_config
        WHERE config_key IN (${GPT_API_CONFIG_KEYS.map(() => '?').join(', ')})`, GPT_API_CONFIG_KEYS);
    const map = Object.fromEntries(rows.map(row => [row.config_key, row.config_value]));
    return {
        provider: 'orbitcard',
        enabled: map.gpt_api_enabled === '1',
        base_url: String(map.gpt_api_base_url || orbitcardConfig.DEFAULT_BASE_URL).trim(),
        api_key: String(process.env.ORBITCARD_API_KEY || '').trim(),
        orbitcard_max_fee: String(map.orbitcard_max_fee || ''),
        orbitcard_product_code: String(map.orbitcard_product_code || ''),
        orbitcard_safety_margin: String(map.orbitcard_safety_margin ?? '1'),
        orbitcard_max_initial_amount: String(map.orbitcard_max_initial_amount || ''),
        orbitcard_payment_regions: orbitcardConfig.normalizePaymentRegions(JSON.parse(map.orbitcard_payment_regions || '{}'))
    };
}

async function saveGptApiConfig(input = {}) {
    if (Object.hasOwn(input, 'api_key') || Object.hasOwn(input, 'api_secret')) {
        throw new Error('API Key 和 API Secret 只能在服务器环境变量中配置');
    }
    if (Object.keys(input).some(key => key === 'orbitcard_region' || /^orbitcard_(?:price|region)_(?:plus|pro100|pro200|pro500)$/.test(key))) {
        throw new Error('套餐金额使用平台推荐价；旧版预算或地区字段已停用，请使用四档默认充值地区配置');
    }
    const existing = await getGptApiConfig();
    const cfg = orbitcardConfig.prepareConfig(input, existing, Boolean(String(process.env.ORBITCARD_API_SECRET || '').trim()));
    const values = { gpt_api_enabled: cfg.enabled ? '1' : '0', gpt_api_base_url: cfg.base_url,
        gpt_api_protocol_version: orbitcardConfig.PROTOCOL_VERSION,
        orbitcard_max_fee: cfg.orbitcard_max_fee,
        orbitcard_product_code: cfg.orbitcard_product_code, orbitcard_safety_margin: cfg.orbitcard_safety_margin,
        orbitcard_max_initial_amount: cfg.orbitcard_max_initial_amount,
        orbitcard_payment_regions: JSON.stringify(cfg.orbitcard_payment_regions) };
    await withTransaction(async connection => {
        for (const [key, value] of Object.entries(values)) {
            await runExecute(`INSERT INTO app_config (config_key, config_value) VALUES (?, ?)
                ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`, [key, value], { connection });
        }
    });
}

async function hasColumn(tableName, columnName) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [DB_NAME, tableName, columnName]
    );

    return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(tableName, columnName, columnDefinition) {
    if (await hasColumn(tableName, columnName)) {
        return;
    }

    await runQuery(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
}

async function getAppConfigValue(configKey, fallbackValue = '') {
    const rows = await runQuery(
        `SELECT config_value
         FROM app_config
         WHERE config_key = ?
         LIMIT 1`,
        [String(configKey)]
    );
    return rows[0]?.config_value ?? fallbackValue;
}

async function setAppConfigValue(configKey, configValue) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [String(configKey), String(configValue ?? '')]
    );
}

async function getTelegramConfig() {
    const keys = [
        'telegram_bot_token',
        'telegram_admin_chat_id',
        'telegram_group_chat_id',
        'telegram_notify_admin',
        'telegram_notify_group',
        'telegram_on_success',
        'telegram_on_failure'
    ];
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (${keys.map(() => '?').join(', ')})`,
        keys
    );
    const map = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        bot_token: String(map.telegram_bot_token || '').trim(),
        admin_chat_id: String(map.telegram_admin_chat_id || '').trim(),
        group_chat_id: String(map.telegram_group_chat_id || '').trim(),
        notify_admin: String(map.telegram_notify_admin || '0') === '1',
        notify_group: String(map.telegram_notify_group || '0') === '1',
        on_success: String(map.telegram_on_success || '0') === '1',
        on_failure: String(map.telegram_on_failure || '0') === '1'
    };
}

async function saveTelegramConfig(config = {}) {
    const existing = await getTelegramConfig();
    const values = { telegram_bot_token: String(config.bot_token || '').trim() || existing.bot_token,
        telegram_admin_chat_id: String(config.admin_chat_id || '').trim(), telegram_group_chat_id: String(config.group_chat_id || '').trim(),
        telegram_notify_admin: config.notify_admin ? '1' : '0', telegram_notify_group: config.notify_group ? '1' : '0',
        telegram_on_success: config.on_success ? '1' : '0', telegram_on_failure: config.on_failure ? '1' : '0' };
    await withTransaction(async connection => {
        for (const [key, value] of Object.entries(values)) await runExecute(
            'INSERT INTO app_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
            [key, value], { connection });
    });
}

async function getMaintenanceModeState() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['maintenance_mode', 'maintenance_mode_drain']
    );
    const configMap = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        enabled: String(configMap.maintenance_mode || '0') === '1',
        drain: String(configMap.maintenance_mode_drain || '0') === '1'
    };
}

async function setMaintenanceModeState(enabled, drain = false) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'maintenance_mode', enabled ? '1' : '0',
            'maintenance_mode_drain', drain ? '1' : '0'
        ]
    );
}

async function getAdminAuthConfig() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'admin_password_hash',
            'admin_password_version',
            'admin_email',
            'admin_secondary_password_hash',
            'admin_secondary_password_version',
            'admin_totp_secret',
            'admin_totp_enabled',
            'telegram_on_admin_login',
            'admin_2fa_login_mode'
        ]
    );

    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));

    return {
        email: String(map.admin_email || DEFAULT_ADMIN_EMAIL).trim().toLowerCase(),
        passwordHash: String(map.admin_password_hash || ''),
        passwordVersion: Math.max(1, Number(map.admin_password_version || 1)),
        secondaryPasswordHash: String(map.admin_secondary_password_hash || ''),
        secondaryPasswordVersion: Math.max(1, Number(map.admin_secondary_password_version || 1)),
        totpSecret: String(map.admin_totp_secret || ''),
        totpEnabled: String(map.admin_totp_enabled || '0') === '1',
        notifyAdminLogin: String(map.telegram_on_admin_login || '1') !== '0',
        login2faMode: ['either', 'totp', 'telegram'].includes(String(map.admin_2fa_login_mode || '').trim().toLowerCase())
            ? String(map.admin_2fa_login_mode || 'either').trim().toLowerCase()
            : 'either'
    };
}

async function saveAdmin2faLoginMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['either', 'totp', 'telegram'].includes(normalized)) {
        throw new Error('无效的登录验证方式');
    }
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        ['admin_2fa_login_mode', normalized]
    );
    return normalized;
}

async function getAdminPaths() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['admin_login_path', 'admin_panel_path']
    );
    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));
    return normalizeAdminPaths({
        loginPath: map.admin_login_path || DEFAULT_ADMIN_LOGIN_PATH,
        panelPath: map.admin_panel_path || DEFAULT_ADMIN_PANEL_PATH
    });
}

async function saveAdminPaths({ loginPath, panelPath }) {
    const normalized = normalizeAdminPaths({ loginPath, panelPath });
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_login_path', normalized.loginPath,
                'admin_panel_path', normalized.panelPath
            ],
            { connection }
        );
    });
    return normalized;
}

async function updateAdminEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
        throw new Error('管理员邮箱格式无效');
    }
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.passwordVersion || 1)) + 1;
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_email', normalized,
                'admin_password_version', String(nextVersion)
            ],
            { connection }
        );
    });
    return { email: normalized, passwordVersion: nextVersion };
}

async function updateAdminSecondaryPassword(password) {
    const nextHash = createPasswordHash(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.secondaryPasswordVersion || 1)) + 1;
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_secondary_password_hash', nextHash,
                'admin_secondary_password_version', String(nextVersion)
            ],
            { connection }
        );
    });
    return { secondaryPasswordVersion: nextVersion };
}

async function saveAdminTotpConfig({ secret, enabled }) {
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_totp_secret', String(secret || ''),
                'admin_totp_enabled', enabled ? '1' : '0'
            ],
            { connection }
        );
    });
}

async function insertAdminLoginLog({
    event,
    adminEmail = '',
    ip = '',
    userAgent = '',
    fingerprint = '',
    detail = ''
}) {
    await runExecute(
        `INSERT INTO admin_login_logs (event, admin_email, ip, user_agent, fingerprint, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            String(event || 'unknown').slice(0, 32),
            String(adminEmail || '').slice(0, 128) || null,
            String(ip || '').slice(0, 45) || null,
            String(userAgent || '').slice(0, 512) || null,
            String(fingerprint || '').slice(0, 128) || null,
            String(detail || '').slice(0, 512) || null
        ]
    );
}

async function listAdminLoginLogs(limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = await runQuery(
        `SELECT id, event, admin_email, ip, user_agent, fingerprint, detail, created_at
         FROM admin_login_logs
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [safeLimit, safeOffset]
    );
    const countRows = await runQuery(`SELECT COUNT(*) AS total FROM admin_login_logs`);
    return {
        logs: rows,
        total: Number(countRows[0]?.total || 0),
        limit: safeLimit,
        offset: safeOffset
    };
}

async function updateAdminPassword(password) {
    const nextHash = createPasswordHash(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.passwordVersion || 1)) + 1;

    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_password_hash', nextHash,
                'admin_password_version', String(nextVersion)
            ],
            { connection }
        );
    });

    return {
        passwordHash: nextHash,
        passwordVersion: nextVersion
    };
}
module.exports = { getPool, createPasswordHash, runQuery, runExecute, withTransaction, ensureGptApiConfigDefaults, getGptApiConfig, saveGptApiConfig, hasColumn, ensureColumn, getAppConfigValue, setAppConfigValue, getTelegramConfig, saveTelegramConfig, getMaintenanceModeState, setMaintenanceModeState, getAdminAuthConfig, saveAdmin2faLoginMode, getAdminPaths, saveAdminPaths, updateAdminEmail, updateAdminSecondaryPassword, saveAdminTotpConfig, insertAdminLoginLog, listAdminLoginLogs, updateAdminPassword, close: async () => { if (pool) await pool.end(); }, connectionInfo: { host: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER } };
