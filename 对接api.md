# Orbitcard 接入说明

本项目仅支持 Orbitcard HMAC V1。平台完整协议保留在 [orbitcard-subscription-api-v1.md](orbitcard-subscription-api-v1.md)，充值状态、异常恢复和审计规则见 [RECHARGE-AUDIT.md](RECHARGE-AUDIT.md)。

## 服务端配置

在 `.env` 设置平台签发的 `ORBITCARD_API_SECRET`，后台设置配对 API Key、HTTPS 根域名和本人平台卡 ID，再启用新订单。平台卡 ID 为正整数，不是银行卡号。

订阅调用需要 `subscriptions:read`、`subscriptions:create` 权限，余额查询另需 `account:read`。连接测试只查询套餐和余额，不创建订阅。

项目向平台发送 `POST /api/open/v1/<operation>`，使用 HMAC-SHA256-V1 对精确请求字节、主机、路径、时间戳、随机数及幂等键签名，不使用旧充值 Bearer 协议。

## 用户入口

| 请求 | 用途 |
| --- | --- |
| `POST /api/verify-cdk`，`{cdk}` | 验证卡密、套餐和已有任务 |
| `POST /api/run-process`，`{cdk,session}` | 以完整 Session JSON 兑换 CDK |
| `POST /api/cdk/orbitcard/status`，`{cdk}` | 查询原订单，不创建新订阅 |
| `GET /api/cdk/query?cdk=...` | 只读查询卡密状态；客户端优先使用 POST 验证入口 |
| `GET /api/public/runtime` | 当前任务数量和并发容量 |
| `GET /api/health` | 应用和数据库可用状态 |

提交示例：

```json
{
  "cdk": "YOUR-CDK",
  "session": "{\"user\":{\"email\":\"customer@example.com\"},\"account\":{},\"accessToken\":\"完整真实令牌\"}"
}
```

示例只说明外层格式，实际提交应复制目标账号的完整真实 Session，不要只构造示例字段。Session 不保存到新任务数据库，客户端也不应保存它。

任务受理返回 `provider=orbitcard` 和 `jobKey`。已有历史未结算任务可能返回 `provider=history`，必须人工核对，不会恢复本地支付。接单停用或配置缺失返回 503；容量已满返回 429；已存在任务优先恢复原任务。

查单返回 `data.status`、`order_id`、`client_order_no`、`cdk_state` 和安全订单摘要。未知结果保留 CDK。存在验证任务时，`captcha` 只包含短时 HTTPS 链接及到期时间；不要持久化。

## 管理入口

后台继续使用 `/api/admin/gpt-api` 配置路径以兼容现有 Orbitcard 配置，`/test` 测试连接，`/status` 查询套餐、余额与最近订单。

`POST /api/admin/orders/:jobKey/refresh` 查询已有订单；`GET /api/admin/task-logs/:jobKey/audit` 下载任务日志。均需管理员认证。管理员自身的 Bearer 登录令牌与供应商 HMAC 协议用途不同。

卡池、代理、账单地址、验证码求解、浏览器池、Session 导出、支付链接生成、本地账单及开卡 Webhook 接口均已移除，不提供充值回退路径。
