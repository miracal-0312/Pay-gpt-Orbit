# dujiao-next 商城核销通知

支持向配套更新后的 `miracal-0312/dujiao-next` 主动发送核销凭证。商城卡密的 `used` 表示已发货，充值成功后另写 `redeemed_at` 和凭证编号，后台显示“充值已核销”；不改变商城原订单、发货和库存统计。

先部署商城接收端，在商城 `config.yml` 添加：

```yaml
card_redemption:
  enabled: true
  source: "pay-gpt-orbit"
  secret: "替换为两端相同的至少32字节随机密钥"
```

再在本程序原有 `.env` 中配置：

```dotenv
CDK_REDEMPTION_WEBHOOK_URL='https://你的商城域名/api/v1/card-secrets/redemption-callback'
CDK_REDEMPTION_SOURCE=pay-gpt-orbit
CDK_REDEMPTION_WEBHOOK_SECRET='替换为两端相同的至少32字节随机密钥'
```

用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成独立密钥，两端保存同一个值。商城也支持 `CARD_REDEMPTION_ENABLED`、`CARD_REDEMPTION_SOURCE`、`CARD_REDEMPTION_SECRET` 环境变量。商城库存每行必须是完整的单个 CDK，内容与充值系统一致，且对应库存已发货（`status=used`）；不存在、未发货、已删除或同码多行均不会自动更新。

充值端执行 `docker compose up -d --build --no-deps app` 更新（保留原 Compose 项目名）。启动会创建 `cdk_redemption_outbox` 通知表；商城正常启动迁移会在 `card_secrets` 增加核销字段和凭证唯一索引，需同时发布包含新显示字段的商城后台前端。无需修改 Session 或现有支付接口。

只有启用通知之后新确认成功的自助兑换、管理员人工交付，以及通过「修改状态」完成的人工售后核销才会生成凭证，不批量补发历史已核销记录。核销和凭证入队在同一事务提交；发送器每 5 秒检查队列，每个通知最多发送 3 次（首次发送 + 2 次重试），前两次失败分别等待至少 5 秒、10 秒后重试。累计达到 3 次后停止自动发送，保留通知记录、累计次数和最后错误用于排查，不撤销本地核销。次数保存在数据库中，服务重启或重复入队不会重置；升级前已累计发送 3 次及以上的未送达通知也会停止重试。无需新增数据库字段。商城按事件编号和卡密幂等确认。商城故障不释放已经核销的 CDK，也不会重新支付。

凭证请求为 JSON：`version=1`、`event_type=cdk.redeemed`、`event_id`、`source`、`cdk`、`order_id`、`redeemed_at`（RFC3339 UTC），不含 Session、账号邮箱或银行卡资料。`event_id` 为来源和 CDK 对应的稳定 SHA-256 标识，`order_id` 为充值端原业务订单编号。签名头 `X-Redemption-Timestamp` 为当前 Unix 秒，`X-Redemption-Signature` 为 `HMAC-SHA256(secret, timestamp + "." + 原始请求体)` 的小写十六进制摘要。商城校验签名、来源和 ±300 秒时差；重试保留同一凭证内容，刷新请求时间与签名。

只有商城返回 HTTP 200 且 `{"status_code":0,"data":{"event_id":"原事件编号","received":true}}` 才标记送达。HTTP 200 的错误页面、错误业务码、错误事件编号或重定向均不算成功。接收端默认关闭，不能把 GitHub 仓库地址当作商城回调地址。

排查未同步时，可在充值端数据库执行以下只读查询，不输出完整卡密或凭据：

```sql
SELECT event_id, source, attempts, last_error, delivered_at, created_at
FROM cdk_redemption_outbox ORDER BY created_at DESC LIMIT 50;
```

`http_404_not_acknowledged` 通常表示商城未部署该接口或卡密不存在；`http_409_not_acknowledged` 表示卡密尚未发货、同码多行或凭证冲突；401 检查两端密钥、来源标识和系统时间。修正后，累计发送不足 3 次的通知会自动重试；已达到上限的通知不会自动恢复。通知目标与来源在入队时固定，变更配置不会把历史队列转发给新商城；迁移域名需先处理原队列。停用 URL 会暂停新事件和发送，已保存事件保留。轮换密钥时先同步两端配置，暂时的验签失败会在 3 次总发送上限内自动重试。

返回[使用与后台管理](../operations/USER-GUIDE.md#状态与数据)。
