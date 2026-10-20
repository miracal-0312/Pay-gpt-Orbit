'use strict';

const {
    PLAN_UPGRADE_TEST_IDS,
    pageShowsTargetRegionPricing,
    PRO_VARIANTS,
    getUniqueVisiblePlanButton,
    isPricingPlanSelectorVisible,
    resolvePlanUpgradeTestId,
    selectProVariantOnCheckoutPage,
    selectProVariantOnPricingPage
} = require('../pricing-checkout');

const createPage = ({ count, visible }) => ({
    getByTestId: (testId) => ({
        count: async () => count,
        isVisible: async () => visible,
        testId
    })
});

const createPricingReadinessPage = (visibleTestIds) => ({
    getByText: () => ({
        count: async () => visibleTestIds.includes('select-plan-button-pro-upgrade') ? 1 : 0,
        nth: () => ({
            isVisible: async () => true,
            locator: () => ({
                evaluate: async () => false,
                getByRole: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => true, isEnabled: async () => true }) })
            })
        })
    }),
    getByTestId: (testId) => ({
        count: async () => (visibleTestIds.includes(testId) ? 1 : 0),
        isVisible: async () => visibleTestIds.includes(testId)
    })
});

const createProPricingPage = () => {
    const radio = {
        selected: false,
        count: async () => 1,
        isVisible: async () => true,
        click: async () => { radio.selected = true; },
        getAttribute: async (name) => (name === 'aria-checked' && radio.selected ? 'true' : 'false')
    };
    return {
        page: {
            getByRole: () => radio,
            waitForTimeout: async () => {}
        },
        radio
    };
};

const createProCheckoutPage = ({ count = 1, visible = true } = {}) => {
    const option = {
        waitFor: async () => {},
        filter: () => ({ count: async () => 0 }),
        selected: false,
        count: async () => count,
        isVisible: async () => visible,
        click: async () => { option.selected = true; },
        getAttribute: async (name) => ({
            role: 'radio',
            value: 'chatgptpro',
            'aria-checked': option.selected ? 'true' : 'false',
            'data-state': option.selected ? 'checked' : 'unchecked'
        })[name]
    };
    return {
        page: {
            locator: () => option,
            getByRole: () => ({ count: async () => 0 }),
            waitForTimeout: async () => { if (count === 0) throw new Error('Checkout Pro 档位加载超时'); }
        },
        option
    };
};

describe('pricing checkout plan button', () => {
    it('recognizes Chilean prices without accepting ambiguous dollar prices', async () => {
        const pageWithText = (text) => ({
            locator: () => ({
                first: () => ({ isVisible: async () => true, innerText: async () => text })
            })
        });
        for (const text of ['CLP 19.990', '19.990 CLP', 'CL$19.990', 'Chile $19.990', '智利 $19.990']) {
            await expect(pageShowsTargetRegionPricing(pageWithText(text), 'CL')).resolves.toBe(true);
        }
        for (const text of ['$20 / month', 'Chile USD $20', 'Chile US$20', 'Chile S$30', 'Chile $']) {
            await expect(pageShowsTargetRegionPricing(pageWithText(text), 'CL')).resolves.toBe(false);
        }
    });

    it('provides Chile billing and browser settings', () => {
        const { isSupportedRegion, getRegionBilling, getRegionBrowserProfile } = require('../region-config');
        expect(isSupportedRegion('cl')).toBe(true);
        expect(getRegionBilling('CL')).toEqual({ country: 'CL', currency: 'CLP', label: '智利' });
        expect(getRegionBrowserProfile('CL')).toEqual({ locale: 'es-CL', timezoneId: 'America/Santiago' });
    });

    it('uses the verified test ids for Plus and Pro', () => {
        expect(PLAN_UPGRADE_TEST_IDS).toEqual({
            pro100: 'select-plan-button-pro-upgrade',
            pro200: 'select-plan-button-pro-upgrade',
            pro500: 'select-plan-button-pro-upgrade',
            plus: 'select-plan-button-plus-upgrade',
            pro_5x: 'select-plan-button-pro-upgrade',
            pro_20x: 'select-plan-button-pro-upgrade'
        });
    });

    it('maps each Pro CDK plan to its verified checkout option', () => {
        expect(PRO_VARIANTS).toEqual({
            pro100: { checkoutValue: 'chatgptprolite', pricingRadioLabel: null },
            pro200: { checkoutValue: 'chatgptpro', pricingRadioLabel: null },
            pro500: { checkoutValue: 'chatgptpromax', pricingRadioLabel: null },
            pro_5x: { checkoutValue: 'chatgptprolite', pricingRadioLabel: '5x' },
            pro_20x: { checkoutValue: 'chatgptpro', pricingRadioLabel: '20x' }
        });
    });

    it('rejects unsupported plans instead of falling back to another button', () => {
        expect(() => resolvePlanUpgradeTestId('go')).toThrow('不支持 UI 定价页套餐: go');
    });

    it('rejects a missing or duplicate target button', async () => {
        await expect(getUniqueVisiblePlanButton(createPage({ count: 0, visible: false }), 'plus'))
            .rejects
            .toThrow('定价页套餐按钮数量异常: plus / select-plan-button-plus-upgrade / 0');
        await expect(getUniqueVisiblePlanButton(createPage({ count: 2, visible: true }), 'plus'))
            .rejects
            .toThrow('定价页套餐按钮数量异常: plus / select-plan-button-plus-upgrade / 2');
    });

    it('rejects an invisible target button', async () => {
        await expect(getUniqueVisiblePlanButton(createPage({ count: 1, visible: false }), 'plus'))
            .rejects
            .toThrow('定价页套餐按钮不可见: plus / select-plan-button-plus-upgrade');
    });

    it('requires the requested plan button before treating the pricing page as ready', async () => {
        const proOnly = createPricingReadinessPage(['select-plan-button-pro-upgrade']);

        await expect(isPricingPlanSelectorVisible(proOnly, 'pro_20x')).resolves.toBe(true);
        await expect(isPricingPlanSelectorVisible(proOnly, 'plus')).resolves.toBe(false);
    });

    it('selects and confirms the requested Pro variant in both UI stages', async () => {
        const pricing = createProPricingPage();
        const checkout = createProCheckoutPage();

        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_20x')).resolves.toBe(true);
        await expect(selectProVariantOnCheckoutPage(checkout.page, 'pro_20x')).resolves.toBeUndefined();

        expect(pricing.radio.selected).toBe(true);
        expect(checkout.option.selected).toBe(true);
    });

    it('stops when the Checkout Pro option is missing', async () => {
        const checkout = createProCheckoutPage({ count: 0 });

        await expect(selectProVariantOnCheckoutPage(checkout.page, 'pro_20x'))
            .rejects
            .toThrow('Checkout Pro 档位加载超时');
    });
});
