const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectRegionProxy } = require('../proxy-region-routing');
const original = 'socks5://demo-region-PH-sid-old-t-10:p%40ss@us.example.com:1000';

test('skips failures and wrong countries and returns the exact validated session', async () => {
    const seen = [];
    const used = [];
    const result = await selectRegionProxy([1, 2, 3].map((id) => ({ id, proxy_url: original, country: 'CL' })), 'CL', {
        probe: async (proxy, options) => {
            seen.push(proxy);
            assert.equal(options.expectedCountry, 'CL');
            if (seen.length === 1) throw new Error('network error');
            return { ok: true, country: seen.length === 2 ? 'PH' : 'CL' };
        },
        onSelected: async (row) => used.push(row.id)
    });
    assert.equal(result, seen[2]);
    assert.deepEqual(used, [3]);
});
test('fails closed on empty pools and limits checks to five candidates', async () => {
    await assert.rejects(selectRegionProxy([], 'CL', { probe: async () => {} }), /没有可用代理/);
    let count = 0;
    await assert.rejects(selectRegionProxy(Array(9).fill({ proxy_url: original, country: 'CL' }), 'CL', {
        probe: async () => { count++; return { ok: false }; }
    }), /未找到出口国家为 CL/);
    assert.equal(count, 5);
});

test('never rewrites URLs or selects another country or unclassified rows', async () => {
    let calls = 0;
    const rows = [{ country: 'PH', proxy_url: 'wrong' }, { proxy_url: 'unclassified' }, { country: 'CL', proxy_url: original }];
    const selected = await selectRegionProxy(rows, 'CL', { probe: async (url) => { calls++; assert.equal(url, original); return { ok: true, country: 'CL' }; } });
    assert.equal(selected, original);
    assert.equal(calls, 1);
});
