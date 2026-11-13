'use strict';
const { CardPreparationError } = require('./orbitcard-card-policy');
const { cdkLockKey, manualLockKeys } = require('./payment-execution-lock');

class PaymentStoppedError extends CardPreparationError {}

function requiresManualHandling(task) {
    return Boolean(task?.manual_redeemed_at) || task?.status === 'manual'
        || ['manual', 'support_locked', 'card_pending', 'funding_pending'].includes(task?.orbitcard_state);
}

module.exports = function createPaymentAutomation({ runQuery }) {
    async function paymentOwner(jobKey) {
        if (!jobKey) return { allowed: true, keys: [] }; // Standalone administrator card application.
        const manual = jobKey.startsWith('manual-');
        const [owner] = await runQuery(manual
            ? 'SELECT * FROM orbitcard_admin_orders WHERE client_order_no = ? LIMIT 1'
            : 'SELECT * FROM task_logs WHERE job_key = ? LIMIT 1', [jobKey]);
        if (!owner) return { allowed: false, keys: [] };
        const [code] = owner.cdk_code
            ? await runQuery('SELECT * FROM cdk_codes WHERE cdk_code = ? LIMIT 1', [owner.cdk_code]) : [];
        const activeOwner = !owner.cdk_code || Boolean(code?.is_active && !code.manual_redeemed_at);
        const state = manual ? owner.state : owner.orbitcard_state;
        const allowed = activeOwner
            && (manual ? ['preparing', 'prepared', 'funding_waiting', 'submitting', 'pending'].includes(owner.state)
                : !requiresManualHandling(owner) && ['preparing', 'prepared', 'funding_waiting', 'submitting', 'pending'].includes(owner.orbitcard_state));
        // Stopping new payments must not strand an already submitted debit.
        // Reconciliation only reads the original funding; settlement separately
        // preserves a manually redeemed CDK while releasing its payment card.
        const canReconcileFunding = (!owner.cdk_code || Boolean(code))
            && ['funding_waiting', 'funding_review', 'funding_pending'].includes(state);
        const canReconcileIssue = (!owner.cdk_code || Boolean(code)) && state === 'card_pending';
        return { allowed, canReconcileFunding, canReconcileIssue, state, keys: manual ? manualLockKeys(owner.request_id, owner.cdk_code)
            : owner.cdk_code ? [cdkLockKey(owner.cdk_code)] : [] };
    }
    async function assertPaymentAllowed(jobKey) {
        if (!(await paymentOwner(jobKey)).allowed) {
            throw new PaymentStoppedError('任务已转人工处理或已结束，自动开卡、补款和订阅充值已停止');
        }
    }
    async function assertFundingReconciliationAllowed(jobKey) {
        const owner = await paymentOwner(jobKey);
        if (!owner.allowed && !owner.canReconcileFunding) {
            throw new PaymentStoppedError('原补款已停止自动对账或任务已结束，请人工核对');
        }
    }
    async function assertIssueReconciliationAllowed(jobKey) {
        const owner = await paymentOwner(jobKey);
        if (!owner.allowed && !owner.canReconcileIssue) {
            throw new PaymentStoppedError('原开卡申请已停止对账或任务已结束，请人工核对');
        }
    }
    return { paymentOwner, assertPaymentAllowed, assertFundingReconciliationAllowed, assertIssueReconciliationAllowed };
};
module.exports.requiresManualHandling = requiresManualHandling;
module.exports.PaymentStoppedError = PaymentStoppedError;
