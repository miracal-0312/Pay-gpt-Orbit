'use strict';

module.exports = function registerDiagnostics(app, { store, requireSecondaryAuth, logs }) {
    const service = require('./orbitcard-diagnostics')({ store, audit: entry => logs.push(entry) });
    app.post('/api/admin/orbitcard/diagnostics/preflight', requireSecondaryAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await service.preflight(req.body || {})); }
        catch (_) { res.status(503).json({ success: false, message: '预检暂不可用，请核对步骤及日志存储状态；未创建支付订单' }); }
    });
    app.get('/api/admin/orbitcard/diagnostics/logs/:jobKey', requireSecondaryAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json({ success: true, ...await logs.readTask(req.params.jobKey, req.query?.cursor || '0') }); }
        catch (_) { res.status(400).json({ success: false, message: '日志标识或读取位置无效，或日志文件暂不可读' }); }
    });
};
