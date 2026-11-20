# Orbitcard 接入说明

本项目仅支持 Orbitcard HMAC V1。平台协议保留在 [Orbitcard-Open-API-V1.md](Orbitcard-Open-API-V1.md) 及其引用的 [订阅 API](orbitcard-subscription-api-v1.md)，充值状态、异常恢复和审计规则见 [RECHARGE-AUDIT.md](../architecture/RECHARGE-AUDIT.md)。本项目现有的 14 个出站操作均仍受文档支持；重构移除旧兼容分支和冗余字段，保留现有业务功能。

## 服务端配置

在服务器环境变量中填写平台签发且配对的 `ORBITCARD_API_KEY` 和 `ORBITCARD_API_SECRET`；后台填写 HTTPS 根域名、四档 USD 支付金额、默认充值地区及开卡策略，不接收或保存 API 凭据。`getProductCode` 只提供储值卡产品、库存和最低金额，不再提供套餐支付金额。后台为 Plus、Pro 100、Pro 200、Pro 500 分别配置实际所需 USD 支付金额；当前套餐未配置时停止新的代充，已提交订单仍可恢复查询。订阅目录中的 `service_fee` 是平台服务费，不能替代卡片支付金额。

后台可为四档套餐分别指定默认充值地区，选项由 `getSubscriptionPaymentRegions` 返回。选择「平台默认」则不传 `payment_region`；指定地区在资金操作前校验可用性，再传入 `createSubscription`。该设置同时适用于用户兑换和管理员开通，已提交订单仍只查询原单。地区接口没有保证返回地区价格，后台金额需要与实际支付地区相符。

选卡读取实时 ACTIVE 状态、USD 币种和余额，每张卡最多成功支付 3 次，满额后自动删卡并补开一张。现有卡目标余额为后台配置的套餐 USD 金额，不叠加开卡产品最低留存。余额足够的卡直接使用；不足时按本次套餐完整金额补款并向上取整到美分，不计算差额，账户可用余额不足则停止并提示联系客服。历史资金意图继续按已保存的目标余额、金额、正文和幂等键核对，不按新规则重充。新卡按 20.00 USD 首充检查账户资金，平台另行校验实际费用；不会因为账户余额低于整档套餐金额而拒绝一张余额已足够的卡。卡 ID 从 `getCardList` 自动读取，不填写固定卡 ID。

卡片可用性按实时平台状态、持久化停用标记、订单占用及资金条件判断。后台通过 `getProductCode` 读取开卡渠道（`product_code`）与 BIN，多选项保存在 `orbitcard_product_codes` 和 `orbitcard_bins`，同时选择取交集；这些偏好和产品规则仅用于手动开卡、错误补开与满额补开，不筛选现有卡池，现有卡支付准备和预检不查询开卡产品目录。旧单一产品配置迁移为单项选择。订阅明确出现卡片错误时停用原卡并自动补开，每张首充 20 USD；重试优先使用现有健康卡，不因开卡渠道或库存失败而阻断。管理员可在「卡片与开卡」填写原因后人工停用或恢复使用，操作需要二级验证并记录日志。详细规则见 [卡片可用状态与错误补开](../operations/ORBITCARD-CARDS.md#卡片可用状态与错误补开)。

成功会员订单计数继续通过 `getSubscriptionList` 与 `getSubscription` 核验，并按平台范围及唯一订单号去重保存，作为每卡三次成功上限的依据。选卡及预占读取独立的 `disabled_*` 停用记录。卡片错误会停用原卡并登记持久化补开申请；平台同步保留停用记录。消费授权流水继续用于独立对账，详情见 [卡片规则](../operations/ORBITCARD-CARDS.md)。

订阅调用需要 `subscriptions:read`、`subscriptions:create` 权限，余额查询另需 `account:read`。卡池还需 `cards:create`、`cards:read`、`cards:manage`、`products:read`、`cards:fund`；交易对账另需 `transactions:read`，不需要敏感卡资料。接口一键测试仅向平台发送读取请求，财务写操作只做本地参数与幂等键模拟，不创建订阅或开卡。卡片协议见 [Open API](Orbitcard-Open-API-V1.md)。

手动开卡、错误补开和满额补开均由服务端组装 `{product_code,amount:"20.00",quantity:1}`。渠道与 BIN 目录由 `GET /api/admin/orbitcard/products` 实时读取，后台保存多选数组，实际请求使用筛选后的产品码。补开按原卡与失败任务唯一登记，未知结果使用原正文、平台、API Key 和幂等键确认。人工状态修改使用 `POST /api/admin/orbitcard/cards/:cardId/availability`，提交 `{disabled:boolean,reason:string}`，需要二级验证。

项目向平台发送 `POST /api/open/v1/<operation>`，使用 HMAC-SHA256-V1 对精确请求字节、主机、路径、时间戳、随机数及幂等键签名，不使用旧充值 Bearer 协议。

`orbitcard-api-contract.js` 统一登记本项目使用的操作和允许的顶层字段；未知操作或旧参数在发送前被拒绝。`amount`、`max_service_fee` 必须是十进制定点字符串，写操作必须携带有效的原幂等键。订单归属、原 Body 和结果确认仍由业务服务校验。

## 用户入口

| 请求 | 用途 |
| --- | --- |
| `POST /api/verify-cdk`，`{cdk}` | 验证卡密、套餐和已有任务 |
| `POST /api/run-process`，`{cdk,session}` | 以完整 Session JSON 兑换 CDK |
| `POST /api/cdk/orbitcard/status`，`{cdk}` | 查询原订单，不创建新订阅 |
| `GET /api/cdk/query?cdk=...` | 只读查询卡密状态；客户端优先使用 POST 验证入口 |
| `GET /api/public/runtime` | 处理任务、并发容量，以及共享等待任务数量 |
| `GET /api/health` | 应用和数据库可用状态 |

提交示例：

```json
{
  "cdk": "YOUR-CDK",
  "session": "{\"user\":{\"email\":\"customer@example.com\"},\"account\":{},\"accessToken\":\"完整真实令牌\"}"
}
```

示例只说明外层格式，实际提交应复制目标账号的完整真实 Session，不要只构造示例字段。Session 不保存到新任务数据库，客户端也不应保存它。

任务受理返回 `provider=orbitcard` 和 `jobKey`；自助受理及查单中的 `queued` 布尔值标记当前是否排队，卡片准备时也可能进入等待，应持续查询原任务。已有历史未结算任务可能返回 `provider=history`，必须人工核对，不恢复本地支付。接单停用或配置缺失返回 503；并发名额满时可受理唯一共享等待任务，等待位已满才拒绝新增等待。已有请求优先恢复原任务。

用户兑换、管理员 `test` 和人工交付共用最多 1 个等待位，覆盖并发名额满及现有候选卡占用。等待沿用 `preparing` 状态与 `message`，保持原 CDK、管理员 `request_id` 和本次尝试身份，不生成新支付身份、不自动开卡或并行占用同卡。最长等待 30 分钟，卡片释放且本地停用标记、平台状态、余额及无未决资金等全部条件满足后自动继续，不等待消费授权同步，不读取历史 `reuse_after_ms` 值。Session 只在工作流内存中，按自身到期时间及等待截止检查，独立于管理员失败续试的 15 分钟缓存。等待超时、Session 到期或停机后，首笔未付款且无未决资金可安全释放，支付重试 CDK 保持售后锁定；重启复用原 `preparing` 恢复规则。

新增等待被同步拒绝时返回 HTTP 429，正文含 `error_code: "PAYMENT_QUEUE_FULL"`、`retry_after_seconds: 600`，并提供 `Retry-After: 600`。客户端对该错误展示“当前支付卡繁忙，等待队列已满，请 10 分钟后再下单。”弹窗；其他 API 限流仍按原错误处理。已受理任务的查询也可能带排队终止反馈，应先读取原状态和 `message`，不能按超时重复付款。

| `error_code` | 含义与客户端处理 |
| --- | --- |
| `PAYMENT_QUEUE_FULL` | 唯一等待位已满；弹窗提示 10 分钟后下单，`retry_after_seconds=600` |
| `PAYMENT_QUEUE_TIMEOUT` | 等待已超过 30 分钟；展示服务端原消息，`retry_after_seconds=600`，按原任务安全收尾结果处理 |
| `PAYMENT_QUEUE_STOPPED` | 服务停止导致等待结束；展示服务端原消息，再查询原任务，不假定未知资金已释放 |

`GET /api/public/runtime` 返回的 `runtime.active_foreground_jobs` 不包含等待者，`max_foreground_jobs` 仍表示执行容量；`waiting_jobs` 为当前等待数量，`max_waiting_jobs` 固定为 1。共享等待由固定 MySQL 命名锁保证唯一，无新增数据库字段或环境变量；部署仍要求单应用实例。

查单返回 `data.status`、`order_id`、`client_order_no`、`cdk_state` 和安全订单摘要。未知结果保留 CDK。`balance_blocked` 为失败但 CDK 锁定，`funding_pending` 为补款待确认；两者均不可重新兑换绕过。首笔准备任务在账户补足或后台确认卡准备后释放 CDK 并要求重新提交 Session；后续支付重试若准备中断则保留 CDK 转人工售后。存在验证任务时，`captcha` 只包含短时 HTTPS 链接及到期时间；不要持久化。

平台确认当前订阅终态失败且归属一致后，释放该卡，保留 CDK，最多换两张未使用过的现有卡，总计最多 3 次。仍有额度时为 `retry_waiting`；Session 有效自动继续，失效、丢失或重启后用原 CDK 和同账号新 Session 调用 `/api/run-process` 继续剩余额度。次数和已用卡持久化，不因重新提交或重启清零。自助用已有 retry 字段及子任务保留失败订单；`jobKey` 关联根任务，`attemptJobKey` 和 `attempt` 标识当前尝试。无可等待的合格现有卡、等待失败、重试准备失败或耗尽为 `support_locked`，保留 CDK 并提示售后 QQ 2244527967。错误说明由脱敏的 `order.failureCode`、`order.failureMessage` 返回。无可核验失败证据的旧 `retry_waiting` 不自动付款。请求异常、超时、未知结果或资金异常均不触发换卡，未知订阅只查原单。

## 管理入口

后台继续使用 `/api/admin/gpt-api` 配置路径，旧预算和地区字段不再读取或接受。「调试与日志 → 接口查询」通过「一键全部测试」顺序检查当前注册的 13 项接口，统一使用已保存配置。9 项只读操作实际请求平台，4 项财务写操作仅做本地请求参数与幂等键模拟；单项失败仍继续，展示分项模式、状态、耗时、摘要及总览，运行期间禁止重复发起。依赖卡片或原订单的读取自动选择现有记录；缺少依赖显示跳过，不能计为通过。模拟不发送平台，不能证明真实财务写权限或支付成功；不包含未接入的冻结、退款操作、Telegram 发送或真实支付。「支付预检与测试」提供 `POST /api/admin/orbitcard/diagnostics/preflight` 只读检查、并发模拟和唯一真实测试入口（模拟最多 1 个等待任务，其余需等待的任务为 blocked / queue_full）；真实测试复用 `POST /api/admin/manual/orders` 的 `test` 模式，不增加支付通道，手动开通页只留人工交付。「订单链路」集中管理员订单与 `GET /api/admin/orbitcard/diagnostics/logs/:jobKey?cursor=0` 日志查看，订单行保留快捷入口；另有「运行日志」「登录记录」，旧 `#logs` 转至运行日志。Telegram 发送测试在「接口查询」独立通知面板，使用已保存配置真实发送消息，设置页保留快捷入口；接口面板不执行真实财务写操作。一键接口测试使用管理员登录鉴权；支付预检、链路日志和真实支付仍需二级验证。CDK 行锁保护任务创建，卡片分配使用命名锁，每次尝试以固定订单号原子认领；未知结果只查原单。

一键接口测试使用以下管理路由：

- `GET /api/admin/orbitcard/diagnostics/interfaces` 返回 `{success:true,target,operations}`；`target` 是已保存的平台根域名，每项包含 `operation`、`path`、`label`、`mode`。
- `POST /api/admin/orbitcard/diagnostics/interface-test` 每次测试一项，仅接受 `{operation,card_id?}`。可选 `card_id` 仅适用于 `cardDetail`、`cardTransaction`、`getCardFlow`；不接受临时 URL、平台请求 Body 或 Session。未指定卡片时选当前平台本地非注销卡；一键流程也会使用卡片列表返回的 `summary.selected_card_id`。订阅查询自动选择当前平台及 API 身份下已提交的原订单，优先成功订单、其次最近订单；只读结果，不结算或恢复订单。

| 测试模式 | 当前注册接口 |
|---|---|
| `live_read`（9 项） | `getAccountBalance`、`getProductCode`、`getSubscriptionPlans`、`getSubscriptionPaymentRegions`、`getCardList`、`cardDetail`、`cardTransaction`、`getCardFlow`、`getSubscription` |
| `local_simulation`（4 项） | `createCard`、`rechargeCard`、`deleteCard`、`createSubscription` |

单项响应为 `{success:true,result}`。`result` 包含 `operation`、`path`、`label`、`mode`、`status`、`message`、`elapsed_ms`，按结果附带 `http_status`、`platform_code`、安全 `summary` 或 `checks`。`status` 为 `passed`、`failed` 或 `skipped`；外层 `success:true` 只表示测试完成返回，不能代替分项结果判断，跳过也不能算通过。地区接口对四档套餐各查询一次，明细放在 `checks`。本地写模拟返回 `summary.validation=request_contract` 和 `summary.sent_to_platform=false`，仅检查示例请求字段、金额格式及幂等键等本地契约，不验证真实平台权限；无需使用真实卡或用户 Session。参数非法返回 HTTP 400，测试服务不可用返回 HTTP 503。

`POST /api/admin/orders/:jobKey/refresh` 查询已有订单；`GET /api/admin/task-logs/:jobKey/audit` 下载日志。管理 HTTP 请求使用 `Authorization: Bearer <token>`，不接受 `?token=`；管理员令牌与供应商 HMAC 用途不同。`/api/admin/gpt-api/status` 仅返回套餐、余额及检查结果，不附带 `recent_orders`；订单页与原单查询保留。

管理员 `test` 与人工交付共用最多 3 次不同现有卡尝试。业务 `request_id` 不变，每次确认失败后才生成下一次 `client_order_no`；旧失败订单及用卡记录追加到 `retry_history`，返回 `attempt` 与 `attempts`，订单列表展示第 N / 3 次及历史用卡日志。第 2、3 次若尚在准备阶段，使用原请求恢复仍沿用当前尝试身份，不重置次数。启动自动迁移添加 `orbitcard_admin_orders.retry_history MEDIUMTEXT`。Session 只在内存保留最多 15 分钟、64 份，不写数据库、浏览器存储或日志；失效或重启后保留 `retry_waiting`，再次提交原 `request_id` 与同账号新 Session 继续剩余额度。资金未知、订阅未知、无卡或耗尽不会自动生成替代订单。

`POST /api/admin/orbitcard/cards/apply` 使用空 Body `{}`，为共享卡池申请一张卡，不再选择关联套餐。携带旧 `plan_type` 或其他自定义参数会返回 400。已有唯一手动申请时继续确认原请求；多笔申请或其他订单绑定的申请先通过 `POST /api/admin/orbitcard/issues/refresh` 恢复，不会换 key 新开卡。

`GET /api/admin/orbitcard/cards` 返回脱敏的 `cards`、`issues`、`fundings`；卡片条目包含 `max_successful_orders=3`、`quota_exhausted` 和 `remaining_successful_orders`，不再包含 `cooling_down` 和 `reuse_after_ms`。新建表与启动迁移不再补建 `reuse_after_ms`，历史已有列不主动 DROP，运行流程不再读写。只读预检维护摘要移除 `capacity_limit`、`auto_refill`、`open_count`、`opening_amount`，并发模拟移除 `summary.opening`，客户端应移除这些停用字段的依赖。

`POST /api/admin/orbitcard/issues/refresh` 核对原开卡及补款，已有申请沿用原身份；启用接单时也处理满三次卡片的删除和唯一补开。平台卡片同步、管理员手动申请及原申请核对继续保留；历史次数绑定和手动修改接口已删除，见 [卡片管理 API](ORBITCARD-CARDS.md#本项目管理-api)。旧本地 Stripe 卡池、代理、账单地址、验证码求解、浏览器池、Session 导出、支付链接生成、本地账单及开卡 Webhook 接口已移除，不提供充值回退路径。

选卡和同步使用 `cardDetail({card_ids:[...],reveal_sensitive:false})`，每批最多 20 张；缺项跳过对应卡，不在选中后逐张复核。成功授权按交易 ID 去重供对账。选卡读取本地停用记录，明确卡片错误会停用并补开；候选卡占用可使用共享等待位，未知状态和未决资金继续按原规则对账。换卡在纯选卡与最终事务预占中均排除已用卡。原开卡、补款和未确认订阅始终沿用原身份与参数，只有订阅明确失败且满足额度、账号及资金条件才允许下一次尝试。补款提交前及确认后核对卡片资金。`getSubscriptionPlans` 只确认套餐开放，目录服务费不参与预检或后台展示；`max_service_fee` 交平台校验，实际服务费留作对账。同一 API Key 收到 HTTP 429 后所有 Open API 操作遵守 `Retry-After`。`GET /api/admin/orbitcard/cards/:cardId/transactions?page=1` 更新授权次数并查看脱敏交易，不据此自动核销或退款；需 `transactions:read`。
