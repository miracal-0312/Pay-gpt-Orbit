'use strict';

const { validateSmtpConfig } = require('./email-config');
const MAX_ACTIVE = 2;
const ERROR_MESSAGES = Object.freeze({
    smtp_config: '邮件配置无效，请检查 SMTP 参数或重新保存密码',
    smtp_auth: 'SMTP 登录失败，请检查邮箱授权码或账号',
    smtp_tls: 'SMTP 加密连接失败，请检查主机名、端口和 TLS 设置',
    smtp_timeout: '邮件发送超时，投递结果待核对',
    smtp_recipient: '邮件服务器未接受收件地址，请检查管理员邮箱',
    smtp_transport: '邮件发送暂不可用，请检查 SMTP 服务及网络',
    smtp_busy: '邮件发送繁忙，请稍后重试',
    smtp_message: '邮件内容或通知标识无效'
});

function failure(error_code) { return { ok: false, error_code, message: ERROR_MESSAGES[error_code] }; }
function errorCode(error) {
    if (error?.code === 'EAUTH') return 'smtp_auth';
    if (['ETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.code)) return 'smtp_tls';
    if (['ETIMEDOUT', 'ETIMEOUT', 'EABORT', 'ESOCKETTIMEDOUT'].includes(error?.code)) return 'smtp_timeout';
    if (error?.code === 'EENVELOPE') return 'smtp_recipient';
    return 'smtp_transport';
}

module.exports = function createMailer({ createTransport = options => require('nodemailer').createTransport(options) } = {}) {
    let active = 0;
    async function send(input, message = {}) {
        let config;
        try { config = validateSmtpConfig(input); } catch (_) { return failure('smtp_config'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)
            || typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 200
            || /[\x00-\x1f\x7f]/.test(message.subject) || typeof message.text !== 'string' || !message.text.trim()
            || Buffer.byteLength(message.text) > 32768 || /\x00/.test(message.text)
            || typeof message.messageId !== 'string' || !/^<[a-zA-Z0-9._-]{1,128}@[a-zA-Z0-9.-]{1,128}>$/.test(message.messageId)) {
            return failure('smtp_message');
        }
        if (active >= MAX_ACTIVE) return failure('smtp_busy');
        active++;
        let transporter;
        try {
            transporter = createTransport({ host: config.smtp_host, port: config.smtp_port, secure: config.smtp_secure,
                requireTLS: !config.smtp_secure, ignoreTLS: false, opportunisticTLS: false,
                tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
                auth: { user: config.smtp_user, pass: config.smtp_password },
                pool: false, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 5000,
                logger: false, debug: false, transactionLog: false, maxRecipients: 1,
                disableFileAccess: true, disableUrlAccess: true });
            const result = await transporter.sendMail({ from: config.from_email, to: config.to_email,
                subject: message.subject, text: message.text, messageId: message.messageId,
                envelope: { from: config.from_email, to: [config.to_email] },
                disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
                signal: AbortSignal.timeout(25000) });
            if (!Array.isArray(result?.accepted) || !result.accepted.some(value =>
                typeof value === 'string' && value.toLowerCase() === config.to_email.toLowerCase())) {
                return failure('smtp_recipient');
            }
            // SMTP acceptance is not a guarantee of inbox delivery. Keep the
            // caller's stable identifier for any later delivery reconciliation.
            return { ok: true, messageId: message.messageId };
        } catch (error) {
            return failure(errorCode(error));
        } finally {
            try { transporter?.close?.(); } catch (_) { /* Closing cannot expose transport details. */ }
            active--;
        }
    }
    return { send };
};
module.exports.createMailer = module.exports;
