# Orbitcard 接入说明

本项目仅支持 Orbitcard HMAC V1。平台协议保留在 [Orbitcard-Open-API-V1.md](Orbitcard-Open-API-V1.md) 及其引用的 [订阅 API](orbitcard-subscription-api-v1.md)，充值状态、异常恢复和审计规则见 [RECHARGE-AUDIT.md](RECHARGE-AUDIT.md)。本项目现有的 13 个出站操作均仍受文档支持；重构移除旧兼容分支和冗余字段，保留现有业务功能。

## 服务端配置

在服务器环境变量中填写平台签发且配对的 `ORBITCARD_API_KEY` 和 `ORBITCARD_API_SECRET`；后台填写 HTTPS 根域名、四档 USD 支付金额、默认充值地区及开卡策略，不接收或保存 API 凭据。`getProductCode` 只提供储值卡产品、库存和最低金额，不再提供套餐支付金额。后台为 Plus、Pro 100、Pro 200、Pro 500 分别配置实际所需 USD 支付金额；当前套餐未配置时停止新的代充，已提交订单仍可恢复查询。订阅目录中的 `service_fee` 是平台服务费，不能替代卡片支付金额。

后台可为四档套餐分别指定默认充值地区，选项由 `getSubscriptionPaymentRegions` 返回。选择「平台默认」则不传 `payment_region`；指定地区在资金操作前校验可用性，再传入 `createSubscription`。该设置同时适用于用户兑换和管理员开通，已提交订单仍只查询原单。地区接口没有保证返回地区价格，后台金额需要与实际支付地区相符。

选卡读取实时 ACTIVE 状态、成功消费授权次数和余额，目标余额为后台 USD 支付金额加产品最低留存余额。余额足够的卡直接使用；余额不足则按真实差额补款，并向上取整到美分，账户余额只按此次所需补款金额检查。新卡按 20.00 USD 首充检查账户资金，平台另行校验实际费用；不会因为账户余额低于整档套餐金额而拒绝一张余额已足够的卡。卡 ID 从 `getCardList` 自动读取，不填写固定卡 ID。

所有套餐统一采用每卡 7 次成功消费授权上限，次数来自 `cardTransaction`，按交易 ID 持久去重；清算和本地开通结果不直接加次数。达限卡停止分配，空闲后删除且不补位，本地卡池不设数量上限。任何订单、后台维护和同步卡片都禁止自动开卡；管理员仍可手动申请，每张首充 20 USD。ACTIVE 和 CANCELLED 卡直接申请删除；未知结果保留原幂等键，仅通过 `cardDetail` 查询，确认 `DELETED` 后退役，不重复删卡或推测退款。未知授权状态或分页不完整暂停选卡，详见 [ORBITCARD-CARDS.md](ORBITCARD-CARDS.md)。

订阅调用需要 `subscriptions:read`、`subscriptions:create` 权限，余额查询另需 `account:read`。卡池还需 `cards:create`、`cards:read`、`cards:manage`、`products:read`、`cards:fund`；交易对账另需 `transactions:read`，不需要敏感卡资料。连接测试只查询套餐和余额，不创建订阅或开卡。卡片协议见 [Open API](Orbitcard-Open-API-V1.md)。

管理员手动申请时，服务端组装 `{product_code,amount:"20.00",quantity:1}`；产品码来自最新 `getProductCode` 的 `data.list`，不额外提交身份资料或卡号。产品查询的 `automatic_application` 字段仅是只读参数预览，不代表允许订单自动开卡；不再附带 `products[].plans`。手动申请不要求会员价格，CDK 代充需已配置套餐 USD 金额。历史自动申请仅在有平台 order_no 时按原平台、API Key、正文和幂等键核对；无订单号的未知申请不重发，prepared 未发送意图关闭为失败。详见 [开卡参数](ORBITCARD-CARDS.md#次数与卡池规则)。

项目向平台发送 `POST /api/open/v1/<operation>`，使用 HMAC-SHA256-V1 对精确请求字节、主机、路径、时间戳、随机数及幂等键签名，不使用旧充值 Bearer 协议。

`orbitcard-api-contract.js` 统一登记本项目使用的操作和允许的顶层字段；未知操作或旧参数在发送前被拒绝。`amount`、`max_service_fee` 必须是十进制定点字符串，写操作必须携带有效的原幂等键。订单归属、原 Body 和结果确认仍由业务服务校验。

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

平台确认当前订阅终态失败且归属一致后，释放该卡并冷却 5 分钟，保留 CDK，最多换两张未使用过的现有卡，总计最多 3 次。仍有额度时为 `retry_waiting`；Session 有效自动继续，失效、丢失或重启后用原 CDK 和同账号新 Session 调用 `/api/run-process` 继续剩余额度。次数和已用卡持久化，不因重新提交或重启清零。自助用已有 retry 字段及子任务保留失败订单；`jobKey` 关联根任务，`attemptJobKey` 和 `attempt` 标识当前尝试。无卡、重试准备失败或耗尽为 `support_locked`，保留 CDK 并提示售后 QQ 2244527967。错误说明由脱敏的 `order.failureCode`、`order.failureMessage` 返回。无可核验失败证据的旧 `retry_waiting` 不自动付款。请求异常、超时、未知结果或资金异常均不触发换卡，未知订阅只查原单。

## 管理入口

后台继续使用 `/api/admin/gpt-api` 配置路径，旧预算和地区字段不再读取或接受。「调试与日志 → 接口查询」提供 `/test` 连接测试、`/status` 套餐余额及 `GET /api/admin/orbitcard/payment-regions` 地区查询，查询不修改默认配置。「支付预检与测试」提供 `POST /api/admin/orbitcard/diagnostics/preflight` 只读检查、并发模拟和唯一真实测试入口；真实测试复用 `POST /api/admin/manual/orders` 的 `test` 模式，不增加支付通道，手动开通页只留人工交付。「订单链路」集中管理员订单与 `GET /api/admin/orbitcard/diagnostics/logs/:jobKey?cursor=0` 日志查看，订单行保留快捷入口；另有「运行日志」「登录记录」，旧 `#logs` 转至运行日志。Telegram 发送测试在「接口查询」独立通知面板，使用已保存配置真实发送消息，设置页保留快捷入口；卡台查询面板仍为只读。上述调试需二级验证。CDK 行锁保护任务创建，卡片分配使用命名锁，每次尝试以固定订单号原子认领；未知结果只查原单。

`POST /api/admin/orders/:jobKey/refresh` 查询已有订单；`GET /api/admin/task-logs/:jobKey/audit` 下载日志。管理 HTTP 请求使用 `Authorization: Bearer <token>`，不接受 `?token=`；管理员令牌与供应商 HMAC 用途不同。`/api/admin/gpt-api/status` 仅返回套餐、余额及检查结果，不附带 `recent_orders`；订单页与原单查询保留。

管理员 `test` 与人工交付共用最多 3 次不同现有卡尝试。业务 `request_id` 不变，每次确认失败后才生成下一次 `client_order_no`；旧失败订单及用卡记录追加到 `retry_history`，返回 `attempt` 与 `attempts`，订单列表展示第 N / 3 次及历史用卡日志。第 2、3 次若尚在准备阶段，使用原请求恢复仍沿用当前尝试身份，不重置次数。启动自动迁移添加 `orbitcard_admin_orders.retry_history MEDIUMTEXT`。Session 只在内存保留最多 15 分钟、64 份，不写数据库、浏览器存储或日志；失效或重启后保留 `retry_waiting`，再次提交原 `request_id` 与同账号新 Session 继续剩余额度。资金未知、订阅未知、无卡或耗尽不会自动生成替代订单。

`POST /api/admin/orbitcard/cards/apply` 使用空 Body `{}`，为共享卡池申请一张卡，不再选择关联套餐。携带旧 `plan_type` 或其他自定义参数会返回 400。已有唯一手动申请时继续确认原请求；多笔申请或其他订单绑定的申请先通过 `POST /api/admin/orbitcard/issues/refresh` 恢复，不会换 key 新开卡。

`GET /api/admin/orbitcard/cards` 同时返回脱敏的 `cards`、`issues`、`fundings`；`POST /api/admin/orbitcard/issues/refresh` 确认原开卡及补款，不创建新身份。提供平台卡片同步、申请卡与原申请确认接口；历史次数绑定和手动修改接口已删除，见 [卡片管理 API](ORBITCARD-CARDS.md#本项目管理-api)。旧本地 Stripe 卡池、代理、账单地址、验证码求解、浏览器池、Session 导出、支付链接生成、本地账单及开卡 Webhook 接口均已移除，不提供充值回退路径。

选卡和同步使用 `cardDetail({card_ids:[...],reveal_sensitive:false})`，每批最多 20 张；缺项跳过对应卡，不在选中后逐张复核。成功授权按交易 ID 去重，达 7 次停止分配，空闲时删卡，不补位；成功后新授权未同步也不得复用该卡。只用现有合格卡，缺卡不自动开卡；占用、冷却和未决资金按原规则等待。换卡在纯选卡与最终事务预占中均排除已用卡。原开卡、补款和未确认订阅始终沿用原身份与参数，只有订阅明确失败且满足额度、账号及资金条件才允许下一次尝试。补款提交前及确认后核对卡片资金。`getSubscriptionPlans` 只确认套餐开放，目录服务费不参与预检或后台展示；`max_service_fee` 交平台校验，实际服务费留作对账。同一 API Key 收到 HTTP 429 后所有 Open API 操作遵守 `Retry-After`。`GET /api/admin/orbitcard/cards/:cardId/transactions?page=1` 更新授权次数并查看脱敏交易，不据此自动核销或退款；需 `transactions:read`。
