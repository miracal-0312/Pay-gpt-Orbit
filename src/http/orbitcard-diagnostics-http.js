'use strict';
const { CardPreparationError } = require('../orbitcard/orbitcard-card-policy');

module.exports = function registerDiagnostics(app, { store, requireSecondaryAuth, logs }) {
    const service = require('../diagnostics/orbitcard-diagnostics')({ store, audit: entry => logs.push(entry) });
    const interfaces = require('../diagnostics/orbitcard-interface-diagnostics')({ store });
    // Mounted after administrator authentication. These routes only read the
    // platform or validate synthetic write requests locally, without any payment.
    const interfaceHandler = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await action(req)); }
        catch (error) { res.status(error instanceof CardPreparationError ? 400 : 503).json({ success: false,
            message: error instanceof CardPreparationError ? error.message : '接口测试暂不可用；未创建或修改支付订单' }); }
    };
    app.get('/api/admin/orbitcard/diagnostics/interfaces', interfaceHandler(() => interfaces.manifest()));
    app.post('/api/admin/orbitcard/diagnostics/interface-test', interfaceHandler(req => interfaces.run(req.body || {})));
    app.post('/api/admin/orbitcard/diagnostics/preflight', requireSecondaryAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await service.preflight(req.body || {})); }
        catch (error) { res.status(error instanceof CardPreparationError ? 400 : 503).json({ success: false,
            message: error instanceof CardPreparationError ? error.message : '预检暂不可用，请核对步骤及日志存储状态；未创建支付订单' }); }
    });
    app.get('/api/admin/orbitcard/diagnostics/logs/:jobKey', requireSecondaryAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json({ success: true, ...await logs.readTask(req.params.jobKey, req.query?.cursor || '0', req.query?.revision || '') }); }
        catch (_) { res.status(400).json({ success: false, message: '日志标识或读取位置无效，或日志文件暂不可读' }); }
    });
};
