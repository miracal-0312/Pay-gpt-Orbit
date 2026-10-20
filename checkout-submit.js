'use strict';

const CHECKOUT_SUBMIT_NAME = /^(Subscribe|订阅|立即支付|Pay now|Upgrade to (?:Pro|Plus)|升级至\s*(?:Pro|Plus))$/i;

async function waitForCheckoutSubmit(page, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const button = page.getByRole('button', { name: CHECKOUT_SUBMIT_NAME });
        if (await button.count() === 1 && await button.isVisible().catch(() => false)
            && await button.isEnabled().catch(() => false)) return;
        await page.waitForTimeout(500);
    }
    throw new Error('银行卡和地址调试未就绪：未找到唯一可见且可用的最终付款按钮');
}

module.exports = { CHECKOUT_SUBMIT_NAME, waitForCheckoutSubmit };
