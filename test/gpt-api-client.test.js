'use strict';
const axios = require('axios');
const client = require('../gpt-api-client');

describe('Orbitcard-only third-party client', () => {
    beforeEach(() => vi.stubEnv('ORBITCARD_API_SECRET', 'test-secret'));
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    const cfg = { base_url: 'https://orbitcard.test', api_key: 'test-key' };

    it('uses HMAC even when an obsolete provider field is passed', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200,
            data: { code: 0, data: { enabled: true, plans: [{ type: 'gpt-plus', service_fee: '0.15' }] } } });
        const result = await client.fetchPlans({ ...cfg, provider: 'legacy' });
        expect(result.plans[0].key).toBe('gpt-plus');
        expect(spy.mock.calls[0][0].url).toBe('https://orbitcard.test/api/open/v1/getSubscriptionPlans');
        expect(spy.mock.calls[0][0].method).toBe('POST');
        expect(spy.mock.calls[0][0].headers['X-Signature']).toMatch(/^[a-f0-9]{64}$/);
        expect(spy.mock.calls[0][0].headers.Authorization).toBeUndefined();
    });

    it('queries balance through the signed POST endpoint', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { code: 0, data: { balance: '10.00' } } });
        expect((await client.queryBalance(cfg)).data.balance).toBe('10.00');
        expect(spy.mock.calls[0][0].url).toBe('https://orbitcard.test/api/open/v1/getAccountBalance');
    });

    it('does not expose retired payment and task methods', () => {
        for (const name of ['inspectPay', 'submitPay', 'queryTask', 'extractTopupCode', 'extractStatus']) {
            expect(client[name]).toBeUndefined();
        }
        expect(client.DEFAULT_BASE_URL).toBe('https://orbitcard.cc');
    });

    it('fails authentication locally when no secret is configured', async () => {
        vi.stubEnv('ORBITCARD_API_SECRET', '');
        const spy = vi.spyOn(axios, 'request');
        expect((await client.fetchPlans(cfg)).success).toBe(false);
        expect(spy).not.toHaveBeenCalled();
    });
});
