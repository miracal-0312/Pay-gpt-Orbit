'use strict';
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const targetHash = target => hash(String(target).trim().toLowerCase());
const MAX_ATTEMPTS = 5;
const CHECK_INTERVAL_MS = 300000;
const EVENT_TYPES = ['order_success', 'order_failure', 'order_review', 'low_balance'];

module.exports = function createEmailNotificationStore({ runQuery, runExecute, withTransaction, now = Date.now }) {
    async function insertEvent(event, targetEmail, options) {
        if (!/^[a-f0-9]{64}$/.test(event?.event_id) || !EVENT_TYPES.includes(event.event_type)
            || typeof event.subject !== 'string' || event.subject.length > 200 || /[\r\n]/.test(event.subject)
            || typeof event.text !== 'string' || event.text.length > 8000
            || typeof targetEmail !== 'string' || targetEmail.length > 254 || /[\r\n]/.test(targetEmail)) {
            throw new Error('邮件通知数据格式无效');
        }
        await runExecute(`INSERT INTO email_notification_outbox
            (event_id,event_type,target_email,target_hash,subject,body) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE event_id=event_id`,
        [event.event_id,event.event_type,targetEmail,targetHash(targetEmail),event.subject,event.text], options);
    }

    async function listEmailOrderCandidates({ since, targetEmail, limit = 50 }) {
        const size = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
        const cutoff = Math.floor(Number(since) / 1000) * 1000;
        if (!Number.isSafeInteger(cutoff) || cutoff <= 0) return [];
        const recipient = targetHash(targetEmail);
        // Only explicit fields needed for proof are read. Raw proof never enters
        // the mail queue; the worker builds a new allowlisted message.
        const taskVersion = "SHA2(CONCAT_WS('|',UNIX_TIMESTAMP(t.updated_at),t.status,t.orbitcard_state,COALESCE(t.gpt_api_raw,'')),256)";
        const manualVersion = "SHA2(CONCAT_WS('|',UNIX_TIMESTAMP(m.updated_at),m.state,COALESCE(m.snapshot,'')),256)";
        const [tasks, manual] = await Promise.all([
            runQuery(`SELECT 'self_service' AS source_type,t.job_key AS record_key,
                COALESCE(NULLIF(t.orbitcard_retry_root_job_key,''),t.job_key) AS business_key,
                t.orbitcard_client_order_no AS client_order_no,t.gpt_api_order_id AS order_no,
                t.orbitcard_plan_type AS plan_type,t.orbitcard_email AS target_email,t.orbitcard_card_id AS card_id,
                t.orbitcard_state AS state,t.gpt_api_raw AS snapshot,
                CAST(UNIX_TIMESTAMP(t.updated_at)*1000 AS UNSIGNED) AS updated_ms,${taskVersion} AS version_key
                FROM task_logs t LEFT JOIN email_notification_observations o ON o.source_type='self_service'
                    AND o.record_key=t.job_key AND o.target_hash=?
                WHERE t.orbitcard_client_order_no IS NOT NULL
                    AND t.orbitcard_state IN ('success','failed','rejected','support_locked')
                    AND t.status IN ('success','failed','retry') AND t.updated_at>=FROM_UNIXTIME(?/1000)
                    AND NOT EXISTS (SELECT 1 FROM task_logs newer WHERE newer.cdk_code=t.cdk_code AND newer.id>t.id
                        AND COALESCE(NULLIF(newer.orbitcard_retry_root_job_key,''),newer.job_key)
                            =COALESCE(NULLIF(t.orbitcard_retry_root_job_key,''),t.job_key))
                    AND (o.record_key IS NULL OR o.enabled_since<>? OR o.version_key<>${taskVersion})
                ORDER BY t.updated_at,t.id LIMIT ?`, [recipient,cutoff,Number(since),size]),
            runQuery(`SELECT 'admin' AS source_type,m.request_id AS record_key,m.request_id AS business_key,
                m.client_order_no,m.task_no AS order_no,m.plan_type,m.target_email,m.card_id,m.mode,
                m.state,m.snapshot,CAST(UNIX_TIMESTAMP(m.updated_at)*1000 AS UNSIGNED) AS updated_ms,
                ${manualVersion} AS version_key FROM orbitcard_admin_orders m
                LEFT JOIN email_notification_observations o ON o.source_type='admin'
                    AND o.record_key=m.request_id AND o.target_hash=?
                WHERE m.state IN ('success','failed','rejected','support_locked')
                    AND m.updated_at>=FROM_UNIXTIME(?/1000)
                    AND (o.record_key IS NULL OR o.enabled_since<>? OR o.version_key<>${manualVersion})
                ORDER BY m.updated_at,m.request_id LIMIT ?`, [recipient,cutoff,Number(since),size])
        ]);
        return [...tasks, ...manual].map(row => ({ ...row, enabled_since: Number(since) }));
    }

    async function commitEmailObservation(row, targetEmail, event = null) {
        if (!['self_service','admin'].includes(row.source_type) || !/^[a-f0-9]{64}$/.test(row.version_key)
            || typeof row.record_key !== 'string' || row.record_key.length > 128
            || !Number.isSafeInteger(row.enabled_since) || row.enabled_since <= 0) throw new Error('邮件订单观察记录无效');
        return withTransaction(async connection => {
            const options = { connection };
            if (event) await insertEvent(event, targetEmail, options);
            await runExecute(`INSERT INTO email_notification_observations
                (source_type,record_key,target_hash,version_key,enabled_since) VALUES (?,?,?,?,?)
                ON DUPLICATE KEY UPDATE version_key=VALUES(version_key),enabled_since=VALUES(enabled_since)`,
            [row.source_type,row.record_key,targetHash(targetEmail),row.version_key,row.enabled_since], options);
        });
    }

    async function claimEmailBalanceCheck(accountKey, targetEmail) {
        if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new Error('邮件余额账户标识无效');
        const recipient = targetHash(targetEmail), alertKey = hash(`${accountKey}|${recipient}`), token = crypto.randomUUID();
        await runExecute(`INSERT IGNORE INTO email_balance_alerts (alert_key,account_key,target_hash) VALUES (?,?,?)`,
            [alertKey,accountKey,recipient]);
        const claimedAt = now();
        const claim = await runExecute(`UPDATE email_balance_alerts SET check_token=?,next_check_at=?
            WHERE alert_key=? AND next_check_at<=?`, [token,claimedAt+CHECK_INTERVAL_MS,alertKey,claimedAt]);
        return claim.affectedRows === 1 ? { alert_key:alertKey,token,target_email:targetEmail } : null;
    }

    async function completeEmailBalanceCheck(claim, observation) {
        return withTransaction(async connection => {
            const options = { connection };
            const [current] = await runQuery('SELECT * FROM email_balance_alerts WHERE alert_key=? AND check_token=? FOR UPDATE',
                [claim.alert_key,claim.token], options);
            if (!current) return false;
            const checkedAt = now(), low = observation.low === true;
            const cooldown = Math.min(10080, Math.max(1, Number(observation.cooldown_minutes) || 360)) * 60000;
            let sequence = Number(current.alert_sequence || 0), queuedAt = Number(current.last_queued_at || 0);
            if (low && (Number(current.is_low) !== 1 || queuedAt + cooldown <= checkedAt)) {
                sequence++;
                const event = { event_id:hash(`balance|${claim.alert_key}|${sequence}`),event_type:'low_balance',
                    subject:'[Pay-gpt-Orbit] 账户余额预警',
                    text:`卡台账户可用余额低于预警阈值。\n\n平台：${observation.platform}\n可用余额：${observation.available} USD\n预警阈值：${observation.threshold} USD\n检查时间：${new Date(checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）\n\n请登录管理后台核对账户并补充资金。此邮件不代表任何订单失败，也不会发起充值。` };
                await insertEvent(event, claim.target_email, options);
                queuedAt = checkedAt;
            }
            await runExecute(`UPDATE email_balance_alerts SET is_low=?,alert_sequence=?,last_queued_at=?,
                last_checked_at=?,check_token=NULL WHERE alert_key=? AND check_token=?`,
            [low ? 1 : 0,sequence,queuedAt,checkedAt,claim.alert_key,claim.token], options);
            return true;
        });
    }

    async function deferEmailBalanceCheck(claim, retryAfterMs = 0) {
        const delay = Number.isFinite(Number(retryAfterMs)) ? Math.max(CHECK_INTERVAL_MS,Number(retryAfterMs)) : CHECK_INTERVAL_MS;
        await runExecute(`UPDATE email_balance_alerts SET check_token=NULL,next_check_at=GREATEST(next_check_at,?)
            WHERE alert_key=? AND check_token=?`, [now()+delay,claim.alert_key,claim.token]);
    }

    async function listPendingEmails(targetEmail, eventTypes = EVENT_TYPES) {
        const types = eventTypes.filter(type => EVENT_TYPES.includes(type));
        if (!types.length) return [];
        return runQuery(`SELECT event_id,event_type,target_email,subject,body,attempts FROM email_notification_outbox
            WHERE target_hash=? AND delivered_at IS NULL AND attempts<? AND next_attempt_at<=? AND lease_until<=?
            AND event_type IN (${types.map(() => '?').join(',')}) ORDER BY created_at,event_id LIMIT 10`,
        [targetHash(targetEmail),MAX_ATTEMPTS,now(),now(),...types]);
    }
    async function claimEmailDelivery(eventId) {
        const token = crypto.randomUUID(), time = now();
        const result = await runExecute(`UPDATE email_notification_outbox SET lease_token=?,lease_until=?,attempts=attempts+1
            WHERE event_id=? AND delivered_at IS NULL AND attempts<? AND next_attempt_at<=? AND lease_until<=?`,
        [token,time+120000,eventId,MAX_ATTEMPTS,time,time]);
        return result.affectedRows === 1 ? token : null;
    }
    async function finishEmailDelivery(eventId, token, result) {
        if (result?.deferred) {
            return runExecute(`UPDATE email_notification_outbox SET lease_token=NULL,lease_until=0,
                attempts=GREATEST(attempts-1,0),next_attempt_at=? WHERE event_id=? AND lease_token=?`, [now()+30000,eventId,token]);
        }
        if (result?.ok) return runExecute(`UPDATE email_notification_outbox SET delivered_at=CURRENT_TIMESTAMP,
            lease_token=NULL,lease_until=0,last_error=NULL WHERE event_id=? AND lease_token=?`, [eventId,token]);
        const allowed = ['smtp_auth','smtp_tls','smtp_timeout','smtp_recipient','smtp_transport','smtp_config','smtp_busy','smtp_message'];
        const code = allowed.includes(result?.error_code) ? result.error_code : 'smtp_transport';
        return runExecute(`UPDATE email_notification_outbox SET lease_token=NULL,lease_until=0,last_error=?,
            next_attempt_at=?+LEAST(3600000,30000*POW(2,attempts-1)) WHERE event_id=? AND lease_token=?`,
        [code,now(),eventId,token]);
    }
    async function getEmailNotificationHistory({ limit = 20 } = {}) {
        return runQuery(`SELECT event_type,target_email,attempts,last_error,created_at,delivered_at,
            CASE WHEN delivered_at IS NOT NULL THEN 'sent' WHEN attempts>=? THEN 'failed' ELSE 'pending' END AS status
            FROM email_notification_outbox ORDER BY created_at DESC,event_id DESC LIMIT ?`,
        [MAX_ATTEMPTS,Math.min(100,Math.max(1,Math.trunc(Number(limit) || 20)))]);
    }
    return { listEmailOrderCandidates,commitEmailObservation,claimEmailBalanceCheck,completeEmailBalanceCheck,deferEmailBalanceCheck,
        listPendingEmails,claimEmailDelivery,finishEmailDelivery,getEmailNotificationHistory };
};
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
