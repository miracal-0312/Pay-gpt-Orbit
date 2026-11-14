'use strict';

const { decideCards } = require('./orbitcard-payment-decision');
const { CardPreparationError } = require('./orbitcard-card-policy');
const money = require('./orbitcard-money');

function taskCount(value = 10) {
    if (!Number.isSafeInteger(value) || value < 2 || value > 100) {
        throw new CardPreparationError('并发模拟任务数必须为 2 到 100 的整数');
    }
    return value;
}

// An in-memory model of one burst arriving at allocation. It shares the real
// decision policy, but never acquires database locks or calls a write API.
async function simulateSelection({ snapshot, count, available, planType, priceFor, jobPrefix }) {
    count = taskCount(count);
    const saved = snapshot.saved.map(row => ({ ...row }));
    let remaining = available, tail = Promise.resolve();
    const decide = jobKey => decideCards({ ...snapshot, saved, jobKey, planType, priceFor });
    const initial = decide(`${jobPrefix}-initial`);
    const initialCard = initial.candidates[0]?.card.card_id || null;
    const initialWaiting = Object.fromEntries([...new Set(initial.waiting.map(row => row.reason))]
        .map(reason => [reason, initial.waiting.filter(row => row.reason === reason).length]));
    const tasks = await Promise.all(Array.from({ length: count }, (_, index) => {
        const jobKey = `${jobPrefix}-${index + 1}`;
        // All requests arrive before the first allocation runs. The critical
        // section reselects against reservations made by preceding requests.
        const pending = tail.then(() => {
            const row = { task: index + 1, initial_card_id: initialCard, card_id: null,
                funding_amount: '0.00', budget_required: '0.00' };
            const decision = decide(jobKey), candidate = decision.candidates[0];
            if (candidate) {
                const funding = money.units(money.cents(candidate.deficit));
                Object.assign(row, { funding_amount: money.cents(funding), budget_required: money.cents(funding) });
                if (remaining < funding) return { ...row, action: 'blocked', reason: 'account_balance' };
                candidate.row.active_job = jobKey;
                remaining -= funding;
                return { ...row, action: candidate.action, card_id: candidate.card.card_id, reason: 'reserved_in_simulation' };
            }
            if (decision.action === 'wait') {
                const reasons = [...new Set(decision.waiting.map(card => card.reason))];
                return { ...row, action: 'wait', reason: reasons.length === 1 ? reasons[0] : 'multiple_waiting', reasons };
            }
            return { ...row, action: 'blocked', reason: 'automatic_opening_disabled', message: '没有可用的现有卡，自动开卡已禁用' };
        });
        tail = pending;
        return pending;
    }));
    const assigned = tasks.filter(row => row.card_id != null);
    return { read_only: true, model: 'serialized_snapshot_allocation', database_locks_tested: false,
        snapshot_at: new Date(snapshot.now).toISOString(), plan_type: planType, task_count: count,
        holds_until_end: true, payment_completion_simulated: false, admission_limit_simulated: false,
        initial_candidate_count: initial.candidates.length, initial_waiting: initialWaiting, skipped: initial.skipped,
        initial_contention: initialCard ? { card_id: initialCard, tasks: count } : null,
        summary: { assigned: assigned.length, pay: tasks.filter(row => row.action === 'pay').length,
            fund: tasks.filter(row => row.action === 'fund').length, waiting: tasks.filter(row => row.action === 'wait').length,
            blocked: tasks.filter(row => row.action === 'blocked').length, opening: tasks.filter(row => row.action === 'open').length,
            duplicate_assignments: assigned.length - new Set(assigned.map(row => row.card_id)).size },
        budget: { available: money.decimal(available), reserved: money.decimal(available - remaining),
            remaining: money.decimal(remaining), fees_included: false }, tasks };
}

module.exports = { simulateSelection, taskCount };
