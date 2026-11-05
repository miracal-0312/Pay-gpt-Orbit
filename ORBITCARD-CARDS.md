# Orbitcard 选卡、自动补款与卡池维护

## 次数与卡池规则

所有套餐共用每张卡 **6 次成功清算**的使用限制。每次同步、选卡时读取 cardTransaction 的完整分页，统计成功 Settlement 记录；Authorization、Refund、Reversal、Chargeback 及失败记录不计入。已移除旧套餐计数的生产读写，已有数据库中的旧字段仅保留历史数据。历史卡无需人工登记，手动登记和修改次数接口已删除。

成功状态支持 success、successful、settled、completed、settlement，不区分大小写。未知类型、未知清算状态、缺少交易 ID、归属不符、分页重复或总数变化均停止维护，不能当作零次使用。平台协议未枚举全部状态；部署时应核对实际返回值，未识别状态需要补充明确映射后接入。

达到 6 次后停止分配，卡片没有本地任务占用时执行 deleteCard。冻结的 CANCELLED 卡先通过 freezeCard 解冻。平台仍有未关闭授权或处理中资金订单时可能拒绝删除；保留原删卡身份供后续重试，未确认删除不补位。

启用接单后，卡池目标为 **5 张未删除卡片**，占用中、冻结及待删卡均占用容量。不足时逐张开卡，每张首充 20 USD；余额不足或申请未确认时停止，下一轮恢复原申请。旧卡池超过 5 张时优先删除使用次数较多的空闲卡，忙碌卡等待任务完成。后台每分钟、同步卡片及支付选卡时执行维护。关闭接单时同步仅刷新状态和次数。

开卡和删卡意图在远程写入前保存，超时复用原请求正文及幂等标识。删卡标识绑定 API Key 身份，切换凭据不会继续旧身份的删除请求。卡池维护和分配共用 MySQL 分配锁，避免并发补卡超额。

## 卡片读取与选卡

getCardList 完整分页读取卡片；cardDetail 以 card_ids 分批读取，每批最多 20 张，reveal_sensitive 始终为 false。兼容批量 items/data 结构并校验内外卡 ID、重复 ID 和逐项成功状态。只保存脱敏尾号、状态、余额等摘要，不获取完整卡号或 CVV。

实际支付先检查账户 available_balance 及产品的套餐 USD 推荐价格，再刷新平台卡片和交易次数。只选择 ACTIVE、USD、资料齐全、成功清算不足 6 次、没有待删标记且没有其他任务占用的卡。按所需补款差额排序，优先使用余额充足的卡；不足时补到套餐金额加产品最低留存余额。卡池已满但没有可用卡时停止，不额外开第六张卡。

每卡同一时间只处理一笔充值。未知订阅结果保留预占；明确终态通过原有事务结算 CDK 和释放占用。订阅成功不直接修改平台清算计数，下一次平台读取更新次数，因此清算尚未出现时不会提前当作已清算。订单与卡片预占账本继续记录原订单结果，成功清算计数仅由平台交易读取更新。

任务已有补款或任务绑定的开卡申请时先核对原申请，不能换卡重复支付。卡池补卡使用独立的申请，不绑定某一 CDK。任务转人工后不再自动提交订阅或补款；独立卡池维护仍可运行。已提交的原订阅只查询原单。尚未转人工且明确支付失败时仍按原规则最多尝试三张不同卡，不会因重试突破卡池容量。

## 后台与数据库

“刷新本地记录”只显示缓存，并标注本地快照；“同步平台卡片”会执行上述卡池维护，可能发生删卡和开卡。“成功清算次数”展示统一的 N / 6。“查看交易”读取完整分页更新统计，同时展示指定页的脱敏交易；不据此自动核销 CDK 或退款。该查询不直接删卡，后续同步或后台维护处理。

启动自动新增 orbitcard_managed_cards.transaction_count、transactions_checked_at、retirement_key 三个字段。新安装不再创建旧计数字段、active_plan 或次数修改审计表；升级不删除已有历史数据，不将旧套餐计数迁移为平台次数。读取失败不能用旧计数继续本次分配。平台详情缺项保留旧快照并标记未同步；占用信息不会因同步清除。

## 平台 API 与权限

沿用 HTTPS 和 HMAC V1 凭据。除原有 subscriptions:read/create、account:read、cards:create/read/fund、products:read 外，必须提供 transactions:read 和 cards:manage。

| POST 接口 | 用途 |
| --- | --- |
| getCardList | 完整卡片库存 |
| cardDetail | 脱敏状态和余额 |
| cardTransaction | 全分页成功清算计数及交易对账 |
| getProductCode | 产品、套餐推荐价、库存和最低余额 |
| getAccountBalance | 账户可用余额 |
| createCard | product_code、amount:20.00、quantity:1，固定幂等键 |
| rechargeCard / getCardFlow | 补差额及原资金订单确认 |
| freezeCard | 待删冻结卡解冻，固定幂等键 |
| deleteCard | 删除达限或超出池容量的空闲卡，固定幂等键 |

API 约定见 [平台协议](Orbitcard-Open-API-V1.md) 和 [订阅协议](orbitcard-subscription-api-v1.md)。HTTP 429 使用账户级冷却和 Retry-After；权限不足、未知返回值和资金不足会停止相关动作，保留日志供核对。

## 本项目管理 API

| 接口 | 行为 |
| --- | --- |
| GET /api/admin/orbitcard/cards | 本地卡片快照、统一次数、开卡和补款记录 |
| POST /api/admin/orbitcard/cards/sync | 刷新平台次数并维护五张卡池 |
| POST /api/admin/orbitcard/cards/apply | 二级验证后申请一张卡；池满拒绝 |
| GET /api/admin/orbitcard/cards/:cardId/transactions?page=1 | 更新平台计数，展示每页 50 条脱敏交易 |
| POST /api/admin/orbitcard/issues/refresh | 恢复原开卡和补款申请 |

## 验证

运行 npm test。card-pool.node.cjs 覆盖六次边界、全分页统计、授权清算去重、空池补到五张、并发同步、忙碌卡、删卡超时、开卡身份恢复、读取失败和冻结卡删除。测试使用模拟 MySQL 和上游，不执行真实开卡、充值或删除；上线仍需验证实际平台状态字段、权限和数据库迁移。
