'use strict';

const CONFIG_FIELDS = ['enabled', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'from_email', 'to_email',
    'on_low_balance', 'on_success', 'on_failure', 'balance_threshold', 'balance_cooldown_minutes', 'enabled_since', 'smtp_password_saved', 'smtp_password_error'];
const HISTORY_FIELDS = ['event_type', 'target_email', 'status', 'attempts', 'last_error', 'created_at', 'delivered_at'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));

// The parent router already authenticates the administrator. Reading SMTP
// settings or sending mail additionally requires a current secondary token.
module.exports = function registerEmailNotifications(app, { store, requireSecondaryAuth, emailNotifications }) {
    const handler = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await action(req, res); }
        catch (error) {
            const invalid = error?.code === 'EMAIL_CONFIG_INVALID';
            res.status(invalid ? 400 : 503).json({ success: false,
                message: invalid ? error.message : '邮件通知服务暂不可用，请检查配置后重试' });
        }
    };
    app.get('/api/admin/email-notifications', requireSecondaryAuth, handler(async (_req, res) => {
        const [config, history] = await Promise.all([
            store.getPublicEmailConfig(), store.getEmailNotificationHistory({ limit: 20 })
        ]);
        res.json({ success: true, config: pick(config, CONFIG_FIELDS),
            history: history.slice(0, 20).map(row => pick(row, HISTORY_FIELDS)) });
    }));
    app.post('/api/admin/email-notifications', requireSecondaryAuth, handler(async (req, res) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({ success: false, message: '邮件通知配置必须为有效对象' });
        }
        const config = await store.saveEmailConfig(req.body);
        res.json({ success: true, config: pick(config, CONFIG_FIELDS), message: '邮件通知配置已保存' });
    }));
    app.post('/api/admin/email-notifications/test', requireSecondaryAuth, handler(async (_req, res) => {
        // Never accept a recipient, subject or message from this request body.
        // The saved administrator address is the only permitted destination.
        const result = await emailNotifications.testEmail();
        res.json({ success: result.success === true, message: result.message });
    }));
};
