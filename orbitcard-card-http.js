'use strict';

const cardsApi = require('./orbitcard-cards-client');
const api = require('./orbitcard-client');
const { LIMITS, CardPreparationError } = require('./orbitcard-card-policy');
const { PLAN_TYPES: CANONICAL_PLAN_TYPES } = require('./plan-registry');

// Mounted after the administrator authentication middleware. Mutating monetary
// operations and the one-time declaration of imported usage also require 2FA.
module.exports = function registerCardRoutes(app, { store, cardService, requireSecondaryAuth, audit }) {
    const handler = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(400).json({ success: false, message: error instanceof CardPreparationError ? error.message : '卡片服务暂不可用，请检查配置并确认原申请' }); }
    };
    const config = () => store.getGptApiConfig();
    app.get('/api/admin/orbitcard/cards', handler(async (req, res) => {
        const cfg = await config(), methods = store.cardMethods(cfg.base_url);
        const cards = (await methods.listCards()).map(card => ({
            card_id: Number(card.card_id), history_confirmed: Boolean(card.history_confirmed), active_job: card.active_job,
            usage: Object.fromEntries(Object.entries(LIMITS).map(([plan,limit]) => [plan,{
                successful: Number(card[`successful_${plan}`]), limit, reserved: card.active_plan === plan ? 1 : 0,
                remaining: Math.max(0,limit-Number(card[`successful_${plan}`])-(card.active_plan === plan ? 1 : 0))
            }])),
            provider_status: card.provider_status, product_code: card.product_code, last4: card.last4,
            balance: card.balance, currency: card.currency, source: card.source, updated_at: card.updated_at
        }));
        const issues = (await methods.listIssues()).map(issue => Object.fromEntries([
            'issue_key','job_key','plan_type','product_code','amount','state','order_no','card_id','message',
            'provider_status','completed','fee_snapshot','retry_at','created_at','updated_at'
        ].map(key => [key,issue[key]])));
        const fundings=(await methods.listFundings()).map(funding => Object.fromEntries([
            'funding_key','job_key','plan_type','card_id','amount','target_balance','state','order_no','provider_status',
            'fee_snapshot','retry_at','message','created_at','updated_at'
        ].map(key => [key,funding[key]])));
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, source: 'local_snapshot', cards, issues, fundings });
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
        res.json({ success: true, ...result, message: `已同步 ${result.count} 张卡片详情${result.failed_ids.length ? `，${result.failed_ids.length} 张详情读取失败，仅保留旧快照` : ''}` });
    }));
    app.get('/api/admin/orbitcard/products', handler(async (req, res) => {
        const cfg = await config(), products = await cardsApi.products(cfg);
        const catalog = products.map(({ prices, ...product }) => ({ ...product, plans: Object.fromEntries(CANONICAL_PLAN_TYPES.map(plan => {
            const selected = cardsApi.selection({ ...product, prices }, plan, cfg);
            return [plan, selected ? { amount: selected.amount, available: true } : null];
        })) }));
        let application=null,applicationError=null;
        try {application=cardsApi.createCardBody(cardsApi.chooseOpeningProduct(products,cfg));}
        catch (error) {if(!(error instanceof CardPreparationError))throw error;applicationError=error.message;}
        res.json({ success: true, products: catalog, automatic_application:application, application_error:applicationError });
    }));
    app.get('/api/admin/orbitcard/payment-regions', handler(async (req, res) => {
        const cfg=await config(), regions={};
        const requested=String(req.query?.plan || '').trim();
        if(requested && !CANONICAL_PLAN_TYPES.includes(requested)) throw new CardPreparationError('请选择有效的套餐查询地区');
        for(const plan of requested ? [requested] : CANONICAL_PLAN_TYPES) {
            const started=Date.now();
            const result=await api.request(cfg,'getSubscriptionPaymentRegions',{plan_type:api.PLAN_MAP[plan]});
            const data=result.data;
            const trace={operation:'getSubscriptionPaymentRegions',path:'/api/open/v1/getSubscriptionPaymentRegions',
                plan_type:api.PLAN_MAP[plan],checked_at:new Date(started).toISOString(),elapsed_ms:Date.now()-started,
                success:result.success===true,http_status:result.status ?? null,platform_code:result.code ?? null};
            if(!result.success || (data?.plan_type && data.plan_type!==api.PLAN_MAP[plan]) || !Array.isArray(data?.payment_regions)) {
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
        const planType = req.body?.plan_type;
        if (!CANONICAL_PLAN_TYPES.includes(planType)) throw new CardPreparationError('请选择有效的充值套餐');
        const card = await cardService.apply(await config(), planType);
        res.json({ success: true, card, message: '开卡成功，首充 20 USD，已登记四项套餐额度' });
    }));
    app.post('/api/admin/orbitcard/cards/:cardId/bind', requireSecondaryAuth, handler(async (req, res) => {
        const id = cardsApi.positiveId(req.params.cardId), counts = req.body?.usage;
        if (!id || !counts || typeof counts !== 'object') throw new CardPreparationError('请填写有效卡 ID 和四种套餐的历史成功次数');
        const cfg = await config();
        await store.withCardAllocationLock(cfg.base_url, locked => locked.bindCard(id, counts));
        audit({ source: 'orbitcard', event: 'card_history_confirmed', text: '管理员确认卡片四种套餐历史次数', data: { card_id: id, usage: counts } });
        res.json({ success: true, message: '历史次数已确认；后续四种套餐独立计数，不能清零重置' });
    }));
    app.post('/api/admin/orbitcard/issues/refresh', handler(async (req, res) => {
        await cardService.recover(await config());
        res.json({ success: true, message: '已安排原开卡和补款确认，请查看对应记录；未确认请求继续保留原幂等键' });
    }));
};
