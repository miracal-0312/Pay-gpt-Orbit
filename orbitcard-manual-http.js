'use strict';

const { ManualOrderError } = require('./orbitcard-manual-service');

module.exports = function registerManualRoutes(app, { service, requireSecondaryAuth }) {
    const route = handler => async (req, res) => {
        try { await handler(req, res); }
        catch (error) {
            res.status(error instanceof ManualOrderError ? error.status : 503).json({
                success: false, message: error instanceof ManualOrderError ? error.message : '管理员订单暂不可用，请查询原订单并检查运行日志'
            });
        }
    };
    app.get('/api/admin/manual/catalog', requireSecondaryAuth, route(async (req, res) => {
        res.json({ success: true, ...await service.catalog() });
    }));
    app.get('/api/admin/manual/orders', requireSecondaryAuth, route(async (req, res) => {
        res.json({ success: true, orders: await service.list() });
    }));
    app.get('/api/admin/manual/orders/:requestId', requireSecondaryAuth, route(async (req, res) => {
        const order = await service.get(req.params.requestId);
        if (!order) throw new ManualOrderError('管理员订单不存在', 404);
        res.json({ success: true, order });
    }));
    app.post('/api/admin/manual/orders', requireSecondaryAuth, route(async (req, res) => {
        const order = await service.create({ requestId: req.body?.request_id,
            planType: req.body?.plan_type,
            mode: req.body?.mode, cdkCode: req.body?.cdk_code,
            session: req.body?.session, authorized: req.body?.authorized,
            adminEmail: req.admin?.email || '' });
        res.status(202).json({ success: true, order });
    }));
    app.post('/api/admin/manual/orders/:requestId/refresh', requireSecondaryAuth, route(async (req, res) => {
        res.json({ success: true, order: await service.refresh(req.params.requestId) });
    }));
};
