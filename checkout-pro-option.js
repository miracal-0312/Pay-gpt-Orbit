'use strict';

const PRO_OPTION_LABELS = Object.freeze({
    chatgptprolite: /\bStandard\b|标准/i,
    chatgptpro: /\bMore usage\b|更高使用额度/i,
    chatgptpromax: /\bMax usage\b|最高使用额度/i
});

async function findVisibleOption(locator) {
    const count = await locator.count();
    if (count === 1 && await locator.isVisible().catch(() => false)) return locator;
    if (count > 1) {
        const visible = [];
        for (let i = 0; i < count; i++) {
            const item = locator.nth(i);
            if (await item.isVisible().catch(() => false)) visible.push(item);
        }
        if (visible.length > 1) throw new Error('Checkout Pro 档位匹配到多个可见控件');
        return visible[0] || null;
    }
    return null;
}

async function resolveProCheckoutOption(page, value, timeout = 30000) {
    const deadline = Date.now() + timeout;
    const labels = PRO_OPTION_LABELS[value];
    if (!labels) throw new Error('不支持的 Checkout Pro 档位');
    while (Date.now() < deadline) {
        const exact = await findVisibleOption(page.locator(`#${value}`));
        if (exact) return { option: exact, byId: true };
        // 只定位可交互档位控件，不点击摘要里的普通文本或价格。
        const candidates = [
            page.getByRole('radio', { name: labels }),
            page.getByRole('button', { name: labels }),
            page.locator('label').filter({ hasText: labels })
        ];
        for (const candidate of candidates) {
            const option = await findVisibleOption(candidate);
            if (option) return { option, byId: false };
        }
        await page.waitForTimeout(300);
    }
    throw new Error(`Checkout Pro 档位加载超时: ${value}；未找到 ID 或中英文档位控件`);
}

async function isProOptionSelected(option) {
    const checked = await option.getAttribute('aria-checked');
    const pressed = await option.getAttribute('aria-pressed');
    const state = await option.getAttribute('data-state');
    if (checked === 'false' || pressed === 'false' || /^(unchecked|inactive)$/.test(state || '')) return false;
    if (checked === 'true' || pressed === 'true' || /^(checked|active|selected)$/.test(state || '')) return true;
    return option.evaluate((node) => {
        const input = node.matches('input[type="radio"]') ? node
            : node.control || node.querySelector('input[type="radio"]');
        return Boolean(input && input.checked);
    }).catch(() => false);
}

module.exports = { PRO_OPTION_LABELS, resolveProCheckoutOption, isProOptionSelected };
