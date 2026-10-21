# Orbitcard 选卡、自动补款与申请卡

## 规则

- Plus 一张平台卡最多成功充值 4 次。
- Pro 100、Pro 200、Pro 500 各自最多成功充值 1 次，互不占用对方额度。
- 同一卡可混用四种套餐，合计最多 7 次（4+1+1+1）。某套餐已满不影响其他套餐；历史次数确认后不提供清零或提高上限入口。历史 `pro_5x` 对应 Pro 100，`pro_20x` 对应 Pro 200。
- 每张卡同一时间只处理一笔充值。预占不是成功；等待上游、验证、超时和未知结果保持占用。明确失败或确认提交被拒绝后释放本次预占，不增加成功次数。
- 成功次数和占用持久化在 MySQL，刷新、重启或同步列表均不清零。卡片计次、任务结果和 CDK 结算在同一事务提交；重复成功响应不会重复计次。

## 充值选卡与支付换卡

```mermaid
flowchart TD
    A[验证 CDK 和完整 Session] --> B[事务创建任务并占用 CDK]
    B --> C[查询套餐与支付地区]
    C --> D{账户 available_balance 足够套餐金额}
    D -->|否| E[锁定 CDK 提醒联系管理员充值账户]
    D -->|是| F[读取产品 getCardList 和批量 cardDetail]
    F --> G{有 ACTIVE USD 资料完整 次数可用且未占用的卡}
    G -->|已有卡异常或占用| H[锁定 CDK 告知客户联系人工售后]
    G -->|无卡或当前套餐次数均已用尽| O[固定幂等键自动开卡 首充20美元]
    O --> P[确认新卡 ACTIVE 并登记次数]
    P --> I
    G -->|是| I[选择一张卡并预占 按需补款]
    I --> J[原子认领并提交 createSubscription]
    J --> K[持续查询原订单]
    K -->|成功| L[计次并核销 CDK]
    K -->|明确失败且未用完两次换卡| M[记录失败并排除该卡 新身份重试]
    M --> D
    K -->|第三张卡明确失败| H
    K -->|结果未知| N[保留卡与 CDK 只查询原订单]
    N --> K
```

先调用 `getAccountBalance`，只用 `available_balance` 判断账户是否达到套餐单次 USD 金额；不足时停止并锁定 CDK，提示联系管理员手动充值。随后读取产品目录、`getCardList` 和批量 `cardDetail(card_ids)`，每批最多 20 张；仅从本轮批量结果中选择状态 `ACTIVE`、USD、余额资料有效、已确认历史次数、当前套餐次数未满且未被任务占用的卡。批量详情缺少个别卡时跳过缺项并选其余合格卡，不逐张补查；若有剩余次数的卡却因状态、资料或详情异常不可用，锁定 CDK 并提示人工售后。卡池为空或当前套餐次数全部用尽时自动开卡。批量返回外来或重复卡 ID 时停止选卡并锁定 CDK；平台网络或认证故障则按接口故障处理，不假定卡片可用。

合格卡按所需补款差额排序，预占一张；余额不足时调用 `rechargeCard` 补到「套餐金额 + 产品最低保留余额」。补款提交前及补款确认后仍按原补款意图核对卡片状态和余额，避免重复资金操作。选卡完成后不再额外逐张复核候选卡，也不在 `createSubscription` 前再次调用单卡详情。订阅已提交或结果未知时，只核对原订单，绝不因为超时换卡重付。

只有平台订阅详情明确确认失败、订单归属一致时，才释放失败卡的预占并创建新订单。下一次重新读取平台列表与批量详情，排除已失败卡，最多换两次，即三张不同卡各支付一次。若没有其他可用的旧卡，可按同一规则自动开新卡；已有卡异常或占用时转人工售后。第三张卡也明确失败则锁定 CDK。每笔失败订单及卡片 ID 保留审计记录；重启后继续尝试需要原目标账号的新 Session。成功次数仅在订阅成功时增加。

## 卡片预算、补款与自动开卡

套餐金额优先取产品目录中对应的 USD 单价；目录未提供时，管理员必须配置该套餐的 USD 单次预算。服务费不替代套餐金额。`rechargeCard` 的金额为 `max(0, 套餐金额 + 最低保留余额 - 卡片可用余额)`，用定点十进制向上取整到美分。补款意图、原订单号、请求正文、幂等键及 API Key 身份在发送前持久化；结果未知时只确认原补款，不重复扣款，也不切换卡。

自动或管理员手动申请卡时，实时调用 `getProductCode` 选择符合库存及最低首充要求的产品，向 `createCard` 仅发送 `product_code`、`amount:"20.00"`、`quantity:1`。自动申请先把原请求正文、产品、金额、API Key 身份及固定幂等键落库并绑定 CDK；结果未知时只确认原申请，不换键重复开卡。新卡确认 `ACTIVE` 后登记独立套餐次数，余额不足则按原补款规则补差额，再提交订阅。单卡首充上限只约束首次开卡充值；开卡产品码及各套餐 USD 预算可在后台配置。

Plus 每卡最多成功 4 次；Pro 100、Pro 200、Pro 500 各最多成功 1 次，四项独立计数且可混用。历史卡需管理员确认已有次数后参与选卡。同步平台卡片不会重置计数或卡片占用。

## 管理后台与已有卡迁移

「卡片与开卡」提供：同步平台卡片、查看状态/尾号/余额、四项成功次数与占用、查询产品与预算、手动申请首充 20 USD 的卡，以及确认原开卡/补款。「Orbitcard 配置」可在保存 API Key 与根域名后读取四档套餐各自的可用支付地区。补款记录显示任务、卡 ID、原订单、金额、费用和目标余额。CDK 列表标识账户余额不足锁定。

历史卡片的订阅使用次数不能从卡片列表可靠推断，因此同步后保持“历史未确认”。管理员通过二级验证，如实分别填写 Plus、Pro 100、Pro 200、Pro 500 的历史成功次数，卡片才参与自动选卡。不要把已使用的卡当成全新卡填写 0。尚有旧版本未绑定卡片身份的未确认充值时，先查清原订单，再确认历史次数。

原固定 `orbitcard_card_id` 配置保留为历史兼容数据，不再作为充值卡源，不会自动将其次数视为 0。旧订单仍查询其原平台身份。原开卡订单明确成功的新卡自动登记四项零历史次数，不需要人工操作。

手动申请卡、历史次数确认均要求管理员登录和二级验证；自动申请由已接单的兑换任务触发。同步只读取摘要，不引入本地 Stripe 卡池和浏览器支付逻辑。

## 平台 API 与权限

全部使用现有 HMAC V1 凭据及 HTTPS 根域名：

| POST 接口 | 请求 |
| --- | --- |
| `/api/open/v1/getAccountBalance` | `{}`；只读 `available_balance` 用于资金门槛 |
| `/api/open/v1/getProductCode` | `{}`，产品、库存、最低首充及保留余额；不保证返回会员价格 |
| `/api/open/v1/getCardList` | `{page,page_size}`，完整分页读取卡片 |
| `/api/open/v1/cardDetail` | 选卡和同步用 `{card_ids:[...],reveal_sensitive:false}` 分批最多 20 张；选中卡提交前用 `{card_id,reveal_sensitive:false}` 再读摘要 |
| `/api/open/v1/createCard` | `{product_code,amount,quantity:1}`；固定 `Idempotency-Key` |
| `/api/open/v1/rechargeCard` | `{card_id,amount}`；只补差额，固定 `Idempotency-Key` |
| `/api/open/v1/getCardFlow` | `{card_id,type:"recharge",page,page_size}`；匹配原补款订单号 |
| `/api/open/v1/cardTransaction` | `{card_id,page,page_size}`；管理员查询脱敏消费交易，只读对账 |

API Key 需要 `subscriptions:read`、`subscriptions:create`、`account:read`、`cards:create`、`cards:read`、`products:read`、`cards:fund`（卡资金，用于补款）及 `transactions:read`（补款流水和消费交易只读核对）。无需敏感资料或卡状态管理权限；不调用冻结、退款或完整卡资料接口。HTTP 429 后同一账户的 Open API 请求共享冷却时间，遵守 `Retry-After`；认证或权限不足时后台给出明确提示。

卡片接口以用户提供的 [Orbitcard-Open-API-V1.md](Orbitcard-Open-API-V1.md) 为准，订阅以 [订阅文档](orbitcard-subscription-api-v1.md) 为准。产品预算策略参考 [jiangdengke/KC-PAY-GPT](https://github.com/jiangdengke/KC-PAY-GPT/blob/5588b370e70253fca99d297aa950f9abf0c93957/orbitcard-client.js)，保留 MIT 版权说明；次数规则按本项目要求独立计数。上线前用自己的平台账户核对实际价格和费用。

## 本项目管理 API

| 路径 | 用途 |
| --- | --- |
| `GET /api/admin/orbitcard/cards` | 本地卡片摘要、最近 100 条开卡和补款记录；不返回原始请求或凭据哈希 |
| `POST /api/admin/orbitcard/cards/sync` | 同步卡片列表及非敏感详情；不重置次数 |
| `GET /api/admin/orbitcard/products` | 查询产品、套餐单价和首充预算，返回 `automatic_application` 与 `application_error`；只读预览不实际开卡 |
| `GET /api/admin/orbitcard/payment-regions` | 按四档套餐查询可用支付地区及平台默认标记；只读，使用后台已保存的 API 配置 |
| `POST /api/admin/orbitcard/cards/:cardId/bind` | `{usage:{plus:0,pro100:0,pro200:0,pro500:0}}`；一次性确认历史，需二级验证 |
| `GET /api/admin/orbitcard/cards/:cardId/transactions?page=1` | 管理员只读查询该卡脱敏消费交易；每页 50 条，不获取完整卡号、CVV 或 Session |
| `POST /api/admin/orbitcard/cards/apply` | `{plan_type:"plus"或"pro100"或"pro200"或"pro500"}`；需二级验证 |
| `POST /api/admin/orbitcard/issues/refresh` | 确认已有原开卡及补款，不创建新的申请身份 |

新表 `orbitcard_managed_cards`、`orbitcard_card_uses`、`orbitcard_card_issues`、`orbitcard_card_fundings`，以及任务字段 `orbitcard_card_id`、`orbitcard_issue_key`、`orbitcard_required_balance` 自动增量创建。旧表不删除。分配使用 MySQL 命名锁串行处理同一平台的选卡、开卡和补款；订阅提交前以任务状态和固定订单号在事务内原子认领，只有成功认领的执行者可调用 `createSubscription`。任务仍只支持单应用实例运行。

请求开始/结束、开卡意图、申请结果、卡片预占均进入每日审计日志；与兑换关联的事件同时进入该任务日志。数据库保存申请原身份和每笔卡片预占/结算状态。只保存卡 ID、尾号和安全摘要，完整 Session、卡号/CVV、API 密钥及签名不写入这些新表和日志。

模拟测试覆盖额度、并发预占、原申请恢复、失败回滚、幂等计次和后台权限；不发起真实开卡或充值，不能替代部署后的 MySQL、平台字段和权限验证。
