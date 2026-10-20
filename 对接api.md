# Orbitcard 代充接入说明

第三方代充统一使用 **Orbitcard HMAC V1**。完整接口、签名字段及响应语义以 [orbitcard-subscription-api-v1.md](orbitcard-subscription-api-v1.md) 为准。环境与部署步骤见 [DEPLOY.md](DEPLOY.md)，CDK 套餐映射见 [README.md](README.md#启用-orbitcard)。

## 配置位置

| 参数 | 设置位置 |
|------|----------|
| HMAC Secret | 服务端环境变量 `ORBITCARD_API_SECRET`，或项目根目录 `.env` |
| API 根域名 | 后台第三方代充配置，默认 `https://orbitcard.cc` |
| API Key | 同上，必须与服务端 Secret 配对 |
| 平台卡 ID | 同上，填写本人的正整数卡 ID |
| 支付地区、最高 USDT 服务费 | 同上，可选 |
| 是否接收第三方代充 | 同上，配置完整后启用 |

不在 `.env` 中配置 API Key、平台卡 ID 或开关。后台无需选择协议。更新 Secret 后裸机重启应用，Docker 执行 `docker compose up -d --force-recreate app`。

## 调用与权限

| 接口（均为 POST） | 用途 | 权限 |
|------------------|------|------|
| `/api/open/v1/getSubscriptionPlans` | 查询开放套餐 | `subscriptions:read` |
| `/api/open/v1/getSubscriptionPaymentRegions` | 查询当前套餐地区 | `subscriptions:read` |
| `/api/open/v1/createSubscription` | CDK 兑换时创建订阅 | `subscriptions:create` |
| `/api/open/v1/getSubscription` | 查询原订阅订单 | `subscriptions:read` |
| `/api/open/v1/getAccountBalance` | 后台余额展示 | `account:read` |

通过平台 `/api/open/v1/getCardList` 查找卡 ID 需要 `cards:read`，本项目后台需手工填写取得的 ID。

请求通过 `X-API-Key`、`X-Timestamp`、`X-Nonce` 和 `X-Signature` 鉴权，签名覆盖真实 JSON 请求体和下单幂等键。仅使用 HTTPS 根域名，不向旧代充服务发送请求。

## CDK 关联

开启开关或测试连接不会下单。用户提交有效 CDK 与完整 Session JSON 后，系统事务占用 CDK 并持久化本次客户订单身份，再向 Orbitcard 创建订阅。

成功核销；明确失败或明确拒绝释放；超时、断网及未知结果保留占用。刷新、重启和手动查询均查询原订单，不会创建替代订单。服务费状态独立于订阅结果。

结果查询入口为 `POST /api/cdk/orbitcard/status`，提交当前 CDK，由服务端查找对应订单。验证码入口按上游响应即时展示，不保存验证链接或 Orbitcard Session 到代充任务日志。

## 协议迁移

已有 Orbitcard 配置保留。尚未迁移的旧 Bearer 代充配置将停用并清空旧 Key，填写新参数后重新开启。旧 `/pay`、`/pay/inspect`、`/tasks` 客户端已移除；`gpt-api-client.js` 仅为 Orbitcard 客户端的兼容导出。

管理后台使用的 Bearer 登录令牌属于本项目自身认证，与第三方代充协议无关。
