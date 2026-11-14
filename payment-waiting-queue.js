'use strict';

const { CardPreparationError, CardBusyError } = require('./orbitcard-card-policy');
const { parseSession } = require('./session-input');

const WAITING_MESSAGE = '支付卡繁忙，已进入等待队列（最多 1 个等待任务）；卡片可用后将自动继续，请勿重复下单';
const FULL_MESSAGE = '当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。';
const TIMEOUT_MESSAGE = '排队等待已超过 30 分钟，本次尚未提交支付，请 10 分钟后重新下单。';
const STOPPED_MESSAGE = '服务正在重启，排队任务尚未提交支付，请稍后使用原卡密和最新 Session 重新下单。';
const WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 5000;

class PaymentQueueFullError extends CardPreparationError {
    constructor() { super(FULL_MESSAGE); this.code = 'PAYMENT_QUEUE_FULL'; this.status = 429; this.retryAfterSeconds = 600; }
}
class PaymentQueueTimeoutError extends CardPreparationError {
    constructor() { super(TIMEOUT_MESSAGE); this.code = 'PAYMENT_QUEUE_TIMEOUT'; this.retryAfterSeconds = 600; }
}
class PaymentQueueStoppedError extends CardPreparationError {
    constructor() { super(STOPPED_MESSAGE); this.code = 'PAYMENT_QUEUE_STOPPED'; }
}

// Existing task messages survive a restart. Map only our fixed messages to public
// response metadata, without placing queue metadata in an upstream payment snapshot.
function queueFeedback(value) {
    const message = String(value?.message || value || '');
    if (value?.code === 'PAYMENT_QUEUE_FULL' || message.includes(FULL_MESSAGE)) return { error_code: 'PAYMENT_QUEUE_FULL', retry_after_seconds: 600 };
    if (value?.code === 'PAYMENT_QUEUE_TIMEOUT' || message.includes(TIMEOUT_MESSAGE)) return { error_code: 'PAYMENT_QUEUE_TIMEOUT', retry_after_seconds: 600 };
    if (value?.code === 'PAYMENT_QUEUE_STOPPED' || message.includes(STOPPED_MESSAGE)) return { error_code: 'PAYMENT_QUEUE_STOPPED' };
    return {};
}

function createPaymentWaitingQueue({ store, activeJobs, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = WAIT_MS, pollMs = POLL_MS }) {
    let holder = null, closed = false;
    function activeCount() {
        return Math.max(0, activeJobs.size - (holder?.phase === 'waiting' && activeJobs.has(holder.key) ? 1 : 0));
    }
    async function acquire(key) {
        if (closed) throw new PaymentQueueStoppedError();
        if (holder) {
            if (holder.key === key) return holder.ready;
            throw new PaymentQueueFullError();
        }
        // Reserve synchronously before awaiting MySQL, including overlapping HTTP requests.
        const entry = { key, phase: 'waiting', deadline: now() + waitMs, guard: null, released: false };
        holder = entry;
        const ticket = {
            get key() { return entry.key; },
            rename(nextKey) { if (entry.released) throw new Error('等待任务已释放'); entry.key = nextKey; },
            async release() {
                if (entry.released) return;
                entry.released = true;
                try { await entry.guard?.release(); }
                finally { if (holder === entry) holder = null; }
            }
        };
        entry.ticket = ticket;
        entry.ready = (async () => {
            try {
                entry.guard = await store.acquirePaymentLock('payment:waiting-slot');
                if (!entry.guard) throw new PaymentQueueFullError();
                if (closed) throw new PaymentQueueStoppedError();
                return ticket;
            } catch (error) { await ticket.release(); throw error; }
        })();
        return entry.ready;
    }
    function entryFor(ticket) {
        if (!holder || holder.ticket !== ticket || holder.released) throw new CardPreparationError('等待任务执行权已失效，请查询原订单');
        return holder;
    }
    async function validate(ticket, { session, cfg }) {
        const entry = entryFor(ticket);
        if (closed) throw new PaymentQueueStoppedError();
        if (now() >= entry.deadline) throw new PaymentQueueTimeoutError();
        try { parseSession(session); }
        catch (_) { throw new CardPreparationError('等待期间 Session 已失效，本次尚未提交支付，请使用最新 Session 重新下单'); }
        await cfg.executionGuard?.assertOwned();
        await entry.guard.assertOwned();
        await cfg.paymentGuard?.assertAllowed();
        if (closed) throw new PaymentQueueStoppedError();
        if (now() >= entry.deadline) throw new PaymentQueueTimeoutError();
    }
    async function pause(ticket, input) {
        await validate(ticket, input);
        await sleep(Math.min(pollMs, Math.max(0, entryFor(ticket).deadline - now())));
        await validate(ticket, input);
    }
    async function waitForCapacity(ticket, input) {
        const entry = entryFor(ticket);
        entry.phase = 'waiting';
        for (;;) {
            await validate(ticket, input);
            const max = await store.getMaxConcurrentActivations();
            if (activeCount() < max) {
                // This job still lives in activeJobs. Marking it selecting reserves
                // the foreground capacity before another caller can await admission.
                entry.phase = 'selecting';
                return;
            }
            await pause(ticket, input);
        }
    }
    async function allocate({ key, session, cfg, allocate: attempt, onWait = async () => {} }) {
        let ticket = holder?.key === key ? await holder.ready : null;
        let announced = false;
        try {
            for (;;) {
                if (ticket) {
                    if (!announced) { await onWait(WAITING_MESSAGE); announced = true; }
                    await waitForCapacity(ticket, { session, cfg });
                }
                try { return await attempt(); }
                catch (error) {
                    if (!(error instanceof CardBusyError)) throw error;
                    if (!ticket) ticket = await acquire(key);
                    entryFor(ticket).phase = 'waiting';
                    if (!announced) { await onWait(WAITING_MESSAGE); announced = true; }
                    // allocate() has already released its global card lock here.
                    await pause(ticket, { session, cfg });
                }
            }
        } finally { if (ticket) await ticket.release(); }
    }
    return {
        acquire, allocate, waitForCapacity, activeCount,
        has: key => holder?.key === key && !holder.released,
        isFull: () => Boolean(holder),
        get count() { return holder?.phase === 'waiting' && !holder.released ? 1 : 0; },
        get waitingMessage() { return WAITING_MESSAGE; },
        async release(key) { if (holder?.key === key) await holder.ticket.release(); },
        close() { closed = true; }
    };
}

module.exports = { createPaymentWaitingQueue, PaymentQueueFullError, PaymentQueueTimeoutError, PaymentQueueStoppedError,
    queueFeedback, WAITING_MESSAGE, FULL_MESSAGE, WAIT_MS, POLL_MS };
