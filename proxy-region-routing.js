'use strict';

async function selectRegionProxy(rows, region, { probe, prepare = (value) => value, onSelected = async () => {} }) {
    const country = String(region || '').trim().toUpperCase();
    if (!rows.length) throw new Error(`代理池没有可用代理：请先添加或归类 ${country} 国家代理并启用`);
    for (const row of rows.filter((item) => item.country === country).slice(0, 5)) {
        try {
            const proxy = prepare(String(row.proxy_url || ''));
            const result = await probe(proxy, { expectedCountry: country });
            if (result.ok && result.country === country) {
                console.log(`[代理池] 出口国家验证通过: 支付地区=${country}, 出口国家=${result.country}`);
                await onSelected(row);
                return proxy;
            }
            console.warn(`[代理池] 跳过候选代理: 期望=${country}, 查询出口=${result.country || '未知'}, 验证未通过`);
        } catch (_) { /* 不输出可能包含代理凭据的底层异常，继续验证下一条。 */ }
    }
    throw new Error(`代理池未找到出口国家为 ${country} 的代理（最多验证 5 条），请检查代理地区配置`);
}

module.exports = { selectRegionProxy };
