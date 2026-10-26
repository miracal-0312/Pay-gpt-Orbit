'use strict';
const { CardPreparationError, AccountBalanceError, CardDataError, CardSwitchExhaustedError } = require('./orbitcard-card-policy');

const crypto = require('node:crypto');
const api = require('./orbitcard-client');
const cardsApi = require('./orbitcard-cards-client');
const { planFor, cardScope, LIMITS } = require('./orbitcard-card-policy');
const money = require('./orbitcard-money');
const { decideCards } = require('./orbitcard-payment-decision');
const { PaymentStoppedError } = require('./payment-automation');

module.exports = function createCardService({ store, audit, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxIssuePolls = 3, now = Date.now }) {
    function record(jobKey, event, text, data) { audit({ jobKey: jobKey || '', source: 'orbitcard', event, text, data }); }
    const credentialHash = cfg => crypto.createHash('sha256').update(String(cfg.api_key || '').trim()).digest('hex');
    async function assertPaymentAllowed(cfg, jobKey) {
        await cfg.executionGuard?.assertOwned();
        await store.assertPaymentAllowed(jobKey);
    }
    async function withRecoveryOwner(cfg, entry, action) {
        const owner = await store.paymentOwner(entry.job_key);
        if (!owner.allowed) return false;
        if (!owner.keys.length) { await action(cfg); return true; }
        const guard = await store.acquirePaymentLock(owner.keys);
        if (!guard) return false;
        try {
            const ownedCfg = { ...cfg, executionGuard: guard };
            await assertPaymentAllowed(ownedCfg, entry.job_key);
            await action(ownedCfg);
            return true;
        } catch (error) {
            if (error instanceof PaymentStoppedError) return false;
            throw error;
        } finally { await guard.release(); }
    }
    const fundingService = require('./orbitcard-funding-service')({api,cardsApi,audit,now,sleep,maxPolls:maxIssuePolls,
        assertPaymentAllowed, withRecoveryOwner});
    async function account(cfg) {
        const result=await api.request(cfg,'getAccountBalance');
        if(!result.success) throw new CardPreparationError(result.error || '账户可用余额查询失败，已停止选卡、开卡和补款');
        const available=money.units(result.data?.available_balance);
        record(cfg.auditJobKey,'account_balance_checked','已读取账户可用余额',{available_balance:money.decimal(available)});
        return available;
    }
    async function requireFunds(locked, jobKey, available, required, planBudget=required) {
        if(available>=required) return;
        const message=`账户可用余额不足，充值已停止；请联系管理员手动充值账户${jobKey?.startsWith('manual-')?'，管理员订单已暂停':jobKey?'，CDK 已锁定':''}`;
        const threshold=required>planBudget?required:planBudget;
        await locked.blockBalance(jobKey,money.decimal(threshold),message);
        record(jobKey,'account_balance_blocked',message,{available_balance:money.decimal(available),required_balance:money.decimal(threshold)});
        throw new AccountBalanceError(message);
    }
    function budgetFor(products,plan) {
        const prices=products.map(product => cardsApi.planPrice(product,plan)).filter(Boolean).map(money.units);
        if(!prices.length) throw new CardPreparationError('平台产品目录未返回当前套餐的 USD 推荐价，已停止充值；请联系管理员核对产品接口');
        return prices.reduce((lowest,value) => value < lowest ? value : lowest);
    }

    async function confirmIssue(cfg, locked, issue, polls = maxIssuePolls) {
        await assertPaymentAllowed(cfg, issue.job_key);
        if (issue.credential_hash !== credentialHash(cfg)) throw new CardPreparationError('原开卡申请的 API Key 与当前配置不同，请恢复原凭据后确认，禁止换身份重开');
        if (Number(issue.retry_at || 0) > now()) throw new CardPreparationError('原开卡申请处于重查间隔内，请稍后确认原申请');
        let body;
        try { body = JSON.parse(issue.request_body); } catch (_) { throw new CardPreparationError('原开卡请求正文缺失，请人工核对'); }
        if (!body || Object.keys(body).length !== 3 || JSON.stringify(body) !== issue.request_body || body.product_code !== issue.product_code || body.amount !== Number(issue.amount).toFixed(2) || body.quantity !== 1) {
            throw new CardPreparationError('原开卡参数不一致，请恢复原请求，禁止更换参数重开');
        }
        // Only this original, durably stored body and key may confirm the application.
        await locked.updateIssue(issue.issue_key, { state: 'submitting', message: '正在确认原开卡请求' });
        const deadline = now() + 120000;
        for (let attempt = 0; attempt < polls && now() < deadline; attempt++) {
            await assertPaymentAllowed(cfg, issue.job_key);
            const result = await api.request({ ...cfg, auditJobKey: issue.job_key || cfg.auditJobKey || '' }, 'createCard', body, issue.issue_key);
            const detail = cardsApi.issueResult(result.data);
            if ((issue.order_no && detail.order_no && issue.order_no !== detail.order_no)
                || (issue.card_id && detail.card_id && Number(issue.card_id) !== detail.card_id)
                || (detail.product_code && detail.product_code !== issue.product_code)
                || (detail.fees.initial_amount && Number(detail.fees.initial_amount) !== Number(issue.amount))) {
                await locked.updateIssue(issue.issue_key, { state: 'unknown', message: '原开卡订单或参数归属不一致，停止自动履约', retry_at: now() + 60000 });
                throw new CardPreparationError('原开卡订单归属不一致，请人工核对，禁止重新申请');
            }
            const validEnvelope = result.success && result.status === 200 && Boolean(detail.order_no);
            const delay = Math.max(Math.min(5000 * 2 ** attempt, 60000), result.retryAfterMs || 0, detail.retryAfterMs || 0);
            const update = { state: validEnvelope ? 'pending' : 'unknown', order_no: detail.order_no, card_id: detail.card_id,
                provider_status: detail.status, completed: detail.completed, fee_snapshot: Object.keys(detail.fees).length ? JSON.stringify(detail.fees) : undefined, retry_at: now() + delay,
                message: '开卡结果待确认；保留固定申请身份，禁止换键重开' };
            await locked.updateIssue(issue.issue_key, update);
            issue.order_no = detail.order_no || issue.order_no;
            issue.card_id = detail.card_id || issue.card_id;
            issue.retry_at = update.retry_at;
            record(issue.job_key, 'card_issue_result', '收到原开卡请求结果', { issue_key: issue.issue_key,
                order_no: detail.order_no, card_id: detail.card_id, status: detail.status, completed: detail.completed, success: result.success, fees: detail.fees });
            if (validEnvelope && detail.status === 'success' && detail.card_id && detail.completed !== false) {
                const card = await cardsApi.cardDetail(cfg, detail.card_id);
                if (card.provider_status !== 'ACTIVE') throw new CardPreparationError('原开卡订单的卡片尚未激活，请继续确认原申请');
                if (card.product_code && card.product_code !== issue.product_code) throw new CardPreparationError('开卡产品归属不一致，请人工核对原申请');
                card.product_code ||= issue.product_code;
                await locked.syncCards([card]);
                await locked.completeIssue(issue, card);
                record(issue.job_key, 'card_issue_ready', '平台卡已激活并登记独立套餐额度', { issue_key: issue.issue_key, card_id: card.card_id, plan_type: issue.plan_type });
                return card;
            }
            if (validEnvelope && ['failed','refunded'].includes(detail.status) && detail.completed !== false) {
                await locked.updateIssue(issue.issue_key, { state: 'failed', order_no: detail.order_no, message: '平台明确返回开卡失败' });
                throw new CardPreparationError('Orbitcard 已确认开卡失败，请检查产品及余额');
            }
            if (!result.success || !['pending','pending_confirm','processing','created','validating','balance_locked'].includes(detail.status)) break;
            if (attempt + 1 < polls && now() + delay < deadline) await sleep(delay); else break;
        }
        throw new CardPreparationError('原开卡申请仍待确认，尚未提交会员充值；请稍后重试或在后台确认原申请');
    }

    async function issueFor(cfg, locked, planType, jobKey = null, products = null) {
        await assertPaymentAllowed(cfg, jobKey);
        const plan = planFor(planType);
        let issue = await locked.pendingIssue(plan);
        if (issue && (issue.job_key || null) !== (jobKey || null)) {
            throw new CardPreparationError('同套餐另一笔开卡申请尚待确认，请先核对原申请，不能将其卡片分配给当前订单');
        }
        if (!issue) {
            // Refresh before a new issue; an unresolved issue retains its original body and key.
            products = await cardsApi.products(cfg);
            const selected = jobKey ? cardsApi.chooseProduct(products,plan,cfg) : cardsApi.chooseOpeningProduct(products,cfg);
            const body = cardsApi.createCardBody(selected);
            const budget = jobKey ? money.units(selected.price) : money.units('20');
            await requireFunds(locked,jobKey,await account(cfg),budget>money.units('20')?budget:money.units('20'),budget);
            await assertPaymentAllowed(cfg, jobKey);
            issue = await locked.createIssue({ issue_key: `card-${crypto.randomUUID()}`, job_key: jobKey, ...selected,
                plan_type:plan,
                credential_hash: credentialHash(cfg), request_body: JSON.stringify(body) });
            record(jobKey, 'card_issue_prepared', jobKey?'无符合次数条件的支付卡，已保存自动开卡申请':'已保存管理员开卡申请', {
                issue_key: issue.issue_key, plan_type: plan, product_code: issue.product_code, amount: issue.amount, currency: 'USD',parameters:body });
        }
        if (jobKey) await locked.attachIssue(jobKey, issue.issue_key);
        return {card:await confirmIssue(cfg, locked, issue),products};
    }

    async function reusable(cfg, locked, jobKey, planType, liveCards, products, planBudget, initialAvailable, selection = {}) {
        const plan = planFor(planType), live = new Map(liveCards.map(card => [Number(card.card_id),card]));
        const saved = await locked.listCards();
        const excluded = new Set((selection.excludedCardIds || []).map(Number));
        const owned=saved.filter(row=>row.active_job===jobKey);
        if(owned.length>1 || owned.some(row=>excluded.has(Number(row.card_id)) || !live.has(Number(row.card_id))
            || !row.history_confirmed || Number(row[`successful_${plan}`])>=LIMITS[plan])) {
            throw new CardPreparationError('原订单已预占卡片但平台列表或次数不一致，禁止换卡或重复开卡');
        }
        const relevant=saved.filter(row => live.has(Number(row.card_id)) && !excluded.has(Number(row.card_id))
            && row.history_confirmed && Number(row[`successful_${plan}`]) < LIMITS[plan]
            && (!row.active_job || row.active_job===jobKey));
        const details=new Map();
        try {
            for(const card of await cardsApi.cardDetailsInBatches(cfg,relevant.map(row=>Number(row.card_id)),{allowPartial:true}))
                details.set(card.card_id,card);
        } catch(error) {
            if(!(error instanceof CardDataError)) throw error;
            throw new CardSwitchExhaustedError('平台批量卡片详情不完整，无法确认可用支付卡；CDK 已锁定，请联系人工售后');
        }
        if(relevant.length && details.size===0) {
            throw new CardSwitchExhaustedError('平台卡片列表非空但批量详情全部缺失，无法确认可用支付卡；请联系人工售后');
        }
        const decision = decideCards({ saved, listed: liveCards, detailed: [...details.values()], products,
            jobKey, planType, excludedCardIds: selection.excludedCardIds, priceFor: cardsApi.planPrice });
        for (const skipped of decision.skipped) record(jobKey, 'card_unavailable', '卡片已从本次支付选择中排除', skipped);
        for (const card of details.values()) await locked.syncCards([card]);
        record(jobKey, 'card_payment_decision', '支付卡准备决策', {
            action: decision.action, candidates: decision.candidates.length, waiting: decision.waiting, skipped: decision.skipped.length });
        let busy = false;
        const candidates = decision.candidates;
        for (const candidate of candidates) {
            const {row,card,price,target,deficit}=candidate;
            if (initialAvailable !== null) await requireFunds(locked,jobKey,initialAvailable,price,planBudget);
            const reserved = await locked.reserveCard(card.card_id, jobKey, planType);
            if (!reserved) {
                if(row.active_job===jobKey) throw new CardPreparationError('原订单预占卡片状态已变更，禁止换卡或重复开卡');
                busy=true;continue;
            }
            record(jobKey, 'card_reserved', '已预占符合当前套餐次数要求的支付卡', {
                card_id: card.card_id, plan_type: plan, successful_uses: Number(row[`successful_${plan}`]), limit: LIMITS[plan] });
            record(jobKey,'card_funds_before_subscription','订阅提交前支付卡资金快照',{
                card_id:card.card_id,balance:card.balance_amount,required_balance:money.decimal(target),currency:card.currency});
            if(deficit>0n) {
                const amount=money.units(money.cents(deficit));
                await requireFunds(locked,jobKey,await account(cfg),amount,planBudget);
                return fundingService.ensure(cfg,locked,jobKey,plan,card,target);
            }
            return card;
        }
        if(owned.length) throw new CardPreparationError('原订单预占卡片暂不可支付，禁止换卡或重复开卡');
        if (busy || decision.action === 'wait') {
            const unconfirmed = decision.waiting.some(card => card.reason === 'history_unconfirmed');
            throw new CardPreparationError(unconfirmed ? '旧卡历史次数尚未确认，请在后台登记后继续；本次未开新卡'
                : '支付卡正被其他订单占用，请等待原订单完成后重试；本次未开新卡');
        }
        return null;
    }

    async function allocate(cfg, jobKey, planType, selection = {}) {
        return store.withCardAllocationLock(cfg.base_url, async cardMethods => {
            await assertPaymentAllowed(cfg, jobKey);
            const locked = selection.manualRequestId ? {
                ...cardMethods,
                reserveCard: (cardId, key, plan) => store.reserveManualCard(selection.manualRequestId, cardId, key, plan),
                attachIssue: (key, issueKey) => store.attachManualIssue(selection.manualRequestId, key, issueKey),
                blockBalance: (key, required, message) => store.blockManualBalance(selection.manualRequestId, key, required, message)
            } : cardMethods;
            const available=await account(cfg);
            const originalFunding=await locked.fundingForJob(jobKey);
            if(originalFunding) {
                if(originalFunding.scope!==cardScope(cfg.base_url)
                    || originalFunding.credential_hash!==credentialHash(cfg)
                    || originalFunding.plan_type!==planFor(planType)) {
                    throw new CardPreparationError('原补款的平台、密钥或套餐与当前订单不一致，禁止继续支付');
                }
                if (originalFunding.state === 'failed') throw new CardPreparationError('原补款已失败，请确认原订单后重新发起兑换');
                const card = originalFunding.state==='ready'
                    ? await cardsApi.cardDetail(cfg,originalFunding.card_id)
                    : await fundingService.confirm(cfg,locked,originalFunding);
                const reservation = (await locked.listCards()).find(row => Number(row.card_id)===Number(originalFunding.card_id));
                if(!reservation || reservation.active_job!==jobKey) {
                    throw new CardPreparationError('原补款卡片占用归属已变更，禁止继续提交订阅');
                }
                const products=await cardsApi.products(cfg);
                const product=products.find(item=>item.product_code===(card.product_code || reservation.product_code));
                const price=cardsApi.planPrice(product,planType);
                if(!price || !Number.isFinite(product?.min_retained_balance) || product.min_retained_balance<0) {
                    throw new CardPreparationError('原补款卡片的实时套餐价格或最低留存余额缺失，禁止继续支付');
                }
                const required=money.units(price)+money.units(product.min_retained_balance);
                if(card.provider_status!=='ACTIVE' || card.currency!=='USD' || card.balance_amount===null
                    || money.units(card.balance_amount)<money.units(originalFunding.target_balance)
                    || money.units(card.balance_amount)<required) {
                    throw new CardPreparationError('原补款卡片尚未满足支付金额，请继续核对原补款，禁止换卡重复充值');
                }
                return card.card_id;
            }
            const originalIssue = await locked.issueForJob(jobKey);
            if (originalIssue) {
                if (originalIssue.plan_type !== planFor(planType) || originalIssue.credential_hash !== credentialHash(cfg)) {
                    throw new CardPreparationError('原开卡申请的套餐或密钥不一致，请核对原订单');
                }
                if (originalIssue.state === 'failed') throw new CardPreparationError('原开卡已失败，请确认原订单后重新发起兑换');
                // Finish this job's original issue before looking at unrelated cards.
                const opened = originalIssue.state === 'ready'
                    ? await cardsApi.cardDetail(cfg, originalIssue.card_id) : await confirmIssue(cfg, locked, originalIssue);
                const products = await cardsApi.products(cfg), budget = budgetFor(products, planType);
                const selected = await reusable(cfg, locked, jobKey, planType, [opened], products, budget, null, selection);
                if (!selected || selected.card_id !== Number(originalIssue.card_id)) {
                    throw new CardPreparationError('原开卡申请的卡片暂不可支付，请核对原卡；禁止重新开卡');
                }
                return selected.card_id;
            }
            const products = await cardsApi.products(cfg),planBudget=budgetFor(products,planType);
            await requireFunds(locked,jobKey,available,planBudget);
            const listed = await cardsApi.listCards(cfg);
            await locked.syncCards(listed);
            const selected = await reusable(cfg, locked, jobKey, planType, listed, products,planBudget,available,selection);
            if (selected) return selected.card_id;
            const {card:opened,products:latestProducts} = await issueFor(cfg, locked, planType, jobKey, products);
            const newBudget = budgetFor(latestProducts,planType);
            const newSelection = await reusable(cfg,locked,jobKey,planType,[opened],latestProducts,newBudget,available,selection);
            if (!newSelection) throw new CardSwitchExhaustedError('新卡已开立但当前套餐仍无可用支付卡；CDK 已锁定，请联系人工售后');
            return newSelection.card_id;
        });
    }

    async function synchronize(cfg) {
        return store.withCardAllocationLock(cfg.base_url, async locked => {
            try {
                const listed = await cardsApi.listCards(cfg);
                const detailed = await cardsApi.cardDetailsInBatches(cfg,listed.map(card=>card.card_id),{allowPartial:true});
                const live = new Map(listed.map(card => [card.card_id, card]));
                // List metadata can fill identification fields, never the detail balance/status.
                for (const card of detailed) {
                    card.product_code ||= live.get(card.card_id)?.product_code || '';
                    card.bin ||= live.get(card.card_id)?.bin || '';
                    card.last4 ||= live.get(card.card_id)?.last4 || '';
                }
                await locked.syncCards(detailed);
                const confirmed = new Set(detailed.map(card => card.card_id));
                const result = { count: detailed.length, listed_ids: listed.map(card => card.card_id),
                    synced_ids: [...confirmed], failed_ids: listed.filter(card => !confirmed.has(card.card_id)).map(card => card.card_id),
                    checked_at: new Date(now()).toISOString() };
                record('', 'cards_synchronized', '已同步可读取的平台卡片摘要；缺失详情保留本地快照并标记未同步', result);
                return result;
            } catch (error) {
                record('', 'cards_sync_failed', '平台卡片同步失败，本地快照未确认，请勿视为实时余额', {
                    reason: error instanceof CardPreparationError ? error.message : 'local_sync_error' });
                throw error;
            }
        });
    }
    async function apply(cfg, planType) {
        if (!cfg.enabled) throw new CardPreparationError('请先开启 Orbitcard 接单配置');
        return store.withCardAllocationLock(cfg.base_url, async locked => {
            // Applying for a card alone needs no membership price; those budgets belong to redemption.
            await requireFunds(locked,null,await account(cfg),money.units('20'));
            return (await issueFor(cfg,locked,planType)).card;
        });
    }
    let recovering = false;
    async function recover(cfg) {
        if (recovering) return;
        recovering = true;
        try {
            await store.withCardAllocationLock(cfg.base_url, async locked => {
                await fundingService.recover(cfg,locked);
                const candidates=[];
                for (const plan of Object.keys(LIMITS)) {
                    const issue = await locked.pendingIssue(plan);
                    if(issue && Number(issue.retry_at || 0)<=now()) candidates.push(issue);
                }
                candidates.sort((a,b) => new Date(a.updated_at || a.created_at || 0)-new Date(b.updated_at || b.created_at || 0));
                for(const issue of candidates) {
                    const handled = await withRecoveryOwner(cfg, issue, async ownedCfg => {
                        // Prepared means the remote-write marker was never committed.
                        if (issue.state === 'prepared') {
                            await locked.updateIssue(issue.issue_key, { state: 'failed', message: '服务在开卡提交前中断，未发送该申请' });
                            return;
                        }
                        try { await confirmIssue(ownedCfg, locked, issue, 1); }
                        catch (error) {
                            if (error instanceof PaymentStoppedError) throw error;
                            await locked.updateIssue(issue.issue_key,{state:'unknown',retry_at:Math.max(Number(issue.retry_at || 0),now()+60000),message:'原开卡申请尚待确认或人工核对，保留原身份'});
                            record(issue.job_key, 'card_issue_pending', '原开卡申请尚待确认，保留原幂等身份', { issue_key: issue.issue_key });
                        }
                    });
                    if (handled) break;
                }
            });
        } finally { recovering = false; }
    }
    let balanceCache=null;
    async function transactions(cfg,cardId,page=1) {
        const id=cardsApi.positiveId(cardId),number=Number(page);
        if(!id || !Number.isSafeInteger(number) || number<1 || number>10000) throw new CardPreparationError('交易查询参数无效');
        const card=await cardsApi.cardDetail(cfg,id);
        return {card_id:id,card_status:card.provider_status,card_balance:card.balance_amount,currency:card.currency,
            ...await transactionRows(cfg,id,number)};
    }
    async function transactionRows(cfg,id,number) {
        const result=await api.request(cfg,'cardTransaction',{card_id:id,page:number,page_size:50});
        if(!result.success) throw new CardPreparationError(result.error || '平台消费交易读取失败，请检查交易读取权限');
        if(!Array.isArray(result.data?.list)) throw new CardPreparationError('平台消费交易响应格式无效');
        const list=[];
        for(const row of result.data.list) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new CardPreparationError('消费交易记录格式无效');
            if(row.card_id!=null && Number(row.card_id)!==id) throw new CardPreparationError('消费交易卡片归属不一致');
            const safe={};
            for(const key of ['transaction_id','id','card_id','transaction_type','type','status','merchant','mcc','amount',
                'authorization_amount','settlement_amount','currency','authorized_at','settled_at','created_at']) {
                if(['string','number'].includes(typeof row[key])) safe[key]=typeof row[key]==='string'?row[key].slice(0,128):row[key];
            }
            list.push(safe);
        }
        const total=result.data.total==null?null:Number(result.data.total);
        if(total!=null && (!Number.isSafeInteger(total) || total<list.length)) throw new CardPreparationError('消费交易分页总数无效');
        return {page:number,total,transactions:list};
    }
    async function reconcile(cfg,cardId,jobKey) {
        cardId=cardsApi.positiveId(cardId);
        if(!cardId) throw new CardPreparationError('交易查询参数无效');
        const identity={...cfg,auditJobKey:jobKey};
        const [card,balance,flows]=await Promise.allSettled([
            cardsApi.cardDetail(identity,cardId),account(identity),transactionRows(identity,cardId,1)]);
        const snapshot={card_id:cardId,card_status:card.status==='fulfilled'?card.value.provider_status:null,
            card_balance:card.status==='fulfilled'?card.value.balance_amount:null,
            account_available:balance.status==='fulfilled'?money.decimal(balance.value):null,
            observed_transactions:flows.status==='fulfilled'?flows.value.transactions.length:null,
            transaction_query_ok:flows.status==='fulfilled'};
        record(jobKey,'payment_funds_snapshot','订阅结果后只读核对账户、卡片和消费交易摘要',snapshot);
        return snapshot;
    }
    async function canResumeBalance(cfg,task) {
        if(String(cfg.base_url || '').replace(/\/+$/,'')!==String(task.orbitcard_base_url || '').replace(/\/+$/,'')) throw new CardPreparationError('余额锁定任务的平台地址与原配置不同');
        if(task.orbitcard_api_key_hash && task.orbitcard_api_key_hash!==credentialHash(cfg)) throw new CardPreparationError('余额锁定任务的 API Key 与原配置不同，请恢复原凭据后核对');
        const identity=`${cfg.base_url}:${credentialHash(cfg)}`;
        if(!balanceCache || balanceCache.identity!==identity || balanceCache.until<=now()) balanceCache={identity,until:now()+5000,pending:account(cfg)};
        let available;
        try { available=await balanceCache.pending; } catch(error) {balanceCache=null;throw error;}
        return available>=money.units(task.orbitcard_required_balance);
    }
    return { allocate, synchronize, apply, recover, canResumeBalance, transactions, reconcile };
};
