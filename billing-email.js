'use strict';

function inspectBillingEmail(node) {
    const own = [node.id, node.getAttribute('name'), node.getAttribute('autocomplete'),
        node.getAttribute('aria-label'), node.getAttribute('placeholder'),
        ...Array.from(node.labels || []).map((label) => label.textContent)].filter(Boolean).join(' ');
    const emailLike = node.type === 'email' || /email|e-mail|邮箱|电子邮件/i.test(own);
    if (!emailLike) return { accepted: false };
    let billing = /billing.?email|contact.?email|customer.?email|账单.*邮箱|联系.*邮箱/i.test(own);
    let link = /link.?email|link.?auth/i.test(own);
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 6 && !/^(BODY|HTML)$/.test(parent.tagName); depth++, parent = parent.parentElement) {
        const marker = [parent.id, parent.className, parent.getAttribute('data-testid'), parent.getAttribute('aria-label')].filter(Boolean).join(' ');
        const text = String(parent.textContent || '');
        if (/link.?auth|link.?signup|link.?registration|link.?account/i.test(marker)
            || /(?:sign\s*(?:in|up)|log\s*in|register|登录|注册).{0,30}\bLink\b|\bLink\b.{0,40}(?:terms|privacy|条款|隐私)|create an account and save my payment/i.test(text)) link = true;
        if (/billing|contact|账单|联系信息/i.test(marker)
            || /Billing address|Billing details|Contact information|账单地址|账单信息|联系信息/i.test(text)) billing = true;
    }
    return { accepted: billing && !link, required: Boolean(node.required || node.getAttribute('aria-required') === 'true') };
}

async function findBillingEmail(page) {
    const matches = [];
    const contexts = typeof page.frames === 'function' ? page.frames() : [page];
    for (const context of contexts) {
        const url = typeof context.url === 'function' ? context.url() : '';
        if (/link[-_/](?:auth|signup|login|registration)|https:\/\/(?:[^/]+\.)?link\.com\//i.test(url)) continue;
        const fields = context.locator('input[type="email"], input[autocomplete="email"], input[name*="email" i], input[id*="email" i]');
        for (let i = 0; i < await fields.count(); i++) {
            const field = fields.nth(i);
            if (!await field.isVisible().catch(() => false)) continue;
            const info = await field.evaluate(inspectBillingEmail, undefined, { timeout: 2000 });
            if (info.accepted) matches.push({ field, required: info.required });
        }
    }
    if (matches.length > 1) throw new Error('检测到多个账单邮箱输入框，无法确认目标字段');
    return matches[0] || null;
}

async function fillOptionalBillingEmail(page, loginEmail) {
    const email = String(loginEmail || '').trim();
    for (let attempt = 0; attempt < 2; attempt++) {
        const target = await findBillingEmail(page);
        if (!target) return { skipped: true };
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (target.required) throw new Error('页面要求账单邮箱，但未取得有效的当前登录邮箱');
            return { skipped: true };
        }
        try {
            if (String(await target.field.inputValue({ timeout: 2000 })).trim() !== email) {
                await target.field.fill(email, { timeout: 2000 });
                await target.field.press('Tab', { timeout: 2000 });
            }
            if (String(await target.field.inputValue({ timeout: 2000 })).trim() !== email
                || await target.field.getAttribute('aria-invalid') === 'true') throw new Error('账单邮箱未通过页面校验');
            console.log('[Stripe] 账单邮箱已使用当前登录邮箱填写并检查');
            return { filled: true };
        } catch (_) {
            if (attempt === 1) throw new Error('账单邮箱填写失败，已停止继续付款');
        }
    }
}

module.exports = { inspectBillingEmail, findBillingEmail, fillOptionalBillingEmail };
