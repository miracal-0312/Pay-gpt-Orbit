'use strict';

const { ManualOrderError } = require('./orbitcard-manual-service');
const { queueFeedback } = require('./payment-waiting-queue');

module.exports = function registerManualRoutes(app, { service, requireSecondaryAuth }) {
    const route = handler => async (req, res) => {
        try { await handler(req, res); }
        catch (error) {
            const feedback = queueFeedback(error), known = error instanceof ManualOrderError || Boolean(feedback.error_code);
            if (feedback.retry_after_seconds) res.set?.('Retry-After', String(feedback.retry_after_seconds));
            res.status(known ? error.status || 429 : 503).json({
                success: false, message: known ? error.message : '管理员订单暂不可用，请查询原订单并检查运行日志', ...feedback
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
