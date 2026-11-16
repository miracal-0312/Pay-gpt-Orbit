# Orbitcard 订阅充值 API V1

本接口支持 ChatGPT 与 Grok，共用订单、鉴权和费用流水，通过 `service_code` 区分服务。2026-09-08 起的新收费政策为 `success_debit_v1`：创建、等待、失败和请求超时均不预占余额；只有上游明确 `succeeded` 后，才按创建时固定的服务费从可用余额扣款一次。服务费扣款失败不改变订阅成功结果。历史订单固定为 `legacy`，已释放费用不追扣。

现有支付流程仍需调用用户自己的有效卡 ID 和对应服务的登录凭据（ChatGPT 完整 Session，Grok 原始 SSO / Cookie / JSON）。卡片用于现有订阅支付流程；`service_fee` 仅表示平台使用费。本页不提供充值接口。平台服务费为 USDT 十进制字符串；查询结果中的 `payment.amount` 是订阅支付金额的 JSON 数字，币种以 `payment.currency` 为准。

订阅 API 默认开启：未单独配置的新老用户均可使用 GO、Plus、Pro 100、Pro 200 及 250/500/1000/2500 点数套餐，处理中 API 订单并发上限为 5。超管可在「分发客户」停用用户或调整套餐与并发上限；已保存的停用和限制继续生效。用户仍需创建 API Key 并勾选订阅权限，旧密钥不会自动增加权限。Secret 仅创建时显示一次。

## 认证与签名

在控制台创建 API Key 时会显示一次 Secret。请只从服务端环境变量读取 Secret，切勿放入客户端、日志或代码仓库。

### 公共请求头

| Header | 要求 | 说明 |
| --- | --- | --- |
| `X-API-Key` | 必填 | 在开发者页面创建的完整 API Key。 |
| `X-Timestamp` | 必填 | UTC Unix 秒；服务端允许 ±300 秒误差。 |
| `X-Nonce` | 必填 | 16–128 位 URL-safe 随机字符串；同一 Key 下 10 分钟内不得重复。 |
| `X-Signature` | 必填 | Canonical Request 的 HMAC-SHA256 小写十六进制摘要。 |
| `Idempotency-Key` | 按接口 | 创建订阅必填，8–128 字节；参与签名。小助手接口不要求。 |

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


## 接口与权限

平台开放 API 均为 POST，JSON 请求体，不接受 URL Query。平台的详情接口内部只调用上游 GET；不会再次建单、支付或操作自动续费。Base URL 使用你的平台实际域名。

| Path | Scope | 请求体 |
| --- | --- | --- |
| `/api/open/v1/getSubscriptionPlans` | `subscriptions:read` | `{}` 默认查询 GPT；Grok 用 `{"service_code":"grok"}`，全部服务用 `{"service_code":"all"}` |
| `/api/open/v1/getSubscriptionCatalog` | `subscriptions:read` | `{}` 默认查询 GPT；支持同上 `service_code` 选项 |
| `/api/open/v1/getSubscriptionPaymentRegions` | `subscriptions:read` | `{"plan_type":"gpt-plus"}` |
| `/api/open/v1/createSubscription` | `subscriptions:create` | 见下方；必须带 Idempotency-Key |
| `/api/open/v1/getSubscription` | `subscriptions:read` | `{"task_no":"平台订单号"}` 或 `{"client_order_no":"客户订单号"}`，或 `{"orderId":"平台订单号"}`，三选一 |
| `/api/open/v1/getSubscriptionList` | `subscriptions:read` | `{"page":1,"page_size":20,"status":"succeeded","plan_type":"gpt-plus"}`；均可省略 |
| `/api/open/v1/getAccountBalance` | `account:read` | `{}`；沿用原有余额接口 |

返回统一为 `{ "code": 0, "msg": "ok", "data": ... }`。HTTP 成功还需检查业务 code；受理下单还需查询订单最终状态。

目录 `data` 包含 `enabled`、`tier_id`、`tier_name` 和 `plans:[{type,name,category,service_fee,fee_configured}]`。用户目录只读取 Orbitcard 本地已上架、上游可用且当前客户档位已定价的套餐，并遵循套餐权限；读取目录不会触发上游同步。管理员在“套餐管理”中手动同步上游，配置名称、分类和价格后上架。请直接使用目录返回的 `type` 查询地区及创建订单。历史标识保持兼容；新增套餐可使用原始上游标识，例如 `chatgptplusplan-50pct-off`。支付地区仍按所选套餐实时查询。

## 查询已启用套餐

调用 `POST /api/open/v1/getSubscriptionPlans`，使用 `subscriptions:read` 权限及上文的 HMAC 签名。请求体 `{}` 或空请求体仍按原行为查询 GPT；新客户端可传 `{"service_code":"grok"}` 或 `{"service_code":"all"}`。无需 Idempotency-Key，不接受 URL Query 或用户 ID。

```json
{}
```

响应示例（假设当前客户仅开放 Plus 和 Pro 500；套餐及费用以实际返回为准）：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "enabled": true,
    "tier_id": 1,
    "tier_name": "VIP1",
    "plans": [
      {"type": "gpt-plus", "name": "ChatGPT Plus", "service_fee": "0.15", "fee_configured": true},
      {"type": "gpt-pro-25x", "name": "ChatGPT Pro 25x", "service_fee": "0.15", "fee_configured": true}
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 平台当前是否开放订阅；暂停服务或未配置上游密钥时为 false，且 plans 返回空数组 |
| `tier_id` / `tier_name` | 当前客户的费率等级 |
| `plans` | 当前客户有权使用的套餐；无可用套餐时为 [] |
| `plans[].category` | 本地配置分类：subscription（订阅套餐）或 credits（额度充值） |
| `plans[].service_code` | 可选服务标识；省略表示 `chatgpt`，Grok 返回 `grok`；创建时必须与套餐匹配 |
| `plans[].type` | 套餐标识，作为地区查询及创建订阅的 plan_type |
| `plans[].name` | 套餐显示名称 |
| `plans[].service_fee` | 当前客户的平台服务费，USDT 金额字符串；未配置价格的套餐不进入用户目录，不是银行卡实际付款金额 |
| `plans[].fee_configured` | 用户目录中为 true；未定价套餐仅在后台套餐管理和价格设置中可见 |

此接口自动包含当前支持且对客户开放的套餐，包括 GO、Plus、Pro 和点数套餐；接入方应遍历 `plans`，不要写死套餐列表。客户被管理员停用或密钥缺少权限时返回 403。查询不创建订单、不扣费，也不查询上游地区。

选择套餐后，将其 `type` 作为 `plan_type` 传给现有 `getSubscriptionPaymentRegions` 接口，再将返回的地区 `code` 作为下单 `payment_region`。原 `getSubscriptionCatalog` 保持兼容；新接入可使用本接口获取已启用套餐。

## 查询支付地区

调用 `POST /api/open/v1/getSubscriptionPaymentRegions`，传入当前套餐 `plan_type`。平台实时查询上游可用地区，按上游顺序返回；`default=true` 表示推荐地区。每个套餐分别查询（包括 GO），不应复用其他套餐的地区或写死地区列表。接口遵循当前用户的套餐权限，查询失败时应稍后重试。

```json
{"code":0,"msg":"ok","data":{"plan_type":"gpt-plus","payment_regions":[{"code":"PH","default":true},{"code":"US","default":false}]}}
```

返回的地区代码供下单 `payment_region` 使用。此接口不返回上游账户积分成本；平台服务费仍以目录的 `service_fee` 为准，银行卡实际付款金额以订单结果为准。

## 获取自己的支付卡

使用 `POST /api/open/v1/getCardList` 查询本人卡列表，需要 `cards:read` 权限。请求体可使用 `{"page":1,"page_size":20}`；从返回的卡片记录取得平台卡 ID，再作为 `card_id` 提交。接口完整字段见平台通用开放 API 文档。网页订阅直接从卡片选择器选择，不需要 API 密钥。

## 服务分类与 Grok 接入

- `service_code` 支持 `chatgpt`、`grok`。创建时省略仍按 ChatGPT 处理；Grok 必须显式传 `grok`。
- `getSubscriptionPlans` / `getSubscriptionCatalog` 默认仅返回当前用户可用的 GPT 套餐，保持旧调用兼容；传 `service_code: "grok"` 查询 Grok，传 `service_code: "all"` 查询全部。按 `plans[].service_code` 分类（省略视为 ChatGPT），用返回的 `type` 下单；不要根据套餐名称猜测服务。
- `getSubscriptionPaymentRegions` 仍按 `plan_type` 查询，平台从本地目录确定服务并传给上游；无需在客户端猜测上游参数。
- `getSubscriptionList` 增加可选 `service_code` 筛选，省略或空字符串仍只返回 GPT；`grok` 返回 Grok，`all` 返回全部服务。网页共享订单列表不受这个旧开放 API 默认值影响。为兼容旧 GPT 客户端，ChatGPT 响应保持原有形状，省略服务字段时视为 `chatgpt`。Grok 创建、列表及详情返回 `service_code`；详情的上游形状同时包含 `serviceCode`。
- Grok 使用 `session_json` 传原始 SSO 字符串，或包含 `sso` / `sso-rw` / `cookieHeader` 的凭据 JSON；总大小不得超过 64 KiB。字段为字符串时也参与原始请求签名，不能签名后改为对象。
- Grok 首期仅支持 US 地区首次购买。`target_email` / `targetEmail` 创建时可能为空，账号由上游核验后回填；不得将空邮箱视为下单失败，也不要用 SSO 内未核验的声明推断邮箱。
- 查询中的 `session` 可能是字符串或对象，仅用于所属用户的明确凭据查询，不写日志或 URL。普通网页详情、列表及统计不会携带凭据。
- 同一客户订单号与幂等键不能换服务、套餐、卡片或凭据重用。结果不明确时仍只确认原订单，不创建第二笔。

Grok 创建请求示意（套餐需先在后台同步、定价并上架）：

```json
{
  "service_code": "grok",
  "client_order_no": "SHOP-GROK-001",
  "plan_type": "grok-super-monthly",
  "payment_region": "US",
  "card_id": 123,
  "session_json": "替换为目标账号的原始 SSO",
  "authorized": true,
  "max_service_fee": "0.25"
}
```

`max_service_fee` 为示意上限，请以套餐接口返回的当前用户服务费为准。

## 创建订阅

```json
{
  "client_order_no": "SHOP-20260905-0001",
  "plan_type": "gpt-plus",
  "payment_region": "US",
  "card_id": 123,
  "session_json": {
    "user": { "id": "目标用户ID", "email": "customer@example.test" },
    "account": { "id": "目标账号ID" },
    "accessToken": "替换为目标账号真实值",
    "sessionToken": "替换为目标账号真实值",
    "expires": "2026-12-31T00:00:00Z"
  },
  "authorized": true,
  "max_service_fee": "0.15"
}
```

- `client_order_no` 必填，当前用户范围内唯一，最多 128 字节。
- `payment_region` 可选，为地区查询返回的两位大写代码；省略时由上游选择默认地区。地区已停用时上游会拒绝，不会自动切换。该字段参与幂等校验，同一订单重试必须保持原地区。创建/列表通过 `payment_region` 返回已知地区，详情通过 `paymentRegion` 返回支付地区；历史记录可能没有该字段。
- `card_id` 为属于调用用户的有效平台卡 ID。凭证无效或卡不可用时不创建可执行订单。
- ChatGPT 的 `session_json` 必须是目标账号的完整有效资料，可包含其他上游要求的字段；上例不能直接执行。请求日志不保存此内容。
- `authorized` 必须为 true，表示已取得对应订阅支付授权。
- `max_service_fee` 可选，可接受的最高平台使用费；超过此值拒绝且不扣费。
- `Idempotency-Key` 必填，8–128 字节，参与签名。每笔业务使用固定值。
- 短事务记录价格、收费政策、固定期限后，在当前请求内向上游 POST 一次。调用在事务外进行；余额不足不阻止创建。网页客户端等待上限 80 秒，服务端默认创建 30 秒，另有最多 10 秒保存容差。
- 创建响应直接包含本次受理结果及 `upstream_status`、`result_source`、`upstream_http_status`、`upstream_code`、`upstream_message`。协议失败返回平台 `code=59018` 和独立 `request_error`，已建平台记录保留在 `data`，使用同一幂等身份读取原记录。
- 创建失败的 `request_error.submission_outcome` 为 `rejected` 时，表示已确认提交被拒绝或未发送；修正资料后可用新的幂等身份提交。`unknown` 或无法识别的错误须保留原请求与幂等身份，重试只确认原记录。HTTP 502、平台 59018、本地 `failed` 均不能单独证明上游未受理；查询错误也不能用来重新下单。上游明确返回 40027 时应重新登录目标 ChatGPT 账号并获取最新完整 Session JSON。错误文案采用安全映射，不透传可能包含凭据的上游原文。服务费状态与卡片扣款是独立证据。
- 上游公开契约为创建 HTTP 201、查询 HTTP 200。任何 HTTP 状态本身都不表示订阅成功，必须收到有效、归属一致的订单及 `status=succeeded`。

`createSubscription` 的 data 及列表内的订单摘要为：

```json
{
  "task_no": "平台生成的订单号",
  "client_order_no": "SHOP-20260905-0001",
  "plan_type": "gpt-plus",
  "payment_region": "US",
  "service_fee": "0.15",
  "currency": "USDT",
  "fee_status": "none",
  "billing_policy": "success_debit_v1",
  "upstream_status": "pending",
  "result_source": "upstream",
  "status": "running",
  "subscription_succeeded": null,
  "subscriptionCancelled": null,
  "error_code": "",
  "created_at": "2026-09-05T08:00:00Z",
  "updated_at": "2026-09-05T08:00:00Z",
  "processed_at": null
}
```

列表 data 为 `{items:[订单对象],total,page,page_size}`；默认 20 条，最多 100 条。只能读取自己的 API 订单。订单状态：queued / running / succeeded / failed；资金状态：none / charge_pending / settled / charge_failed，历史记录另有 frozen / released。零使用费任务的资金状态为 none。

创建和列表摘要现在也返回可选 `stage`：`awaiting_captcha` 表示最后一次查单时等待验证，`captcha_submitted` 表示最后一次查单时已提交验证。摘要只读取已验证快照，不携带 `captcha` 对象或验证链接；没有当前阶段时省略 `stage`。即使创建响应没有 `stage`，后续处理仍可能要求验证，必须继续调用 `getSubscription`。

## 查询完整订阅结果

`getSubscription` 的 `data` 提供与上游查询相同命名的结果字段，并保留平台服务费和旧订单字段。响应新增 `message`，原 `msg` 保留。请求路径、HMAC 签名和权限不变；`orderId` 始终是本平台订单号，可用于后续查询，不是上游订单号。

```json
{
  "code": 0,
  "message": "成功",
  "msg": "ok",
  "data": {
    "orderId": "SUB-20260906-0001",
    "status": "succeeded",
    "targetEmail": "target@example.test",
    "planCode": "chatgptplusplan",
    "paymentRegion": "US",
    "session": {
      "user": { "id": "user_example", "email": "target@example.test" },
      "account": { "id": "account_example" },
      "accessToken": "synthetic-latest-access-token",
      "sessionToken": "synthetic-latest-session-token",
      "expires": "2032-11-01T09:34:59Z",
      "providerField": { "preserved": true }
    },
    "payment": { "amount": 19.99, "currency": "USD" },
    "subscriptionCancelled": true,
    "createdAt": "2026-09-06T01:23:30Z",
    "updatedAt": "2026-09-06T01:24:35Z",
    "completedAt": "2026-09-06T01:24:35Z",
    "query_source": "upstream",
    "queried_at": "2026-09-06T01:25:00Z",
    "task_no": "SUB-20260906-0001",
    "client_order_no": "SHOP-0001",
    "plan_type": "gpt-plus",
    "service_fee": "0.15",
    "currency": "USDT",
    "fee_status": "settled",
    "task_status": "succeeded",
    "subscription_succeeded": true,
    "error_code": "",
    "created_at": "2026-09-06T01:23:28Z",
    "updated_at": "2026-09-06T01:24:36Z",
    "processed_at": "2026-09-06T01:24:36Z"
  }
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `orderId` / `task_no` | string | 同一本平台订单号；不暴露上游标识。 |
| `status` | string | **详情查询**使用 `pending / processing / succeeded / failed`。旧客户端的 `queued / running` 判断应更新为 `pending / processing`，或改读 `task_status`。创建与列表继续使用原状态名称。 |
| `stage` | string，可省略 | `awaiting_captcha` 等待人机验证；`captcha_submitted` 验证已提交。两种阶段的订单仍为 `processing`。 |
| `captcha` | object，可省略 | 本次查询的验证任务，包含 `id`、`status`（`pending / submitted`）、`url`（string / null）、`expires_at`（RFC3339）。仅在最新详情返回，不写入快照或列表。 |
| `task_status` | string | 平台任务状态：`queued / running / succeeded / failed`。仅代表本地执行状态，不能单独用于判断订阅成败。服务费以 `fee_status` 为准。 |
| `paymentRegion` | string | 订单支付地区；上游受理后保存实际地区，未受理时为请求地区，未指定且未返回时省略。 |
| `targetEmail` / `planCode` | string | 目标账号邮箱、上游套餐代码。 |
| `session` | object 或 string，可省略 | 当前上游查询返回的登录凭据；ChatGPT 为 Session JSON，Grok 可为 SSO 字符串或对象。保留原始类型与扩展字段。仅所属用户可见；字段缺失时省略；归属校验失败则本次查询返回错误，不返回任何 Session。不会使用提交时的旧凭证冒充最新结果。 |
| `payment` | object，可省略 | 订单支付金额快照，`amount` 为数字，`currency` 为实际币种；不等于平台服务费，也不单独证明扣款成功。 |
| `subscriptionCancelled` | boolean / null | true 已取消自动续费；false 未取消；null 没有明确结果。 |
| `createdAt / updatedAt / completedAt` | RFC3339 | 最新上游结果的创建、更新、完成时间；未完成时省略 completedAt。仅从上游取值；没有上游时间时不从本地完成时间推断。 |
| `failureCode / failureMessage` | string，可省略 | 上游实际返回的失败或处理中说明，脱敏后保留；本地错误在 `request_error`。 |
| `query_source` | string | `upstream` 本次已验证查询；`snapshot` 保存记录，时间在 `result_at`。 |
| `queried_at` | RFC3339 | 本次读取完成时间，不代表历史结果发生时间。 |
| `request_error` | object / null | 网络、超时、协议或身份校验错误，包含独立错误码、来源及可用的上游 HTTP/code。 |
| `result_at` | RFC3339 / null | 已保存上游快照的接收时间；没有经过验证的快照时为空。 |

详情每次最多执行一次上游 GET，单次最长 10 秒，同单领取租约为 20 秒。网络、协议或归属校验失败必须返回非零平台 code（59018）与 `request_error`，不能用本地记录包装成最新成功响应。同单并发查询可返回 `relay_query_busy`，稍后用原订单号重试。

**详情现在会持久化已验证的上游结果**，并在第一次成功时幂等创建服务费事项。详情不直接扣钱包，不执行 POST、不取消自动续费；独立收费处理器执行扣款。列表只读保存快照，不请求上游、不返回 Session。无上游单号的已结束请求返回其 `request_error`，订阅结果为 null。旧本地终态不阻止主动查询上游同单最新结果。

Session 在客户服务端 API 的本次详情响应内返回，不写入任务结果摘要、调用日志或浏览器持久存储；响应标记 `Cache-Control: no-store`。用户网页的常规详情响应不携带凭证；订单所属用户点击「查看账号凭证」时，通过独立接口重新查询该订单当前保存的 Session，并支持完整复制。上游未返回时显示未返回，不用提交时的旧凭证冒充最新结果。收起、关闭或切换订单后清除页面中的凭证。管理员详情不返回 Session 或验证链接。

## 人机验证 API 接入

人机验证已经包含在 `POST /api/open/v1/getSubscription` 的响应中，无需创建新的验证订单或调用验证码提交接口。认证仍使用平台 HMAC 和 `subscriptions:read` 权限。

| 接口 | 阶段字段 | 验证链接 |
| --- | --- | --- |
| `createSubscription` | `data.stage`，可省略，已验证快照 | 不返回，受理后开始查单 |
| `getSubscriptionList` | `data.items[].stage`，可省略，已验证快照 | 不返回，按原订单号查询详情 |
| `getSubscription` | `data.stage`，可省略，本次上游状态 | `data.captcha.url`，保留完整片段票据 |

**开放 API 直接读取 `data.captcha`。** `order_result.captcha` 属于网页工作台内部详情结构，开放 API 不使用这个嵌套层级。

| 字段 | 类型 | 处理方式 |
| --- | --- | --- |
| `data.stage` | string，可省略 | `awaiting_captcha` 等待验证；`captcha_submitted` 已提交，订单仍在处理 |
| `data.captcha` | object，可省略 | 本次查单的当前验证任务，缺失时清除旧入口并继续查单 |
| `data.captcha.id` | string | 本轮任务编号，按 `orderId + captcha.id` 区分多轮验证 |
| `data.captcha.status` | string | `pending` 展示入口；`submitted` 继续等待订单结果 |
| `data.captcha.url` | string / null | 完整 HTTPS 链接，保留 `#` 后票据；null 表示入口未配置 |
| `data.captcha.expires_at` | RFC3339 | 本轮到期时间；刷新或重开窗口不延长有效期 |

查单请求如下，签名路径为 `/api/open/v1/getSubscription`。也可改用 `client_order_no` 或 `orderId`，三个查询字段只能传一个：

```json
{"task_no":"SUB-20260918-0001"}
```

等待验证时的响应示例（省略与验证无关的详情字段）：

```json
{
  "code": 0,
  "msg": "ok",
  "message": "查询完成",
  "data": {
    "orderId": "SUB-20260918-0001",
    "task_no": "SUB-20260918-0001",
    "status": "processing",
    "upstream_status": "processing",
    "task_status": "running",
    "stage": "awaiting_captcha",
    "captcha": {
      "id": "cap_example",
      "status": "pending",
      "url": "https://verify.example.com/api/v1/captcha/verify/cap_example#access=example-ticket",
      "expires_at": "2026-09-18T10:08:00Z"
    },
    "subscription_succeeded": null,
    "fee_status": "none",
    "result_source": "upstream",
    "query_source": "upstream"
  }
}
```

当 `stage=awaiting_captcha` 且 `captcha.status=pending` 时，展示「完成人机验证」按钮。在用户点击事件中通过 `window.open(captcha.url, '_blank', 'noopener,noreferrer')` 打开完整 HTTPS 链接，保留 `#` 后的访问票据。不支持 iframe，不附带 API Key 或 Session；组件渲染、答案提交和验证窗口的完成提示由上游托管页负责。验证链接不得写入日志、数据库、浏览器存储或缓存。

同单验证次数不固定，以 `orderId + captcha.id` 区分每轮任务。同 id 重复返回时不自动反复弹窗，但用户可重新打开；新 id 到达时立即替换入口并再次提示，即使旧窗口仍开着。可能从 A/pending 直接跳到 B/pending，中间 submitted 状态不保证可见。新任务替换后旧链接失效。

有效期以 `expires_at` 为准，刷新或重开窗口不会延期；过期后停止使用旧链接并继续查询原订单。`url=null` 表示上游尚未配置入口，联系平台处理，不要重新创建订单。

窗口打开或关闭、`captcha.status=submitted`、`stage=captcha_submitted`、`captcha` 暂时省略都不代表订阅成功。继续串行查询同一订单，直到上游 `status=succeeded` 或 `failed`；每次响应整体替换当前验证任务，缺失时清除旧入口。网络错误或同单查询忙时退避重试；响应有 `Retry-After` 时至少等待其指定时间，`request_error.retry_after_seconds` 同时提供等待秒数。不得通过重新下单来解决验证问题。

如果没有看到字段，先确认调用的是 `getSubscription`。订单尚未触发验证或当前验证已被消费时，省略 `captcha` 属于正常行为；创建／列表的阶段快照也可能落后于实际状态。若网页和开放 API 表现不同，应确认后端运行版本包含人机验证支持，并确认前端文档资源已更新。

### 判断订阅结果与自动续费

`code=0` 只表示本次接口调用成功，不能据此判断已完成订阅。订阅结果只按 `upstream_status`（详情亦为 `status`）或 `subscription_succeeded` 判断：上游 `succeeded/failed` 才对应 true/false，其他情况为 null。创建和列表的旧 `status` 以及详情的 `task_status` 都只是本地任务状态，`failed` 可能是请求失败或超时。未知上游状态保留原值，不猜测为成功或失败。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `data.subscription_succeeded` | boolean / null | true：订阅成功；false：订阅失败；null：无上游明确终态，包括请求失败、超时和历史事实未知 |
| `data.subscriptionCancelled` | boolean / null | 来自上游同名 `data.subscriptionCancelled`；true：已取消自动续费；false：返回结果为未取消；null：本次未返回确认结果 |

例如最终成功且已取消续费时，返回 `{"status":"succeeded","subscription_succeeded":true,"subscriptionCancelled":true}`。成功但未取消时，`subscriptionCancelled` 为 false；成功但缺少该字段的历史结果返回 null，不能当作 false。失败订单的续费结果也单独判定，不根据失败状态推断是否取消。

详情查询中的续费结果取自本次上游返回；列表／无单号记录使用已保存且标明来源时间的快照；查询失败直接返回错误。这不是账号续费设置的持续监控。网页端所显示的 `payment` 金额也只是订单观察到的金额快照，不能单独作为已扣款或订阅成功的依据。

## 重试与查询

相同订单保留原 client_order_no、请求内容与 Idempotency-Key，只更新时间戳及 Nonce，并重新签名。已有相同内容返回原订单及已保存的失败或受理结果，不再次 POST，也不重复收费。客户订单号相同而内容不同，或幂等键绑定另一笔订单，均拒绝。

网络超时先使用原标识查询或安全重放，不能换客户订单号盲目创建。建议查询间隔至少 5 秒，并按限流结果退避。本版通过查单返回结果，未新增订阅结果回调功能。

停用客户订阅权限或关闭接单，只阻止新任务；已有任务继续执行，拥有有效查询权限的 Key 仍可查单。撤销 Key 后该 Key 不能认证。

## 常见错误

| 情况 | 业务码或 HTTP 状态 |
| --- | --- |
| 未认证 / 无权限 | HTTP 401 / 403 |
| 服务未启用或暂停接单 | 59001 |
| 不支持的套餐 / 无效 Session | 59002 / 59004 |
| 本次请求／查询失败 | 59018；具体原因在 request_error |
| 已停用的管理员核验写接口 | 59019 |
| 卡不可用 / 未确认授权 | 59005 / 59007 |
| 档位未配置 / 订单不存在 | 59008 / 59009 |
| 上游密钥未配置 | 59013 |
| 使用费超过 max_service_fee | 59015 |
| 客户处理中订单达到上限 | 59016 |

余额不足、身份冲突和限流沿用平台统一错误信封，不按错误文本判断业务结果。

## 管理端月报口径

自然月按 Asia/Shanghai 统计，默认当前月。已结算和退款按账本事件时间归属，实际费用 = 已结算 − 当月退款；跨月退款可使当月实际费用为负。期末预占由截至月末的冻结、释放和结算流水还原。当前月截至查询时刻。统计默认包含 API、网页和历史订单，可单独筛选 API 来源，不能用调用次数乘当前价格代替真实扣费。

调用次数统计进入订阅业务处理器的已认证请求，包含业务失败、查询和重试；认证或网关限流前拒绝的请求不计入本业务日志。日志不存 Session、Secret、签名或完整卡资料。CSV 导出当前筛选下所有分组的月度汇总，附时区、截止时间和合计。

## 结果待确认

本地请求异常结束为 `task_status=failed`，`request_error.code` 使用独立 `relay_*` 空间；上游业务拒绝用 `source=upstream`，保留真实 HTTP/code/message。没有明确上游终态时 `subscription_succeeded=null`，不能解释成“未扣款”或“上游确认失败”。人工核验写接口已停用，历史审计只读。

从创建时间起最多主动跟踪 15 分钟，GET 按 2/5/10/30 秒加不超过 500ms 抖动退避。截止时间不因查询更新而延长。到期自动退出活动名额并清除提交凭据；用户仍可主动 GET 同单结果。404、身份不匹配直接结束主动跟踪。禁止新下单开关不关闭收尾和费用处理。

## 服务费状态兼容变化

依赖旧枚举的客户端必须增加 `charge_pending`、`charge_failed`，并读取 `billing_policy`。订阅结果与服务费应分开展示。

| fee_status | 含义 |
| --- | --- |
| none | 非零价格：成功后收取；零价格：无费用 |
| charge_pending | 已收到上游成功，等待独立扣费；订阅已经完成 |
| settled | 服务费已收取，新政策为 debit，历史可为 frozen_debit |
| charge_failed | 服务费未收取；余额不足或有限技术重试结束，不改变订阅成功 |
| frozen / released | 仅为历史预占／已释放，不能用于新单 |

扣费幂等身份固定为 `auto-pay-success-fee:<task_no>`，按创建价格快照执行。技术失败在 15 分钟内最多 5 次，余额不足直接结束；充值、刷新、重复查询不会重新开启收费事项。新政策迟到成功收费一次；历史已释放订单永不追扣。已收取后上游返回更新结果，只更新事实，不自动退款或再次收费。

实收费以钱包 debit / 历史 frozen_debit 流水计入报表；charge_pending / charge_failed 不算已收取。订阅成功率只统计已验证上游 succeeded/failed，不把本地超时、请求错误或服务费失败放入订阅失败分母。

## GPT 小助手 OpenAPI

小助手提供实时账号查询、升级价格预览、自动续费管理、账单中心链接和最新 Session。沿用本平台 `/api/open/v1` 的 HMAC-SHA256 签名、API Key、IP 白名单和统一响应格式；不是上游仅传 X-API-Key 的接口。只从客户服务端调用，不使用网页登录 Cookie。所有接口均为 POST，不接受 URL Query。

在「API 密钥」或开发者中心为密钥显式勾选“小助手查询”或“小助手管理”；旧密钥的订阅查询 / 下单权限不会自动包含小助手权限。管理员也可在 API 密钥管理中授予或限制这两项权限。

| 路径 | 必要权限 | 请求参数 |
| --- | --- | --- |
| `/api/open/v1/assistants/gpt/session` | `assistants:read` | `session` |
| `/api/open/v1/assistants/gpt/upgrade-price` | `assistants:read` | `session`、`targetPlan` |
| `/api/open/v1/assistants/gpt/auto-renewal` | `assistants:manage` | `session`、`accountId`、`enabled` |
| `/api/open/v1/assistants/gpt/billing-portal` | `assistants:manage` | `session` |
| `/api/open/v1/assistants/gpt/latest-session` | `assistants:manage` | `session`（包含登录 Cookie 凭据） |

`session` 必须是完整 JSON 对象，不能是转义字符串；不超过 64 KiB，包含 `user.email` 和 `accessToken`。请保留完整对象及扩展字段。请求体上限为 72 KiB；除表中字段外不要添加其他顶层字段。建议客户端超时设置为 90 秒。

小助手请求不创建订阅订单、不收取平台使用费，不要求 Idempotency-Key，也不缓存或重放操作结果。请求仍需每次生成新 X-Nonce 并重新签名。每个操作按用户和来源 IP 分别限流：查询类每分钟最多 5 次，管理类每分钟最多 3 次，使用固定分钟窗口；同一用户的多个 Key 共享额度，并同时受密钥总额度和上游限流约束。遇到 HTTP 429 或上游限流错误时遵循 Retry-After。

响应带 `Cache-Control: no-store`。调用日志仅记录用户、密钥 ID、请求 ID、路径、状态码与耗时，不保存 Session、Token、报价响应或账单链接。不要将凭据放入 URL、请求 ID、自定义日志或浏览器持久存储。

### Session 查询

```json
{
  "session": {
    "user": { "email": "target@example.com" },
    "accessToken": "<完整 Access Token>"
  }
}
```

成功时 `data` 是账号对象：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "email": "target@example.com",
    "accountId": "account_example",
    "plan": "plus",
    "subscriptionPlan": "chatgptplusplan",
    "active": true,
    "willRenew": true,
    "startedAt": "2026-10-20T07:42:00Z",
    "expiresAt": "2026-11-20T07:42:00Z",
    "renewsAt": "2026-11-20T07:42:00Z",
    "billingPeriod": "month",
    "currency": "USD",
    "accountStatus": "active",
    "paymentChannel": "chatgpt_web",
    "checkedAt": "2026-10-28T08:00:00Z",
    "warnings": []
  }
}
```

当前套餐以 `plan` 为准；`subscriptionPlan` 可能保留历史值。只有 `active=true` 且 `plan=pro` 时，使用匹配的订阅代码细分 Pro 档位。`active` 和 `willRenew` 无法确认时为 null，不能当作 false；未知时间为空字符串，提示为空时 `warnings=[]`。

### 升级价格查询

请求 `POST /api/open/v1/assistants/gpt/upgrade-price`：

```json
{
  "session": {
    "user": { "email": "target@example.com" },
    "accessToken": "<完整 Access Token>"
  },
  "targetPlan": "chatgptpro"
}
```

`targetPlan` 必填，没有默认值；使用下面的上游目标套餐代码，不使用订单接口的 gpt-plus / gpt-pro-20x 等标识。

| targetPlan | 目标套餐 |
| --- | --- |
| `chatgptplusplan` | ChatGPT Plus |
| `chatgptprolite` | ChatGPT Pro $100 |
| `chatgptpro` | ChatGPT Pro $200 |
| `chatgptpromax` | ChatGPT Pro $500 |

成功时 `data.account` 是上述账号对象，其余字段示例：

```json
{
  "targetPlan": "chatgptpro",
  "currency": "USD",
  "amountDue": 18000,
  "totalAmount": 18000,
  "taxAmount": 0,
  "positiveLineItemTotal": 20000,
  "negativeLineItemTotal": -2000,
  "discountAmount": 0,
  "appliedBalance": 0,
  "renewalDate": "2026-11-20T07:42:00Z",
  "checkedAt": "2026-10-28T08:00:00Z"
}
```

| 响应字段 | 含义 |
| --- | --- |
| `account` | 本次查询的目标账号；内部字段与 Session 查询一致 |
| `targetPlan` | 本次报价对应的目标套餐 |
| `currency` / `amountDue` | 实际报价币种、本次应付金额；始终返回 |
| `totalAmount` / `taxAmount` | 账单总额、税费；上游提供时才返回 |
| `positiveLineItemTotal` / `negativeLineItemTotal` | 计费项目总额、抵扣项目总额；保留正负号 |
| `discountAmount` / `appliedBalance` | 优惠金额、余额调整；上游提供时才返回 |
| `renewalDate` / `checkedAt` | 下次续费时间、报价查询时间；无有效续费时间时为空字符串 |

**全部金额为该币种最小单位的整数**，例如 USD 18000 = 180.00 美元、JPY 100 = 100 日元。以 `amountDue` 为本次应付，不用套餐标价、`totalAmount` 或自行加减其他字段替代。缺失的可选金额省略，明确返回 0 才表示零金额。缺少应付金额或币种、账号或目标套餐不匹配时返回失败，不会把无效报价当作 0 元。

网页端查询成功后隐藏并清空 Session 输入框；返回查询可以复用当前页面内的账号凭据查询其他套餐。查询其他账号、清空、切换功能或离开页面会清除凭据和报价，不写入浏览器存储。

该接口仅预览，不会扣款、开启续费或提交升级。仅支持有效网页付费订阅；App Store / Google Play、同档、降档、没有有效订阅或档位未知等情况会返回具体原因。实际报价会随剩余时间、税费和优惠变化，最终支付以账单为准。

### 自动续费、账单中心与最新 Session

自动续费请求额外传 `accountId`（Session 查询返回值）及布尔值 `enabled`：true 开启，false 关闭。成功时返回核对后的完整账号对象。一次请求不会自动重试提交；超时或续费状态未确认时，先调用 Session 查询核对 `willRenew`，不要立即重复提交。

账单中心请求只需 `session`，成功时返回 `data.url`（HTTPS 临时链接）。每次实时获取，不记录或缓存完整链接。

最新 Session 请求需要 `session` 包含 `sessionToken`、`session_token` 或完整登录 `cookies` 数组之一，仅 accessToken 不够。成功时返回 `data.session` 完整对象，保留扩展字段；不要只提取 accessToken。返回 Token 与原 Token 相同也可能是有效结果。

### 小助手错误响应

本站参数、签名与权限错误沿用平台错误码。上游失败使用 HTTP 502、本站 `code=59018`，详细分类读取 `data.request_error.upstream_code`，不要将上游业务码误认为本站顶层 code。上游 HTTP 状态在 `data.request_error.upstream_http_status` 中；本站拒绝不完整或不匹配的结果时为 `source=relay`、`code=assistant_invalid_response`。

| upstream_code | 含义及处理 |
| --- | --- |
| `40030 / 40031 / 40032 / 40033` | Session、登录 Cookie、续费参数或目标套餐无效；修正对应参数 |
| `42230 / 40934` | 登录失效或目标账号不匹配；重新获取完整 Session |
| `42231 / 42232` | 非网页订阅或渠道无法确认；查看具体错误消息 |
| `40935 / 40936` | 已拥有目标套餐或目标为降档；选择更高档位 |
| `40937 / 40938 / 40939` | 无有效订阅、状态或档位无法确认；刷新账号信息 |
| `42233 / 40940 / 40941` | 无购买资格、未结清账单或暂不支持升级；处理账号问题后重试 |
| `50233` | 上游报价缺少应付金额或币种；不要当作免费升级 |
| `40930 / 40931 / 40932` | 续费不可用、进行中或结果未确认；先查询账号状态 |
| `42900 / 50331` | 上游限流；遵循 Retry-After |
| `50230 / 50231 / 50232 / 50330` | 上游请求失败、拒绝访问、无有效最新 Session 或服务不可用 |
