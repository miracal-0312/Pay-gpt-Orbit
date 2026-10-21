# Orbitcard Open API

版本：V1

格式：JSON over HTTPS

签名：HMAC-SHA256

这份文件可离线保存或导入 Markdown 阅读器。字段、Scope 和业务规则以 Orbitcard 控制台内的 API 文档为准。

## 基础信息

- Base URL：`https://orbitcard.cc`
- 所有接口均使用 `POST`。
- 请求为 `application/json`，不接受 URL Query。
- 所有金额都以十进制定点**字符串**传递，例如 `"100.00"`。
- 每个响应均使用统一信封：`{ "code": 0, "msg": "ok", "data": {} }`。

## 认证与签名

在控制台创建 API Key 时会显示一次 Secret。请只从服务端环境变量读取 Secret，切勿放入客户端、日志或代码仓库。

### 公共请求头

| Header | 要求 | 说明 |
| --- | --- | --- |
| `X-API-Key` | 必填 | 在开发者页面创建的完整 API Key。 |
| `X-Timestamp` | 必填 | UTC Unix 秒；服务端允许 ±300 秒误差。 |
| `X-Nonce` | 必填 | 16–128 位 URL-safe 随机字符串；同一 Key 下 10 分钟内不得重复。 |
| `X-Signature` | 必填 | Canonical Request 的 HMAC-SHA256 小写十六进制摘要。 |
| `Idempotency-Key` | 按接口 | 写操作必填，8–128 字节；参与签名。 |

### Canonical Request

按以下 **10 行**严格拼接，末尾不要添加换行。即使没有 Query，空行也必须保留。

```text
ORBITCARD-HMAC-SHA256-V1
{api_key}
{timestamp}
{nonce}
{method}
{host}
{path}
{query}
{sha256_hex(raw_body)}
{idempotency_key}
```

`raw_body` 必须是实际发送的原始 JSON 字节；不要在签名之后再格式化、序列化或改变字段顺序。

### Python 请求示例

```python
import hashlib
import hmac
import json
import os
import secrets
import time
import requests

base_url = os.environ.get("ORBITCARD_BASE_URL", "https://orbitcard.cc").rstrip("/")
api_key = os.environ["ORBITCARD_API_KEY"]
secret = os.environ["ORBITCARD_API_SECRET"]
path = "/api/open/v1/getAccountBalance"
body = b"{}"
timestamp = str(int(time.time()))
nonce = secrets.token_urlsafe(24)
body_hash = hashlib.sha256(body).hexdigest()
canonical = "\n".join([
    "ORBITCARD-HMAC-SHA256-V1", api_key, timestamp, nonce,
    "POST", requests.utils.urlparse(base_url).netloc, path, "", body_hash, "",
])
signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()

response = requests.post(
    base_url + path,
    data=body,
    headers={
        "Content-Type": "application/json",
        "X-API-Key": api_key,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
    },
    timeout=30,
)
response.raise_for_status()
print(response.json())
```

## 通用约定

- Body 最大 1 MiB。未知字段、无效 JSON 或尾随第二个 JSON 值都会被拒绝。
- `card_id` 是 Orbitcard 返回的数字 ID，不是卡号或渠道内部 ID。
- Nonce 用于防重放；`Idempotency-Key` 用于安全重试，二者不能互相替代。
- 时间支持 RFC 3339 或常用日期时间格式。分页默认 `page=1`、`page_size=20`，单页最多 100 条。
- 除标注为幂等的接口外，不要因为网络超时盲目重新提交会产生资金或状态变更的请求。

GPT 自动订阅分发接口见 [订阅 API 文档](./orbitcard-subscription-api-v1.md)。

## 接口目录

| 分类 | 接口 | Path | Scope | 幂等键 |
| --- | --- | --- | --- | --- |
| 账户与产品 | 获取账号余额 | `/api/open/v1/getAccountBalance` | `account:read` | 否 |
| 账户与产品 | 获取卡产品码 | `/api/open/v1/getProductCode` | `products:read` | 否 |
| 卡生命周期 | 申请卡 / 批量开卡 | `/api/open/v1/createCard` | `cards:create` | 是 |
| 卡生命周期 | 卡详情 | `/api/open/v1/cardDetail` | `cards:read` | 否 |
| 卡生命周期 | 冻结 / 解冻卡 | `/api/open/v1/freezeCard` | `cards:manage` | 是 |
| 卡生命周期 | 删卡 | `/api/open/v1/deleteCard` | `cards:manage` | 是 |
| 卡生命周期 | 卡列表 | `/api/open/v1/getCardList` | `cards:read` | 否 |
| 储值资金 | 卡充值 | `/api/open/v1/rechargeCard` | `cards:fund` | 是 |
| 储值资金 | 卡退款 | `/api/open/v1/refundCard` | `cards:fund` | 是 |
| 交易数据 | 交易记录 | `/api/open/v1/cardTransaction` | `transactions:read` | 否 |
| 交易数据 | 获取卡流水 | `/api/open/v1/getCardFlow` | `transactions:read` | 否 |

## 账户与产品

### 获取账号余额

`POST /api/open/v1/getAccountBalance`

Scope：`account:read`

Body 为空或 `{}` 均可，签名必须使用实际发送的 Body。

`data` 包含 `available_balance`、`frozen_balance`、`total_balance`、`pending_deposit_amount`、`estimated_card_balance` 和 `updated_at`。金额均为字符串。返回的是统一账户汇总，渠道不会拆分展示。

### 获取卡产品码

`POST /api/open/v1/getProductCode`

Scope：`products:read`

Body 为空或 `{}`。`data.list[]` 包含：

- `product_code`：申请卡时使用的产品码。
- `bin`、`card_type`、`network`、`media`、`issuing_area`：卡产品属性。
- `remaining_open_card_num`、`open_card_inventory_mode`：当前可开卡余量与库存模式。
- `min_initial_amount`、`min_retained_balance`：最低首充与最低留存余额。
- `gpt_plan_prices[]`：该卡产品当前匹配的 GPT 套餐参考价格。
  - `id`：`go`、`plus`、`pro`、`pro_20x` 或 `pro_max`；其中三个 Pro 标识分别对应 Pro 100、Pro 200、Pro 500。
  - `name`：原始套餐名称。
  - `price`：USD 十进制定点金额字符串；`currency` 当前为 `USD`。
  - `source`：`transaction` 表示交易参考价，`config` 表示平台配置锚点。
  - `observed_at`：匹配付款观察时间；`updated_at`：价格锚点更新时间，首次配置时可能缺省。

仅返回可用的储值卡产品。库存、最低金额和最低留存余额可能变化，申请卡前请重新查询。

## 卡生命周期

### 申请卡 / 批量开卡

`POST /api/open/v1/createCard`

Scope：`cards:create`

`Idempotency-Key`：必填

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `product_code` | string | 是 | 从产品接口获得的储值卡产品码。 |
| `amount` | string | 是 | 初始充值金额，例如 `"100.00"`。 |
| `quantity` | integer | 否 | 默认 1；批量为 2–20。 |

```json
{"product_code":"YK537SAVE","amount":"100.00","quantity":3}
```

单卡响应返回 `order_no`、可选的 `card_id`、`product_code`、`initial_amount`、费用、扣款总额、`status`、`completed` 和时间字段。HTTP 200 / `code=0` 表示本次请求成功取得订单当前结果，**不保证已经开卡成功，也不保证已有 `card_id`**。

#### 开卡结果与完成标志

单卡异步开卡会在上游受理后等待本地订单完成，等待窗口最多约 24 秒；整个 HTTP 请求还包含校验、提交等耗时，可能更长。超过窗口仍返回当前订单，后台 worker 继续查询已绑定的上游任务。批量开卡不等待此窗口。不要依靠增加客户端超时时间来判断是否成功。

| `status` | `completed` | `card_id` | 调用方处理 |
| --- | --- | --- | --- |
| `success` 且有正整数 ID | `true` | 有 | 最终成功，保存 ID 并继续履约。 |
| `processing` / `pending_confirm` | `false` | 通常省略 | 处理中 / 等待确认，保留订单并重查。 |
| `created` / `validating` / `balance_locked` | `false` | 通常省略 | 已有订单，尚未完成，同样重查。 |
| `failed` / `refunded` | `true` | 通常省略 | 开卡未成功的终态；`refunded` 表示平台开卡资金已退回或解除冻结。 |
| 未知状态，或 `success` 却无有效 ID | `false` | 不确定 | 不履约、不自行退款；保留记录重查，持续异常时人工核对。 |

`completed` 是新增的订单完成标志，**完成不等于成功**。只有 `status=success` 且 `card_id` 为正整数才可以交付卡。`completed=false` 时新增 `retry_after_seconds: 5`，单位为秒，表示下次重查的建议最小间隔，并非完成时间承诺。终态省略此字段。现有 `status` 和 `card_id` 的省略规则保持不变；兼容旧版本时可按上述状态及 ID 判断，未知字段应忽略。

以下均为**合成示例**，展示接口序列化格式，不是任何生产订单的原始抓包。首次请求没有留存完整响应正文时，不能将根据代码推导出的 JSON 当作历史原始响应。

最终成功（HTTP 200）：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "order_no": "OC-EXAMPLE-ASYNC-001",
    "card_id": 42001,
    "product_code": "EXAMPLE-SAVE",
    "initial_amount": "20.00000000",
    "open_card_fee": "1.00000000",
    "recharge_fee": "0.00000000",
    "total_fee_amount": "1.00000000",
    "total_debit_amount": "21.00000000",
    "status": "success",
    "completed": true,
    "processed_at": "2026-10-16T00:00:33Z",
    "created_at": "2026-10-16T00:00:00Z"
  }
}
```

等待窗口结束、结果未确认（HTTP 200，`card_id` 和 `processed_at` 尚无值，故省略）：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "order_no": "OC-EXAMPLE-ASYNC-001",
    "product_code": "EXAMPLE-SAVE",
    "initial_amount": "20.00000000",
    "open_card_fee": "1.00000000",
    "recharge_fee": "0.00000000",
    "total_fee_amount": "1.00000000",
    "total_debit_amount": "21.00000000",
    "status": "pending_confirm",
    "completed": false,
    "retry_after_seconds": 5,
    "created_at": "2026-10-16T00:00:00Z"
  }
}
```

最终失败并退回/解冻开卡资金（现有订单响应形式仍为 HTTP 200 / `code=0`，并非统一改成 HTTP 错误）：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "order_no": "OC-EXAMPLE-FAILED-002",
    "product_code": "EXAMPLE-SAVE",
    "initial_amount": "20.00000000",
    "open_card_fee": "1.00000000",
    "recharge_fee": "0.00000000",
    "total_fee_amount": "1.00000000",
    "total_debit_amount": "21.00000000",
    "status": "refunded",
    "completed": true,
    "processed_at": "2026-10-16T00:00:33Z",
    "created_at": "2026-10-16T00:00:00Z"
  }
}
```

其他失败终态可返回 `status: "failed"`、`completed: true`。费用和 `total_debit_amount` 是原订单金额，不能凭这些字段推断当前净扣款。订单响应不会透出上游内部错误消息。

请求校验、权限、幂等冲突或服务异常另走错误信封，`data` 为 `null`。例如同一个 key 改变产品或金额会返回 HTTP 409：

```json
{"code":30004,"msg":"idempotency key conflict","data":null}
```

HTTP 错误表示这次请求未正常取得订单结果，不能一概推断已有订单最终失败。尤其网络超时、5xx、限流、认证重试失败和上述幂等冲突，都不能触发换 key 重开或直接退款。发生冲突应找回原参数，不能修改参数“试到成功”。

#### 用原请求可靠获取最终结果

1. 首次发送前，在调用方数据库中持久化业务订单 ID、所属平台用户、原 `Idempotency-Key`、原请求 Body（建议保存原始字节）和“等待确认”状态。不要只保存在进程内存中；同一业务订单只创建一次 key。
2. 向上述 createCard 路径发送 POST 请求。取得响应后立即保存平台 `order_no`、`status` 和有效的 `card_id`。若已保存过 `order_no`，后续响应必须是同一个订单；不一致时停止自动履约并人工核对。
3. 仅当 `status=success` 且有正整数 `card_id` 时，原子地补齐 ID 并标记成功，幂等地继续 CDK/卡交付，避免重复履约。仅 `failed` / `refunded` 进入最终失败处理；退款仍需结合资金记录，避免平台已退资金后调用方重复处理。
4. 对非终态，再次调用**同一个 createCard 接口**，使用原 key、原 `product_code`、原 `amount`、原 `quantity` 及原顺序。每次生成新的 `X-Timestamp`、`X-Nonce` 和 `X-Signature`；Canonical Request 的最后一行继续使用原 key。Nonce 不能复用。使用同一平台用户身份，不能改用其他用户重查。
5. 建议前台按 5、10、20、30、60 秒间隔退避，上限 60 秒，可增加 0–20% 的正向随机抖动；每次请求返回后再计时，并遵守返回的 `retry_after_seconds` 下限和限流要求。每笔订单只保留一个在途重查任务，避免紧密轮询和并发放大。
6. 前台等待预算耗尽（例如 2 分钟）后显示“处理中 / 等待确认”，保留全部原请求及已知 `order_no`，由持久化后台任务继续对账（例如每 1–5 分钟）。长时间未完成转人工核验并保留记录，不能因本地等待超时自动判失败、退款或更换 key 重开。
7. 网络断开或 HTTP 超时可能发生在上游受理之后。即使没有拿到平台 `order_no`，仍使用原 key 和原参数恢复结果。不要通过最新卡列表、时间接近或金额相同来猜测卡归属。`card_id` 只取该订单的确定关联。

原 key 重放读取同一持久化订单的最新结果；已受理任务不会因重放再次开卡、冻结或扣款，任务查询继续由 worker 负责。不要将幂等记录的内部过期时间当作允许换 key 的依据；未完成订单应持续保留原 key。此流程不需要新增订单查询接口，也不使用 `request_id` 替代幂等 key。控制台的 Shell、JavaScript、Python 开卡请求示例要求设置 `ORBITCARD_IDEMPOTENCY_KEY` 为已持久化的原 key；复制示例重查时也必须恢复原 Body，不要沿用另一订单的示例参数。

调用方可采用下面的单卡结果分类函数。它是接入示例，不代表平台已修改任何外部 Python 程序；请求发送、持久化、后台调度和幂等履约需由接入方实现。

```python
def classify_create_card(http_status, payload):
    # 错误响应不证明已有订单失败；保留原请求，按错误原因重查或人工处理。
    if http_status != 200 or not isinstance(payload, dict) or payload.get("code") != 0:
        return "reconcile_required", None
    order = payload.get("data")
    if not isinstance(order, dict) or not order.get("order_no"):
        return "reconcile_required", None
    status, card_id = order.get("status"), order.get("card_id")
    valid_id = type(card_id) is int and card_id > 0
    if status == "success" and valid_id and order.get("completed", True):
        return "success", order
    if status in {"failed", "refunded"} and order.get("completed", True):
        return "final_failure", order
    return "waiting_confirmation", order
```

`requests.Timeout`、`requests.ConnectionError` 或 JSON 解析异常也进入 `reconcile_required`，外层 CDK 日志应显示“等待确认/待对账”，不能统一记为“订单执行失败”。保存返回的订单后再安排下一次重查；成功后继续原业务订单履约。

#### 批量开卡的非终态

批量返回 `total`、`succeeded`、`failed` 与 `items[]`，每项独立处理。`items[].success=true` 及 `succeeded` 只表示该项调用取得了订单结果，既可能是处理中，也可能是成功或失败终态；它们不是实际开卡成功数量。每项的 `data` 使用上述完整单卡结构，包括 `completed`、`status`、可选 `card_id` 和非终态重查建议。`items[].success=false` 时使用 `error: {"code": ..., "msg": ...}`，没有 `data`，应区分请求错误和订单终态。

按 `index`（从 1 开始）及返回的 `order_no` 保存各项。重查时发送原批量 key 和**完整原 Body**，保持数量及顺序不变，不要仅发送未完成项或改成单卡请求。平台由原批量 key 派生稳定的子 key；已有订单各自返回最新结果，已完成项不会重复开卡或扣款。先前未创建订单的项仍可能重新执行校验和创建，因此每项业务意图必须继续保留。不要自行构造内部子 key，也不要因 `succeeded=total` 就将整批标记为开卡完成。

### 卡详情

`POST /api/open/v1/cardDetail`

Scope：`cards:read`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `card_id` | integer | 单卡查询的本地卡 ID；与 `card_ids` 二选一。 |
| `card_ids` | integer[] | 批量同步查询 1–20 张卡。 |
| `reveal_sensitive` | boolean | 是否请求完整卡资料，默认 `false`。 |

默认只返回脱敏卡号。完整 `card_number`、`cvv`、`expire` 仅在单卡模式、`reveal_sensitive=true` 且 API Key 同时具备 `cards:read` 与 `cards:sensitive` 时出现。敏感读取会被审计，所有开放 API 响应均禁止缓存。

### 冻结 / 解冻卡

`POST /api/open/v1/freezeCard`

Scope：`cards:manage`

`Idempotency-Key`：必填

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `card_id` 或 `card_ids` | integer / integer[] | 是 | 单卡或 1–20 张卡。 |
| `status` | string | 是 | `ACTIVE` 解冻；`CANCELLED` 冻结。 |

目标状态已存在时，不会重复调用上游。批量重试必须保持卡 ID、状态与顺序不变。

### 删卡

`POST /api/open/v1/deleteCard`

Scope：`cards:manage`

`Idempotency-Key`：必填

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `card_id` 或 `card_ids` | integer / integer[] | 是 | ACTIVE 状态的单卡或 1–20 张卡。 |

删除不可恢复。成功响应包含 `card_id`、`status: "DELETED"` 和 `refunded_amount`。ACTIVE 卡可直接删除；CANCELLED 卡需先解冻。存在未关闭授权或处理中资金订单时会被拒绝。

### 卡列表

`POST /api/open/v1/getCardList`

Scope：`cards:read`

可选筛选字段：`page`、`page_size`、`status`、`product_code`、`card_id`、`card_type`、`search`、`start_time`、`end_time`。

响应 `data` 包含 `list`、`page`、`page_size`、`total`。只返回未删除的储值卡和脱敏资料；`page_size` 最大 100。

## 储值资金

### 卡充值

`POST /api/open/v1/rechargeCard`

Scope：`cards:fund`

`Idempotency-Key`：必填

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `card_id` | integer | 单卡模式的本地卡 ID。 |
| `amount` | string | 单卡模式的充值金额。 |
| `items` | array | 批量 1–20 项；每项包含 `card_id` 和 `amount`，与单卡字段二选一。 |

```json
{"card_id":42,"amount":"50.00"}
```

响应会返回 `order_no`、`amount`、`fee_amount`、`total_debit_amount`、`status`、`processed_at`。批量时按输入顺序逐项返回；同一卡不能重复出现。重试时必须保持内容与顺序不变。

### 卡退款

`POST /api/open/v1/refundCard`

Scope：`cards:fund`

`Idempotency-Key`：必填

字段与充值相同：使用 `card_id` + `amount`，或传递 1–20 项的 `items` 批量请求。

```json
{"card_id":42,"amount":"20.00"}
```

响应包含 `order_no`、`amount`、`fee_amount`、`credit_amount`、`status` 和时间字段。仅 ACTIVE 储值卡可退款，平台会校验最低留存余额。`processing` 或 `pending_confirm` 表示系统仍在核验，必须复用原 `Idempotency-Key`，不要创建新请求。

## 交易数据

### 交易记录

`POST /api/open/v1/cardTransaction`

Scope：`transactions:read`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `card_id` | integer | 可选；不传时合并查询当前账户全部渠道。 |
| `page`、`page_size` | integer | 分页，单页最大 100。 |
| `transaction_type` | string | `Authorization`、`Settlement`、`Refund`、`Reversal` 或 `Chargeback`。 |
| `status`、`merchant` | string | 状态精确筛选、商户或描述模糊筛选。 |
| `start_time`、`end_time` | string | 授权时间范围。 |

`data.list[]` 包含交易 ID、卡 ID、脱敏卡号、交易类型与状态、授权/清算金额和币种、商户、MCC 及时间。`transaction_type` 不区分大小写，并兼容常用别名。

### 获取卡流水

`POST /api/open/v1/getCardFlow`

Scope：`transactions:read`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `card_id` | integer | 是 | 平台本地卡 ID。 |
| `type` | string | 是 | `recharge` 或 `refund`，不区分大小写。 |
| `page`、`page_size` | integer | 否 | 分页，单页最大 100。 |

这会返回平台账务订单，不是上游消费记录。响应 `data` 包含 `card_id`、`type`、`list`、`page`、`page_size`、`total`；每项含 `order_no`、金额、费用、状态和时间。消费、清算、撤销与拒付请使用交易记录接口。

## 错误与限流

HTTP 状态表达协议结果，JSON `code` 用于程序判断。

| HTTP 状态 | 含义 |
| --- | --- |
| 400 | 参数、Body、Query 或幂等键格式错误。 |
| 401 | 签名、时间戳、IP 白名单或 Nonce 校验失败。 |
| 403 | API Key 缺少接口所需 Scope。 |
| 404 | 卡片不存在或不属于当前用户。 |
| 409 | 相同幂等键对应了不同的业务请求。 |
| 413 | 原始请求 Body 超过 1 MiB。 |
| 429 | 请求过多；请遵循 `Retry-After` 后重试。 |
| 500 | 内部处理或上游调用失败。 |
| 503 | Nonce 或限流存储暂不可用。 |

```json
{"code":11000,"msg":"invalid params","data":null}
```

## 安全建议

- 生产环境必须使用 HTTPS。
- 按服务拆分 API Key，仅授予最小 Scope，并配置固定出口 IP。
- Secret、Canonical Request、完整卡号与 CVV 禁止写入日志。
- 客户端应在业务侧记录 `Request ID`、幂等键和订单号，方便排查与安全重试。
