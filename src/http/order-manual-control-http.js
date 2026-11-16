'use strict';

// The parent router checks the administrator session; each operation also
// requires a fresh secondary token, including reading private order history.
module.exports = function registerOrderManualControl(app, { store, requireSecondaryAuth }) {
    const handle = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await action(req, res); }
        catch (error) {
            const known = [400, 404, 409].includes(error?.status);
            res.status(known ? error.status : 503).json({ success: false,
                message: known ? error.message : '订单人工处理暂不可用，请刷新原订单后重试' });
        }
    };
    for (const [kind, route, parameter] of [
        ['task', '/api/admin/orders/:jobKey/manual', 'jobKey'],
        ['admin', '/api/admin/manual/orders/:requestId/manual', 'requestId']
    ]) {
        app.get(route, requireSecondaryAuth, handle(async (req, res) => {
            const data = await store.getOrderManualControl({ kind, id: req.params[parameter] });
            res.json({ success: true, data });
        }));
        app.post(route, requireSecondaryAuth, handle(async (req, res) => {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ success: false, message: '请填写有效的人工处理操作和原因' });
            }
            const data = await store.applyOrderManualControl({ kind, id: req.params[parameter],
                action: req.body.action, expectedRevision: req.body.expected_revision,
                releaseLocalHold: req.body.release_local_hold,
                reason: req.body.reason, adminEmail: req.admin?.email || '' });
            res.json({ success: true, data, message: '人工处理已保存，订单与处理记录已更新' });
        }));
    }
};
