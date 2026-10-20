CREATE TABLE IF NOT EXISTS app_config (
    config_key VARCHAR(64) NOT NULL PRIMARY KEY,
    config_value TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cdk_codes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cdk_code VARCHAR(32) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped_at TIMESTAMP NULL DEFAULT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    type VARCHAR(16) NOT NULL DEFAULT '自助',
    plan_type VARCHAR(16) NOT NULL DEFAULT 'plus' COMMENT 'plus/pro100/pro200/pro500 (legacy: pro_5x/pro_20x)',
    fail_count INT DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_cdk_codes_code (cdk_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_key VARCHAR(64) NOT NULL,
    token_preview VARCHAR(64) NOT NULL,
    session_payload MEDIUMTEXT NULL,    orbitcard_client_order_no VARCHAR(128) NULL,
    orbitcard_state VARCHAR(32) NULL,
    orbitcard_plan_type VARCHAR(64) NULL,
    orbitcard_email VARCHAR(255) NULL,
    orbitcard_base_url VARCHAR(255) NULL,
    cdk_code VARCHAR(32) NULL,    status VARCHAR(32) NOT NULL,
    message VARCHAR(255) NULL,
    progress INT NOT NULL DEFAULT 0,
    display_time VARCHAR(64) NOT NULL,
    raw_output MEDIUMTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_task_logs_job_key (job_key),
    KEY idx_task_logs_created (created_at),
    KEY idx_task_logs_status_created (status, created_at),
    KEY idx_task_cdk_id (cdk_code, id),
    KEY idx_task_orbit_recovery (orbitcard_state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_login_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event VARCHAR(32) NOT NULL COMMENT 'login_success/login_failed/2fa_failed/secondary_failed/secondary_success/password_changed/logout',
    admin_email VARCHAR(128) NULL DEFAULT NULL,
    ip VARCHAR(45) NULL DEFAULT NULL,
    user_agent VARCHAR(512) NULL DEFAULT NULL,
    fingerprint VARCHAR(128) NULL DEFAULT NULL,
    detail VARCHAR(512) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_admin_login_created (created_at),
    KEY idx_admin_login_event (event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
