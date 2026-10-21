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
    plan_type VARCHAR(64) NOT NULL DEFAULT 'plus' COMMENT 'Self-service canonical type or manual Orbitcard plan ID',
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
    orbitcard_retry_root_job_key VARCHAR(64) NULL,
    orbitcard_retry_attempt_no TINYINT UNSIGNED NOT NULL DEFAULT 1,
    orbitcard_retry_first_card_id BIGINT UNSIGNED NULL,
    orbitcard_retry_second_card_id BIGINT UNSIGNED NULL,
    orbitcard_api_key_hash CHAR(64) NULL,
    orbitcard_plan_type VARCHAR(64) NULL,
    orbitcard_email VARCHAR(255) NULL,
    orbitcard_base_url VARCHAR(255) NULL,
    orbitcard_card_id BIGINT UNSIGNED NULL,
    orbitcard_issue_key VARCHAR(80) NULL,
    orbitcard_required_balance DECIMAL(22,8) NULL,
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

CREATE TABLE IF NOT EXISTS orbitcard_card_fundings (
    funding_key VARCHAR(80) NOT NULL PRIMARY KEY,
    scope CHAR(64) NOT NULL,
    job_key VARCHAR(64) NOT NULL,
    plan_type VARCHAR(32) NOT NULL,
    card_id BIGINT UNSIGNED NOT NULL,
    credential_hash CHAR(64) NOT NULL,
    request_body TEXT NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    target_balance DECIMAL(22,8) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'prepared',
    order_no VARCHAR(128) NULL,
    provider_status VARCHAR(32) NULL,
    fee_snapshot TEXT NULL,
    retry_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    message VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_oc_funding_job (job_key),
    KEY idx_oc_funding_card (scope,card_id,state),
    KEY idx_oc_funding_recovery (scope,state,updated_at)
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

CREATE TABLE IF NOT EXISTS orbitcard_managed_cards (
    scope CHAR(64) NOT NULL,
    card_id BIGINT UNSIGNED NOT NULL,
    history_confirmed TINYINT(1) NOT NULL DEFAULT 0,
    successful_plus INT UNSIGNED NOT NULL DEFAULT 0,
    successful_pro100 INT UNSIGNED NOT NULL DEFAULT 0,
    successful_pro200 INT UNSIGNED NOT NULL DEFAULT 0,
    successful_pro500 INT UNSIGNED NOT NULL DEFAULT 0,
    active_job VARCHAR(64) NULL,
    active_plan VARCHAR(16) NULL,
    provider_status VARCHAR(32) NOT NULL DEFAULT '',
    product_code VARCHAR(128) NOT NULL DEFAULT '',
    card_bin VARCHAR(8) NOT NULL DEFAULT '',
    last4 VARCHAR(4) NOT NULL DEFAULT '',
    balance DECIMAL(14,2) NULL,
    currency VARCHAR(8) NOT NULL DEFAULT '',
    source VARCHAR(16) NOT NULL DEFAULT 'imported',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, card_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orbitcard_card_uses (
    job_key VARCHAR(64) NOT NULL PRIMARY KEY,
    scope CHAR(64) NOT NULL,
    card_id BIGINT UNSIGNED NOT NULL,
    plan_type VARCHAR(16) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'reserved',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_oc_card_uses (scope, card_id, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orbitcard_admin_orders (
    request_id CHAR(36) NOT NULL PRIMARY KEY,
    client_order_no VARCHAR(128) NOT NULL,
    scope CHAR(64) NOT NULL,
    api_key_hash CHAR(64) NOT NULL,
    mode VARCHAR(16) NOT NULL DEFAULT 'test',
    cdk_code VARCHAR(32) NULL,
    plan_type VARCHAR(64) NOT NULL,
    plan_name VARCHAR(128) NOT NULL,
    target_email VARCHAR(255) NOT NULL,
    card_id BIGINT UNSIGNED NOT NULL,
    admin_email VARCHAR(128) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'prepared',
    task_no VARCHAR(128) NULL,
    snapshot TEXT NULL,
    message VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_orbitcard_admin_client_order (client_order_no),
    KEY idx_orbitcard_admin_recovery (state, updated_at),
    KEY idx_orbitcard_admin_cdk (cdk_code, created_at),
    KEY idx_orbitcard_admin_target (scope, target_email, plan_type, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orbitcard_card_issues (
    issue_key VARCHAR(80) NOT NULL PRIMARY KEY,
    scope CHAR(64) NOT NULL,
    job_key VARCHAR(64) NULL,
    plan_type VARCHAR(32) NOT NULL,
    credential_hash CHAR(64) NOT NULL,
    request_body TEXT NOT NULL,
    product_code VARCHAR(128) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'prepared',
    order_no VARCHAR(128) NULL,
    card_id BIGINT UNSIGNED NULL,
    message VARCHAR(255) NULL,
    provider_status VARCHAR(32) NULL,
    completed TINYINT(1) NULL,
    fee_snapshot TEXT NULL,
    retry_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_oc_issue_recovery (scope, state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
