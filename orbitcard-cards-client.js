'use strict';
const { CardPreparationError, CardDataError } = require('./orbitcard-card-policy');

// API shapes and funding strategy adapted from jiangdengke/KC-PAY-GPT
// orbitcard-client.js (MIT, Copyright (c) 2026 KC). No sensitive card details needed.
const api = require('./orbitcard-client');
const { planFor } = require('./orbitcard-card-policy');

function positiveId(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function requestFailure(result, fallback) {
    if (result.status === 429) return new CardPreparationError(`Orbitcard 请求频率受限，请稍后重试（约 ${Math.ceil((result.retryAfterMs || 5000) / 1000)} 秒）`);
    if ([401, 403].includes(result.status)) return new CardPreparationError('Orbitcard 密钥、出口 IP 或接口权限不足，请联系管理员检查配置');
    return new CardPreparationError(fallback);
}
function normalizeCard(row = {}) {
    const source = row.card && typeof row.card === 'object' ? { ...row, ...row.card } : row;
    const values = [source.available_amount, source.availableAmount, source.available_balance, source.availableBalance,
        source.card_balance, source.cardBalance, source.current_balance, source.currentBalance, source.balance,
        source.remaining_balance, source.remainingBalance, source.balance_info?.available_balance,
        source.balance_info?.balance, source.funds?.available_balance, source.funds?.balance];
    const rawBalance = values.find(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
    const last4 = String(source.last4 || source.card_last4 || source.cardLast4 || source.card_number || source.cardNumber || '').slice(-4);
    return { card_id: positiveId(source.card_id ?? source.cardId ?? source.id),
        provider_status: String(source.status || source.card_status || '').trim().toUpperCase(),
        product_code: String(source.product_code || source.productCode || '').trim().slice(0, 128),
        bin: String(source.bin || source.card_bin || source.cardBin || '').replace(/\D/g, '').slice(0, 8),
        last4: /^\d{4}$/.test(last4) ? last4 : '',
        balance: rawBalance === undefined ? null : Number(rawBalance), balance_amount: rawBalance === undefined ? null : String(rawBalance),
        currency: String(source.currency || source.balance_currency || source.balanceCurrency || source.balance_info?.currency || '').trim().toUpperCase().slice(0, 8) };
}

async function listCards(cfg) {
    const cards = new Map();
    const pageSize = 100;
    for (let page = 1; page <= 100; page++) {
        const result = await api.request(cfg, 'getCardList', { page, page_size: pageSize });
        if (!result.success) throw requestFailure(result, '卡片列表读取失败，已停止选卡');
        const data = result.data;
        const rows = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : Array.isArray(data?.cards) ? data.cards : null;
        if (!rows) throw new CardPreparationError('卡片列表响应格式无效，已停止选卡');
        const previous = cards.size;
        for (const row of rows) {
            const card = normalizeCard(row);
            if (!card.card_id) throw new CardPreparationError('卡片列表包含无效卡 ID');
            cards.set(card.card_id, card);
        }
        const total = data?.total == null ? null : Number(data.total);
        if (!rows.length) {
            if (Number.isFinite(total) && cards.size < total) throw new CardPreparationError('卡片列表缺页，已停止选卡');
            return [...cards.values()];
        }
        if (Number.isFinite(total) ? cards.size >= total : rows.length < pageSize) return [...cards.values()];
        if (cards.size === previous) throw new CardPreparationError('卡片分页没有进展，已停止选卡');
    }
    throw new CardPreparationError('卡片分页超过上限，已停止选卡');
}

async function cardDetail(cfg, cardId) {
    const id = positiveId(cardId);
    if (!id) throw new CardPreparationError('无效的平台卡 ID');
    const result = await api.request(cfg, 'cardDetail', { card_id: id, reveal_sensitive: false });
    if (!result.success) throw requestFailure(result, '卡片详情读取失败，已停止选卡');
    const card = normalizeCard(result.data || {});
    if (card.card_id && card.card_id !== id) throw new CardDataError('卡片详情归属不一致');
    if (!card.provider_status) throw new CardDataError('卡片详情缺少状态');
    return { ...card, card_id: id };
}

async function cardDetails(cfg, cardIds, { allowPartial = false } = {}) {
    if (!Array.isArray(cardIds) || cardIds.length<1 || cardIds.length>20
        || cardIds.some(id => positiveId(id)!==Number(id)) || new Set(cardIds.map(Number)).size!==cardIds.length) {
        throw new CardPreparationError('批量卡片详情 ID 无效');
    }
    if(cardIds.length===1) return [await cardDetail(cfg,cardIds[0])];
    const result=await api.request(cfg,'cardDetail',{card_ids:cardIds.map(Number),reveal_sensitive:false});
    if(!result.success) throw requestFailure(result, '批量卡片详情读取失败，已停止选卡');
    const rows=Array.isArray(result.data)?result.data:Array.isArray(result.data?.list)?result.data.list:
        Array.isArray(result.data?.cards)?result.data.cards:null;
    if(!rows || rows.length>cardIds.length || (!allowPartial && rows.length!==cardIds.length))
        throw new CardDataError('批量卡片详情缺项或数量异常，已停止选卡');
    const expected=new Set(cardIds.map(Number)),seen=new Set(),cards=[];
    for(const row of rows) {
        const card=normalizeCard(row);
        if(!card.card_id || !expected.has(card.card_id) || seen.has(card.card_id) || !card.provider_status) {
            throw new CardDataError('批量卡片详情归属或状态无效，已停止选卡');
        }
        seen.add(card.card_id);cards.push(card);
    }
    return cards;
}

async function cardDetailsInBatches(cfg,cardIds,options) {
    const cards=[];
    for(let offset=0;offset<cardIds.length;offset+=20) cards.push(...await cardDetails(cfg,cardIds.slice(offset,offset+20),options));
    return cards;
}

const priceAliases = {
    plus: ['plus', 'gptplus', 'chatgptplus', 'chatgptplusplan'],
    pro100: ['pro100', 'gptpro5x', 'chatgptpro100', 'pro5x', 'prolite', 'pro'],
    pro200: ['pro200', 'gptpro20x', 'chatgptpro200', 'pro20x'],
    pro500: ['pro500', 'gptpro25x', 'chatgptpro500', 'pro25x']
};
function pricePlan(value) {
    const token = String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
    return Object.keys(priceAliases).find(key => priceAliases[key].includes(token));
}
function productAmount(value) {
    if ((typeof value==='string' && /^\d+(?:\.\d{1,8})?$/.test(value)) || (typeof value==='number' && Number.isFinite(value) && value>=0)) return Number(value);
    return null;
}
function normalizeProducts(data) {
    const products = new Map();
    function visit(value, depth = 0) {
        if (depth > 8 || value == null || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(item => visit(item, depth + 1));
        const code = String(value.product_code || value.productCode || '').trim();
        if (code) {
            const previous = products.get(code) || {};
            products.set(code, { ...previous, ...Object.fromEntries(Object.entries(value).filter(([, field]) => field != null && field !== '' && (!Array.isArray(field) || field.length))),
                product_code: code });
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            if (['channels','providers','list','products','items','data','1','2','3','channel1','channel2','channel3','vmcardio','fizzbolt','amzkeys'].includes(key)) visit(child, depth + 1);
        }
    }
    visit(data);
    return [...products.values()].map(row => ({ product_code: row.product_code,
        bin: String(row.bin || '').replace(/\D/g, '').slice(0, 8),
        ...Object.fromEntries(['card_type','network','media','issuing_area'].map(key => [key,String(row[key] || '').slice(0,64)])),
        min_initial_amount: productAmount(row.min_initial_amount),
        min_retained_balance: productAmount(row.min_retained_balance),
        remaining: productAmount(row.remaining_open_card_num),
        inventory_mode: String(row.open_card_inventory_mode || ''),
        prices: (Array.isArray(row.gpt_plan_prices) ? row.gpt_plan_prices : []).map(price => ({
            plan_type: pricePlan(price.name) || pricePlan(price.id), price: Number(price.price),
            currency: String(price.currency || 'USD').toUpperCase()
        })).filter(price => price.plan_type && Number.isFinite(price.price) && price.price > 0 && price.currency === 'USD')
    }));
}

async function products(cfg) {
    const result = await api.request(cfg, 'getProductCode');
    if (!result.success) throw requestFailure(result, '开卡产品目录读取失败');
    const rows = normalizeProducts(result.data);
    if (!rows.length) throw new CardPreparationError('产品目录为空或格式无效');
    return rows;
}

function planPrice(product, planType, cfg = {}) {
    const plan = planFor(planType);
    const fromProduct = product?.prices.find(price => price.plan_type === plan)?.price;
    if (fromProduct) return fromProduct;
    const configured = Number(cfg[`orbitcard_price_${plan}`]);
    return Number.isFinite(configured) && configured > 0 ? configured : null;
}
function selection(product, planType, cfg = {}) {
    const plan = planFor(planType), price = planPrice(product, plan, cfg);
    if (!price) return null;
    const opening=openingSelection(product);
    return opening ? { ...opening, plan_type:plan, price } : null;
}
function openingSelection(product) {
    if (!product || typeof product.product_code!=='string' || !product.product_code.trim() || product.product_code.length>128 || /[\x00-\x1f]/.test(product.product_code)) return null;
    if (product.remaining == null && product.inventory_mode !== 'provider_validated') return null;
    if (product.remaining != null && !Number.isSafeInteger(product.remaining)) return null;
    if (product.remaining != null && product.remaining <= 0 && product.inventory_mode !== 'provider_validated') return null;
    if (!Number.isFinite(product.min_initial_amount) || product.min_initial_amount < 0 || product.min_initial_amount > 20
        || !Number.isFinite(product.min_retained_balance) || product.min_retained_balance < 0) return null;
    const amount = 20;
    return { product_code: product.product_code,
        amount: amount.toFixed(2), min_retained_balance: product.min_retained_balance };
}
function choose(rows, cfg, select) {
    const candidates = rows.filter(row => !cfg.orbitcard_product_code || row.product_code === cfg.orbitcard_product_code)
        .map(select).filter(Boolean).sort((a, b) => a.product_code.localeCompare(b.product_code));
    const selected = candidates[0];
    if (!selected) throw new CardPreparationError('没有符合条件的开卡产品，请检查库存、套餐预算及产品最低首充是否不高于 20 USD');
    if (cfg.orbitcard_max_initial_amount && Number(selected.amount) > Number(cfg.orbitcard_max_initial_amount)) throw new CardPreparationError('所需首充超过后台设置的单卡金额上限');
    return selected;
}
function chooseProduct(rows, planType, cfg = {}) {
    return choose(rows,cfg,row => selection(row,planType,cfg));
}
function chooseOpeningProduct(rows,cfg = {}) {
    return choose(rows,cfg,openingSelection);
}
function createCardBody(selected) {
    if (!selected || typeof selected.product_code!=='string' || !selected.product_code.trim() || selected.product_code.length>128
        || /[\x00-\x1f]/.test(selected.product_code) || selected.amount!=='20.00') throw new CardPreparationError('开卡参数无效：需要实时产品码和固定 20.00 USD 首充');
    // Open API rejects unknown fields. Plan, region, BIN and card details are not createCard parameters.
    return {product_code:selected.product_code,amount:'20.00',quantity:1};
}

function issueResult(data) {
    const source = data && typeof data === 'object' ? data : {};
    const fees = {};
    for (const key of ['initial_amount','open_card_fee','recharge_fee','total_fee_amount','total_debit_amount']) {
        if (typeof source[key] === 'string' && /^\d+(?:\.\d+)?$/.test(source[key]) && source[key].length <= 64) fees[key] = source[key];
    }
    return { card_id: typeof source.card_id === 'number' ? positiveId(source.card_id) : null,
        order_no: typeof source.order_no === 'string' ? source.order_no.slice(0, 128) : '',
        status: typeof source.status === 'string' ? source.status.slice(0, 32) : '',
        completed: typeof source.completed === 'boolean' ? source.completed : source.completed == null ? undefined : false,
        product_code: typeof source.product_code === 'string' ? source.product_code : '', fees,
        retryAfterMs: Number.isFinite(Number(source.retry_after_seconds)) ? Math.max(0, Number(source.retry_after_seconds) * 1000) : 0 };
}

module.exports = { normalizeCard, positiveId, listCards, cardDetail, cardDetails, cardDetailsInBatches, normalizeProducts, products, planPrice, selection, chooseProduct,
    openingSelection, chooseOpeningProduct, createCardBody, issueResult };
