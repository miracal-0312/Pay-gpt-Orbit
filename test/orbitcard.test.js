'use strict';
const axios = require('axios');
const crypto = require('node:crypto');
const api = require('../orbitcard-client');
const worker = require('../orbitcard-worker');

describe('Orbitcard integration', () => {
    const cfg = { provider: 'orbitcard', base_url: 'https://orbitcard.test:8443/', api_key: 'test-key', orbitcard_card_id: '123' };
    beforeEach(() => { vi.stubEnv('ORBITCARD_API_SECRET', 'test-secret'); });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

    it('signs the exact transmitted bytes and all ten canonical lines', async () => {
        const spy = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { code: 0, data: {} } });
        await api.request(cfg, 'createSubscription', { text: '中文', value: 1 }, 'stable-order');
        const req = spy.mock.calls[0][0];
        const h = req.headers;
        const canonical = ['ORBITCARD-HMAC-SHA256-V1', 'test-key', h['X-Timestamp'], h['X-Nonce'], 'POST',
            'orbitcard.test:8443', '/api/open/v1/createSubscription', '', crypto.createHash('sha256').update(req.data).digest('hex'), 'stable-order'].join('\n');
        expect(h['X-Signature']).toBe(crypto.createHmac('sha256', 'test-secret').update(canonical).digest('hex'));
        expect(req.maxRedirects).toBe(0);
        expect(JSON.parse(req.data)).toEqual({ text: '中文', value: 1 });
        expect(h['X-Nonce']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    });

    it('checks business code and never returns credential-bearing transport errors', async () => {
        vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 200, data: { code: 59018, msg: 'sensitive', data: { task_no: 'SUB1' } } })
            .mockRejectedValueOnce(new Error('secret Session contents'));
        const rejected = await api.request(cfg, 'createSubscription');
        expect(rejected.success).toBe(false);
        expect(rejected.data.task_no).toBe('SUB1');
        expect(JSON.stringify(await api.request(cfg, 'getSubscription'))).not.toContain('Session contents');
    });

    it('keeps local failures and fee failures separate from subscription outcomes', () => {
        expect(api.outcome({ status: 'failed' })).toBe('pending');
        expect(api.outcome({ status: 'failed', task_status: 'failed', subscription_succeeded: null, upstream_status: 'unknown' }, true)).toBe('pending');
        expect(api.outcome({ status: 'succeeded', fee_status: 'charge_failed' }, true)).toBe('success');
        expect(api.summary({ task_no: 'SUB1', session: { accessToken: 'secret' }, captcha: { url: 'ticket' } })).toEqual({ task_no: 'SUB1' });
    });

    it('preserves full verification URL and clears absent/expired tickets', () => {
        const data = { stage: 'awaiting_captcha', captcha: { id: 'cap1', status: 'pending', url: 'https://verify.test/#access=ticket', expires_at: new Date(Date.now() + 60000).toISOString() } };
        expect(api.captcha(data).url).toBe(data.captcha.url);
        expect(api.captcha({})).toBeNull();
        expect(api.captcha({ ...data, captcha: { ...data.captcha, expires_at: '2000-01-01T00:00:00Z' } })).toBeNull();
    });

    async function runWorker(results) {
        vi.spyOn(api, 'fetchPlans').mockResolvedValue({ success: true, plans: [{ type: 'gpt-pro-25x' }] });
        const request = vi.spyOn(api, 'request').mockResolvedValueOnce({ success: true, data: { payment_regions: [{ code: 'JP', default: true }] } });
        for (const result of results) request.mockResolvedValueOnce(result);
        const setProgress = vi.fn();
        const onSubmission = vi.fn();
        const rollback = await worker.run({ cfg, planType: 'pro500', session: { accessToken: 'token', user: {}, account: {} },
            cdk: 'test-cdk', setProgress, onSubmission, broadcast: vi.fn(), sleep: async () => {}, maxPolls: results.length - 1 });
        return { rollback, request, setProgress, onSubmission };
    }

    it('queries an uncertain submission using the same business identity without resubmitting', async () => {
        const out = await runWorker([{ success: false }, { success: true, data: { orderId: 'SUB1', status: 'succeeded', fee_status: 'charge_failed' } }]);
        expect(out.rollback).toBe(false);
        const create = out.request.mock.calls[1];
        expect(create[2]).toMatchObject({ plan_type: 'gpt-pro-25x', payment_region: 'JP', card_id: 123, authorized: true });
        expect(out.request.mock.calls[2][2]).toEqual({ client_order_no: create[2].client_order_no });
        expect(create[3]).toBe(create[2].client_order_no);
        expect(out.setProgress.mock.calls.at(-1)[0]).toBe('success');
    });

    it('does not roll back a CDK when polling fails or ownership does not match', async () => {
        const out = await runWorker([{ success: true, data: { task_no: 'SUB1' } }, { success: true, data: { orderId: 'OTHER', status: 'succeeded', session: { accessToken: 'secret' } } }]);
        expect(out.rollback).toBe(false);
        expect(out.setProgress.mock.calls.at(-1)[0]).toBe('manual');
        expect(JSON.stringify(out.setProgress.mock.calls)).not.toContain('secret');
    });
});
