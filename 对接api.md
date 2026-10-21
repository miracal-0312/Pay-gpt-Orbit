# Orbitcard 接入说明

本项目仅支持 Orbitcard HMAC V1。平台完整协议保留在 [orbitcard-subscription-api-v1.md](orbitcard-subscription-api-v1.md)，充值状态、异常恢复和审计规则见 [RECHARGE-AUDIT.md](RECHARGE-AUDIT.md)。

## 服务端配置

在服务器环境变量中填写平台签发且配对的 `ORBITCARD_API_KEY` 和 `ORBITCARD_API_SECRET`；后台只填写 HTTPS 根域名及开卡策略，不接收或保存 API 凭据。四档套餐金额只采用 `getProductCode` 返回的对应 USD 推荐价；接口未返回价格时停止自动充值。订阅下单始终省略 `payment_region`，由平台选择默认地区；地区接口仅供只读调试。新充值先查询 `available_balance`，不足套餐金额即失败并锁定 CDK；再查卡片实时 ACTIVE 状态与次数。旧卡不足自动补差额，无符合次数条件的卡时首充 20 USD 开卡并按需补款；卡 ID 从 `getCardList` 自动读取，不填写固定卡 ID。同一卡 Plus 4 次、Pro 100/200/500 各 1 次，独立计数且允许混用。历史卡需同步后确认四项历史次数，详见 [ORBITCARD-CARDS.md](ORBITCARD-CARDS.md)。

订阅调用需要 `subscriptions:read`、`subscriptions:create` 权限，余额查询另需 `account:read`。新增 `cards:create`、`cards:read`、`products:read`、`cards:fund`、`transactions:read`；不需要敏感卡资料。连接测试只查询套餐和余额，不创建订阅或开卡。卡片协议见 [Open API](Orbitcard-Open-API-V1.md)。

开卡仅自动提交 `{product_code,amount:"20.00",quantity:1}`；产品码来自开卡前最新 `getProductCode`，不额外提交身份资料或卡号。后台产品查询返回只读 `automatic_application` 预览；单独申请卡不要求会员价格，CDK 兑换需产品目录返回对应套餐金额。详见 [开卡参数](ORBITCARD-CARDS.md#开卡参数自动获取与提交)。

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

查单返回 `data.status`、`order_id`、`client_order_no`、`cdk_state` 和安全订单摘要。未知结果保留 CDK。`balance_blocked` 为失败但 CDK 锁定，`funding_pending` 为补款待确认；两者均不可重新兑换绕过。首笔准备任务在账户补足或后台确认卡准备后释放 CDK 并要求重新提交 Session；后续支付重试若准备中断则保留 CDK 转人工售后。存在验证任务时，`captcha` 只包含短时 HTTPS 链接及到期时间；不要持久化。

平台确认订阅终态失败后，同一 CDK 最多发起三笔独立订单，每笔使用不同卡；仅平台明确确认订阅失败后才换卡。查询结果中的 `attempt` 为当前尝试序号，`jobKey` 始终指向首笔任务以方便前台追踪，`attemptJobKey` 为本笔任务。已确认失败的每笔订单均保留日志；第三张卡失败转 `support_locked` 并保留 CDK，提示人工售后。`retry_waiting` 表示服务重启后需对原目标账号重新提交最新 Session；请求异常或结果不明不会启动下一笔。

## 管理入口

后台继续使用 `/api/admin/gpt-api` 配置路径；旧预算和地区字段不再读取或接受。后台「接口调试」分别展示 `/test` 连接测试、`/status` 套餐与余额、`GET /api/admin/orbitcard/payment-regions` 四档地区查询结果。地区查询不参与订阅下单。CDK 行锁保护新任务创建，卡分配使用 MySQL 命名锁，提交订阅前以任务状态和固定订单号原子认领；未知结果只查原单。

`POST /api/admin/orders/:jobKey/refresh` 查询已有订单；`GET /api/admin/task-logs/:jobKey/audit` 下载任务日志。均需管理员认证。管理员自身的 Bearer 登录令牌与供应商 HMAC 协议用途不同。

`GET /api/admin/orbitcard/cards` 同时返回脱敏的 `cards`、`issues`、`fundings`；`POST /api/admin/orbitcard/issues/refresh` 确认原开卡及补款，不创建新身份。新增平台卡片同步、历史次数绑定、申请卡与原申请确认接口，见 [卡片管理 API](ORBITCARD-CARDS.md#本项目管理-api)。旧本地 Stripe 卡池、代理、账单地址、验证码求解、浏览器池、Session 导出、支付链接生成、本地账单及开卡 Webhook 接口均已移除，不提供充值回退路径。

选卡和同步使用 `cardDetail({card_ids:[...],reveal_sensitive:false})`，每批最多 20 张；缺项跳过对应卡，不在选中后逐张复核。无卡或当前套餐次数用尽时自动调用 `createCard`，已有次数的卡异常时转人工售后。补款提交前及确认后仍核对卡片资金。`getSubscriptionPlans` 只确认套餐开放，目录服务费不参与本地支付预检或后台展示。后台若设置最高服务费，下单时仍传 `max_service_fee` 交由平台校验；订单结果中的实际服务费保留用于对账。同一 API Key 收到 HTTP 429 后所有 Open API 操作共同遵守 `Retry-After`。管理员可用 `GET /api/admin/orbitcard/cards/:cardId/transactions?page=1` 查询脱敏交易用于只读对账，不据此自动核销或退款。
