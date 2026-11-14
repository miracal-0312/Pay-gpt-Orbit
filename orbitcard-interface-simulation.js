'use strict';

const { OPERATIONS, validateRequest } = require('./orbitcard-api-contract');

// This module deliberately has no transport, credentials, database or payment
// dependencies. It checks local request contracts, not remote write permission.
function simulate(operation) {
    if (!Object.hasOwn(OPERATIONS, operation) || !OPERATIONS[operation].write) {
        throw new Error('仅支持已接入写入接口的本地参数模拟');
    }
    const key = 'local-diagnostic-fixture';
    const bodies = {
        createCard: { product_code: 'LOCAL_FIXTURE', amount: '20.00', quantity: 1 },
        rechargeCard: { card_id: 1, amount: '1.00' },
        deleteCard: { card_id: 1 },
        createSubscription: { client_order_no: key, plan_type: 'gpt-plus', card_id: 1,
            session_json: { user: { email: 'diagnostic@example.invalid' }, account: {}, accessToken: 'local-synthetic-token' },
            authorized: true, max_service_fee: '0.10' }
    };
    const body = bodies[operation], checks = [];
    function check(name, action, shouldReject = false) {
        let rejected = false;
        try { action(); } catch (_) { rejected = true; }
        checks.push({ name, status: rejected === shouldReject ? 'passed' : 'failed' });
    }
    check('示例请求通过当前参数契约校验', () => validateRequest(operation, body, key));
    check('拒绝缺失的幂等键', () => validateRequest(operation, body, ''), true);
    check('拒绝不合法的幂等键', () => validateRequest(operation, body, 'bad\nkey'), true);
    check('拒绝未定义的请求字段', () => validateRequest(operation, { ...body, unsupported_field: true }, key), true);
    const amountField = operation === 'createSubscription' ? 'max_service_fee' : 'amount';
    if (Object.hasOwn(body, amountField)) {
        check('拒绝数字类型金额', () => validateRequest(operation, { ...body, [amountField]: 1 }, key), true);
        check('拒绝非定点金额格式', () => validateRequest(operation, { ...body, [amountField]: '1e2' }, key), true);
    }
    const passed = checks.every(item => item.status === 'passed');
    return { passed, message: passed
        ? '本地参数模拟通过；未向平台发送请求，未验证远端权限或实际资金操作'
        : '本地参数模拟失败；未向平台发送请求',
        summary: { validation: 'request_contract', sent_to_platform: false,
            checked: checks.length, passed: checks.filter(item => item.status === 'passed').length }, checks };
}

module.exports = { simulate };
