'use strict';
const crypto = require('node:crypto');
const money = require('./orbitcard-money');
const { CardPreparationError, FundingPendingError, FundingAwaitingError, FUNDING_POLL_MS, cardScope } = require('./orbitcard-card-policy');
const { PaymentStoppedError } = require('./payment-automation');

module.exports = function createFundingService({ api, cardsApi, audit, now, assertPaymentAllowed,
    assertReconciliationAllowed = assertPaymentAllowed, withRecoveryOwner }) {
    const keyHash = cfg => crypto.createHash('sha256').update(String(cfg.api_key || '').trim()).digest('hex');
    const record = (funding, event, text, data = {}) => audit({jobKey:funding.job_key,source:'orbitcard',event,text,
        data:{funding_key:funding.funding_key,card_id:funding.card_id,amount:funding.amount,...data}});
    const pendingStatuses = new Set(['created','validating','balance_locked','processing','pending_confirm','pending']);
    const transientResponse = result => result.status == null || result.status === 0 || result.status === 408
        || result.status === 429 || result.status >= 500;
    const transientReadError = error => !(error instanceof FundingPendingError) && !(error instanceof PaymentStoppedError)
        && (error.transient === true || error.status === 408 || error.status === 429 || error.status >= 500
            || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ECONNABORTED'].includes(error.code));
    async function readFundedCard(cfg, funding) {
        try { return await cardsApi.cardDetail(cfg,funding.card_id); }
        catch (error) {
            if (transientReadError(error)) throw new FundingAwaitingError('原补款已确认，卡片余额查询暂不可用，稍后继续核对',error.retryAfterMs);
            throw error;
        }
    }
    async function flow(cfg, funding) {
        let seen=0;
        for (let page=1;page<=100;page++) {
            const result = await api.request({...cfg,auditJobKey:funding.job_key},'getCardFlow',{
                card_id:Number(funding.card_id),type:'recharge',page,page_size:100
            });
            if (!result.success) return result;
            const data=result.data;
            if (!data || !Array.isArray(data.list) || (data.card_id != null && Number(data.card_id)!==Number(funding.card_id))
                || (data.type != null && String(data.type).toLowerCase()!=='recharge')) throw new FundingPendingError('原补款流水响应或归属无效，保留原补款订单');
            const matches=data.list.filter(row => row?.order_no===funding.order_no);
            if (matches.length>1) throw new FundingPendingError('原补款流水重复，需人工核对');
            if (matches.length) return {...result,data:matches[0]};
            const total=Number(data.total);
            seen+=data.list.length;
            if ((!data.list.length && (!Number.isFinite(total) || total<=seen)) || (Number.isFinite(total) && seen>=total)
                || (!Number.isFinite(total) && data.list.length<100)) return {...result,data:null};
            if (!data.list.length) throw new FundingPendingError('原补款流水缺页，请稍后确认原订单');
        }
        throw new FundingPendingError('原补款流水分页超过上限，保留原订单');
    }
    async function confirm(cfg, locked, funding, options={}) {
        try { return await confirmAttempt(cfg,locked,funding,options); }
        catch (error) {
            if (error instanceof FundingAwaitingError) {
                await (options.readOnly ? assertReconciliationAllowed : assertPaymentAllowed)(cfg,funding.job_key);
                const retryAt = Math.max(Number(funding.retry_at || 0),now()+error.retryAfterMs);
                await locked.deferFunding(funding.funding_key,retryAt);
                funding.retry_at=retryAt;
            }
            throw error;
        }
    }
    async function confirmAttempt(cfg, locked, funding, options={}) {
        const assertAllowed = options.readOnly ? assertReconciliationAllowed : assertPaymentAllowed;
        await assertAllowed(cfg, funding.job_key);
        if (funding.scope!==cardScope(cfg.base_url) || funding.credential_hash!==keyHash(cfg)) throw new FundingPendingError('补款平台或 API Key 与原申请不同，请恢复原配置后确认');
        let body;
        try { body=JSON.parse(funding.request_body); } catch (_) {throw new FundingPendingError('原补款请求正文缺失，需人工核对');}
        if (!body || Object.keys(body).length!==2 || JSON.stringify(body)!==funding.request_body || body.card_id!==Number(funding.card_id)
            || body.amount!==Number(funding.amount).toFixed(2)) throw new FundingPendingError('原补款参数不一致，禁止更换金额或幂等键重充');
        if (funding.state==='failed') throw new CardPreparationError('平台已确认原补款失败');
        if (options.readOnly && !funding.order_no) throw new FundingPendingError('原补款缺少平台订单号，无法只读确认；保留原记录，请人工核对');
        if (Number(funding.retry_at || 0)>now()) {
            const ErrorType = funding.order_no && ['pending','submitting','ready'].includes(funding.state) ? FundingAwaitingError : FundingPendingError;
            throw new ErrorType('原补款订单仍在重查间隔内，请稍后确认',Number(funding.retry_at)-now());
        }
        // Persist the minimum cadence before sending a read so a restart or a
        // different process cannot bypass it. Longer provider delays are merged below.
        if (options.readOnly) await locked.deferFunding(funding.funding_key,now()+FUNDING_POLL_MS);
        if (funding.state!=='ready') await locked.updateFunding(funding.funding_key,{state:funding.order_no?'pending':'submitting',message:'正在确认原补款订单'});
        // One submission/read per call. The caller waits outside the global card
        // allocation lock, then checks this same funding order every 5 seconds.
        await assertAllowed(cfg, funding.job_key);
        let result;
        if (funding.state==='ready') result={success:true,status:200,data:{order_no:funding.order_no,status:'success',amount:funding.amount}};
        else if (funding.order_no) {
            try { result=await flow(cfg,funding); }
            catch (error) {
                if (transientReadError(error)) throw new FundingAwaitingError('原补款流水查询暂不可用，稍后继续查询原订单',error.retryAfterMs);
                throw error;
            }
        }
        else {
            const card=await cardsApi.cardDetail(cfg,funding.card_id);
            if(card.provider_status!=='ACTIVE') throw new FundingPendingError('补款提交前发现卡片不可用，已停止发送补款；保留原意图和 CDK 待核对');
            await assertPaymentAllowed(cfg, funding.job_key);
            result=await api.request({...cfg,auditJobKey:funding.job_key},'rechargeCard',body,funding.funding_key);
        }
        const data=result.data,order=typeof data?.order_no==='string'?data.order_no:'',status=typeof data?.status==='string'?data.status:'';
        const delay=Math.max(FUNDING_POLL_MS,result.retryAfterMs || 0,
            Number.isFinite(Number(data?.retry_after_seconds))?Math.max(0,Number(data.retry_after_seconds)*1000):0);
        if ((funding.order_no && order && funding.order_no!==order) || (data?.card_id != null && Number(data.card_id)!==Number(funding.card_id))
            || (data?.amount != null && money.units(data.amount)!==money.units(funding.amount))) {
            await locked.updateFunding(funding.funding_key,{state:'unknown',message:'补款订单归属或金额不一致，停止履约',retry_at:now()+60000});
            record(funding,'card_funding_mismatch','原补款订单归属或金额不一致，停止自动履约',{order_no:funding.order_no || ''});
            throw new FundingPendingError('原补款订单或金额不一致，请人工核对，禁止重复补款');
        }
        // A missing flow or transient read failure says nothing about a new payment.
        // Only a previously saved order identity can enter automatic read-only recovery.
        if (funding.order_no && ((!result.success && transientResponse(result)) || (result.success && result.status===200 && data==null))) {
            await locked.updateFunding(funding.funding_key,{state:'pending',retry_at:now()+delay,message:'原补款流水暂不可确认，稍后只读核对'});
            funding.retry_at=now()+delay;
            throw new FundingAwaitingError('原补款结果仍待确认，稍后继续查询原订单',delay);
        }
        const fees={};
        for (const key of ['amount','fee_amount','total_debit_amount']) if(typeof data?.[key]==='string' && /^\d+(?:\.\d+)?$/.test(data[key])) fees[key]=data[key].slice(0,64);
        const valid=result.success && result.status===200 && order && typeof data?.amount==='string';
        await locked.updateFunding(funding.funding_key,{state:valid?'pending':'unknown',order_no:order,provider_status:status,
            fee_snapshot:Object.keys(fees).length?JSON.stringify(fees):undefined,retry_at:now()+delay,message:'原补款结果待确认，保留卡片与 CDK'});
        funding.order_no=order || funding.order_no;
        funding.retry_at=now()+delay;
        record(funding,'card_funding_result','收到原卡片补款结果',{order_no:order,status,success:result.success,fees});
        const complete=data?.completed==null || data.completed===true;
        if (data?.completed!=null && typeof data.completed!=='boolean') throw new FundingPendingError('原补款完成标记格式无效，请人工核对');
        if (valid && status==='success' && complete) {
            // A completed funding order can precede the card balance snapshot.
            await assertAllowed(cfg, funding.job_key);
            const card=await readFundedCard(cfg,funding);
            if(card.provider_status!=='ACTIVE' || card.currency!=='USD') {
                throw new FundingPendingError('补款已返回成功，但卡片状态或币种异常；保留原流水，请人工核对');
            }
            if(card.balance_amount==null) throw new FundingPendingError('补款已返回成功，但卡片余额字段缺失；保留原流水，请人工核对');
            if(money.units(card.balance_amount)<money.units(funding.target_balance)) {
                record(funding,'card_funding_balance_wait','原补款已成功，等待卡片余额同步后继续订阅',{
                    order_no:funding.order_no,target_balance:funding.target_balance,balance_after:card.balance_amount,wait_ms:delay});
                throw new FundingAwaitingError('补款已返回成功，等待卡片余额足额后继续订阅',delay);
            }
            await assertAllowed(cfg, funding.job_key);
            await locked.syncCards([card]);
            await locked.updateFunding(funding.funding_key,{state:'ready',message:'补款成功，卡片余额已核对'});
            record(funding,'card_funding_ready','原补款已确认且卡片余额足够',{order_no:funding.order_no,target_balance:funding.target_balance,balance_after:card.balance_amount});
            return card;
        }
        if (valid && ['failed','refunded'].includes(status) && complete) {
            await locked.updateFunding(funding.funding_key,{state:'failed',message:'平台明确返回原补款失败'});
            throw new CardPreparationError('平台已确认原卡片补款失败，请联系管理员检查账户资金');
        }
        if (valid && (pendingStatuses.has(status) || (status==='success' && !complete))) {
            throw new FundingAwaitingError('原卡片补款结果仍待确认，稍后继续查询原任务',delay);
        }
        throw new FundingPendingError('原卡片补款结果仍待确认，已锁定卡片和 CDK，请继续查询原任务');
    }
    async function ensure(cfg, locked, jobKey, plan, card, targetBalance) {
        await assertPaymentAllowed(cfg, jobKey);
        let funding=await locked.fundingForJob(jobKey);
        if (!funding) {
            const deficit=targetBalance-money.units(card.balance_amount);
            if (deficit<=0n) return card;
            const amount=money.cents(deficit),body={card_id:card.card_id,amount};
            funding=await locked.createFunding({funding_key:`fund-${crypto.randomUUID()}`,job_key:jobKey,plan_type:plan,
                card_id:card.card_id,amount,target_balance:money.decimal(targetBalance),credential_hash:keyHash(cfg),request_body:JSON.stringify(body)});
            record(funding,'card_funding_prepared','已保存卡片差额补款意图',{target_balance:funding.target_balance,balance_before:card.balance_amount});
        }
        return confirm(cfg,locked,funding);
    }
    async function recover(cfg, locked) {
        for (const funding of await locked.listFundings(true)) {
            if(Number(funding.retry_at || 0)>now()) continue;
            const handled = await withRecoveryOwner(cfg, funding, async ownedCfg => {
                if (funding.state==='prepared') {
                    await locked.updateFunding(funding.funding_key,{state:'failed',message:'服务在补款提交前中断，原补款未发送'});
                    return;
                }
                try { await confirm(ownedCfg,locked,funding,{readOnly:true}); }
                catch (error) {
                    if (error instanceof PaymentStoppedError) throw error;
                    await locked.updateFunding(funding.funding_key,{state:'unknown',retry_at:Math.max(Number(funding.retry_at || 0),now()+60000),message:'原补款仍待确认或人工核对，保持原申请身份'});
                    record(funding,'card_funding_pending','原补款仍待确认或人工核对，保持原申请身份');
                }
            });
            if (handled) return; // Skipped handoffs must not starve other orders.
        }
    }
    return {ensure,confirm,recover};
};
