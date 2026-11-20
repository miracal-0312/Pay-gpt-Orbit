'use strict';

const cardsApi = require('../orbitcard/orbitcard-cards-client');
const api = require('../orbitcard/orbitcard-client');
const { eligible, exhausted, MAX_SUCCESSFUL_ORDERS } = require('../orbitcard/orbitcard-pool');
const { CardPreparationError } = require('../orbitcard/orbitcard-card-policy');
const { PLAN_TYPES: CANONICAL_PLAN_TYPES, PROVIDER_PLANS } = require('../config/plan-registry');

// Mounted after administrator authentication; manual card issuance requires 2FA.
module.exports = function registerCardRoutes(app, { store, cardService, requireSecondaryAuth }) {
    const handler = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(400).json({ success: false, message: error instanceof CardPreparationError ? error.message : '卡片服务暂不可用，请检查配置并确认原申请' }); }
    };
    const config = () => store.getGptApiConfig();
    app.get('/api/admin/orbitcard/cards', handler(async (req, res) => {
        const cfg = await config(), methods = store.cardMethods(cfg.base_url);
        const cards = (await methods.listCards()).map(card => ({
            card_id: Number(card.card_id), active_job: card.active_job,
            authorization_count: card.authorization_count == null ? null : Number(card.authorization_count),
            successful_order_count: card.successful_order_count == null ? null : Number(card.successful_order_count),
            max_successful_orders: MAX_SUCCESSFUL_ORDERS, quota_exhausted: exhausted(card),
            remaining_successful_orders: card.successful_order_count == null ? null : Math.max(0, MAX_SUCCESSFUL_ORDERS - Number(card.successful_order_count)),
            availability_basis: 'card_errors', usable: eligible(card) && card.provider_status === 'ACTIVE',
            disabled_at: card.disabled_at, disabled_code: card.disabled_code,
            disabled_reason: card.disabled_reason, disabled_job_key: card.disabled_job_key, card_bin: card.card_bin,
            counting_basis: 'confirmed_subscription_orders', authorizations_checked_at: card.authorizations_checked_at,
            retiring: Boolean(card.retirement_key),
            provider_status: card.provider_status, product_code: card.product_code, last4: card.last4,
            balance: card.balance, currency: card.currency, source: card.source, updated_at: card.updated_at
        }));
        const issues = (await methods.listIssues()).map(issue => Object.fromEntries([
            'issue_key','job_key','replacement_for_card_id','replacement_for_job_key','plan_type','product_code','amount','state','order_no','card_id','message',
            'provider_status','completed','fee_snapshot','retry_at','created_at','updated_at'
        ].map(key => [key,issue[key]])));
        const fundings=(await methods.listFundings()).map(funding => Object.fromEntries([
            'funding_key','job_key','plan_type','card_id','amount','target_balance','state','order_no','provider_status',
            'fee_snapshot','retry_at','message','created_at','updated_at'
        ].map(key => [key,funding[key]])));
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, source: 'local_snapshot', cards, issues, fundings });
    }));
    app.get('/api/admin/orbitcard/products', handler(async (req, res) => {
        const products = await cardsApi.products(await config());
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, products, channels: products.map(product => ({
            code: product.product_code, bin: product.bin, network: product.network, issuing_area: product.issuing_area })),
            bins: [...new Set(products.map(product => product.bin).filter(Boolean))] });
    }));
    app.post('/api/admin/orbitcard/cards/:cardId/availability', requireSecondaryAuth, handler(async (req, res) => {
        const cardId = cardsApi.positiveId(req.params.cardId), disabled = req.body?.disabled;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (!cardId || typeof disabled !== 'boolean' || !reason || reason.length > 255) {
            throw new CardPreparationError('请选择有效卡片及停用状态，并填写 1–255 字的修改原因');
        }
        const cfg = await config();
        const safeReason = require('../logging/log-safety').sanitize(reason);
        const result = await store.withCardAllocationLock(cfg.base_url,
            locked => locked.setCardAvailability(cardId, disabled, safeReason));
        require('../logging/runtime-log').push({ source: 'admin', event: 'card_availability_changed',
            text: disabled ? '管理员人工停用卡片' : '管理员恢复卡片使用',
            data: { card_id: cardId, disabled, reason: safeReason, admin: req.admin?.email || '' } });
        res.json({ success: true, card: result, message: disabled ? '卡片已人工停用' : '已清除卡片停用标记，后续选卡将实时核对平台状态和余额' });
    }));
    app.get('/api/admin/orbitcard/cards/preview', handler(async (req, res) => {
        const cards = await cardsApi.listCards(await config());
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, total: cards.length,
            active: cards.filter(card => card.provider_status === 'ACTIVE').length,
            cards: cards.slice(0, 20).map(card => ({ card_id: card.card_id,
                status: card.provider_status, last4: card.last4 })) });
    }));
    app.post('/api/admin/orbitcard/cards/sync', handler(async (req, res) => {
        const result = await cardService.synchronize(await config());
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, ...result, message: `已同步 ${result.count} 张卡片详情；会员订单新增 ${result.order_sync?.added || 0} 笔${result.order_sync?.complete ? '' : `（${result.order_sync?.error || `有 ${result.order_sync?.unresolved?.length || 0} 笔会员订单结果或卡片归属待核对`}）`}${result.removed_ids?.length ? `，${result.removed_ids.length} 张卡片已注销或未在平台列表中返回` : ''}${result.failed_ids.length ? `，${result.failed_ids.length} 张详情读取失败，仅保留旧快照` : ''}` });
    }));
    app.get('/api/admin/orbitcard/payment-regions', handler(async (req, res) => {
        const cfg=await config(), regions={};
        const requested=String(req.query?.plan || '').trim();
        if(requested && !CANONICAL_PLAN_TYPES.includes(requested)) throw new CardPreparationError('请选择有效的套餐查询地区');
        for(const plan of requested ? [requested] : CANONICAL_PLAN_TYPES) {
            const started=Date.now();
            const result=await api.request(cfg,'getSubscriptionPaymentRegions',{plan_type:PROVIDER_PLANS[plan]});
            const data=result.data;
            const trace={operation:'getSubscriptionPaymentRegions',path:'/api/open/v1/getSubscriptionPaymentRegions',
                plan_type:PROVIDER_PLANS[plan],checked_at:new Date(started).toISOString(),elapsed_ms:Date.now()-started,
                success:result.success===true,http_status:result.status ?? null,platform_code:result.code ?? null};
            if(!result.success || (data?.plan_type && data.plan_type!==PROVIDER_PLANS[plan]) || !Array.isArray(data?.payment_regions)) {
                regions[plan]={options:[],error:result.error || '该套餐支付地区暂不可用',trace:{...trace,success:false}};
                continue;
            }
            const seen=new Set();
            regions[plan]={options:data.payment_regions.filter(item => {
                const code=String(item?.code || '').toUpperCase();
                if(!/^[A-Z]{2}$/.test(code) || seen.has(code)) return false;
                seen.add(code);return true;
            }).map(item => ({code:String(item.code).toUpperCase(),default:item.default===true})),trace};
        }
        res.json({success:true,regions});
    }));
    app.get('/api/admin/orbitcard/cards/:cardId/transactions', handler(async (req,res) => {
        res.json({success:true,data:await cardService.transactions(await config(),req.params.cardId,req.query?.page || 1)});
    }));
    app.post('/api/admin/orbitcard/cards/apply', requireSecondaryAuth, handler(async (req, res) => {
        if (req.body !== undefined && (!req.body || typeof req.body !== 'object'
            || Array.isArray(req.body) || Object.keys(req.body).length)) {
            throw new CardPreparationError('共享卡池开卡不接收套餐或自定义参数，请提交空请求');
        }
        const cfg = await config(), card = await cardService.apply(cfg);
        res.json({ success: true, card, message: '开卡成功，首充 20 USD；卡片按平台状态和订阅卡片错误判定可用性' });
    }));
    app.post('/api/admin/orbitcard/issues/refresh', handler(async (req, res) => {
        await cardService.recover(await config());
        res.json({ success: true, message: '已安排原开卡和补款确认，请查看对应记录；未确认请求继续保留原幂等键' });
    }));
};
