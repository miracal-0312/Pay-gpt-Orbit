# Pay-gpt-Orbit

仅通过 **Orbitcard HMAC V1** 完成 ChatGPT 订阅兑换。提供 CDK 管理、自动选卡、补款与申请卡、订单追踪、重启恢复、持久化审计、管理员认证及 Telegram 通知。

本地支付、卡池、代理池、账单地址、浏览器自动化、验证码求解、支付链接调试和直接订阅管理均已移除。容器只运行 Node.js；生产依赖为 `axios`、`express`、`mysql2`、`ws`，不安装浏览器、Python 或 AI 模型。

[部署与升级](DEPLOY.md) · [完整链路](RECHARGE-AUDIT.md) · [自动选卡与申请卡](ORBITCARD-CARDS.md) · [接口接入](对接api.md) · [Orbitcard 原始协议](orbitcard-subscription-api-v1.md)

## 快速开始

需要 Node.js 24+ 和 MySQL 8；或 Docker Engine 与 Compose V2。

```bash
cp .env.example .env
# 填写数据库密码、管理员密码、随机签名密钥、Orbitcard HMAC Secret
docker compose up -d --build
docker compose logs -f app
```

默认用户入口 `http://localhost:3000/`，管理员入口 `http://localhost:3000/admin-login`。首次创建管理员需要至少 8 位的登录密码、二级密码；`ADMIN_TOKEN_SECRET` 每次启动都必须为至少 32 字节的随机值。

后台配置配对的 Orbitcard API Key、HTTPS 根域名，可选开卡产品及单卡首充上限，填写四档套餐 USD 单次预算。每档套餐可单独指定支付地区；留空时下单不传 `payment_region`，由平台选择默认地区，即使地区目录没有 `default=true` 标记也可正常提交。保存 API 配置后可读取各套餐可用地区。API Key 增加申请卡、卡片读取、产品读取、卡资金和交易读取权限。开卡产品码留空时会从 Open API 自动获取和选择，首充 20.00 USD、数量 1 由服务端自动组装；可在“查询开卡产品与参数”预览。测试连接后开放接单；账户余额不足时锁定 CDK，旧卡不足补差额，无符合次数条件的卡时首充 20 USD 开新卡。关闭开关会拒绝新兑换，已有原单继续确认。

裸机部署：

```bash
npm ci --omit=dev --ignore-scripts
# 编辑 .env，并准备有建表和 ALTER 权限的 MySQL 数据库
npm start
```

安装脚本 `sh scripts/install.sh` 或 `powershell -File scripts/install-windows.ps1` 只安装 Node 生产依赖，缺少 `.env` 时复制模板；不覆盖现有配置。Windows 可使用 `npm.cmd`。

## 充值链路

1. 用户验证 CDK，提交目标账号完整 Session JSON。
2. 检查接单开关、维护状态、配置和并发容量。
3. 在 MySQL 事务中锁定 CDK、检查已有任务、创建任务、保存本次唯一 `client_order_no` 并占用 CDK；同一 CDK 的并发请求只会受理一笔新任务。
4. 查询当前套餐和该套餐可用支付地区，并核对目录返回的套餐；后台选了地区则校验后提交，留空则省略 `payment_region` 交由平台选默认，地区目录为空时停止。目录仅用于确认套餐开放，不使用或展示目录服务费。随后检查账户 `available_balance` 足够套餐金额；不足直接失败并锁定 CDK，提示联系管理员手动充值。再从平台拉取卡列表和批量详情，筛选 ACTIVE、USD、资料齐全且当前套餐次数可用的卡；详情缺项跳过该卡，不逐张补查。有剩余次数的卡却因异常不可用时锁定 CDK 并提示人工售后；无卡或当前套餐次数全满时自动首充 20 USD 开卡。卡余额不足补到套餐金额加最低保留余额。同一卡 Plus 最多 4 次、Pro 100/200/500 各 1 次，独立计数且可混用。历史卡同步后需确认四项已有次数，新申请卡自动登记；产品不返回会员价格时需在后台填写对应套餐的 USD 单次预算。
5. 选卡后不再逐张复核候选卡。以 MySQL 事务原子认领这笔任务的 `prepared → submitting` 状态；只有认领成功的执行者使用固定 `client_order_no` 作为平台幂等键调用一次 `createSubscription`。补款提交前及确认后仍按原补款意图核对卡片资金，避免重复补款。若管理员配置了服务费上限，仅在下单时传给平台校验。
6. 查询原订单；需要人机验证时，用户通过有时效的上游链接完成验证。平台明确返回订阅成功则核销 CDK、计次并释放卡占用。
7. 只有平台详情明确确认订阅失败，才开启下一笔新订单：每张卡只尝试一次；明确失败后重新读取平台卡片并排除已失败卡，最多换两张不同卡。每次失败保留独立任务、原订单号和结果日志，在事务中释放上一笔卡片预占并创建新的订单身份。第三张卡也明确失败时锁定 CDK，提示客户联系人工售后。提交被拒绝、超时和查询失败不当作可自动重试的支付失败。
8. 重启后自动恢复原单查询，用户也可用原 CDK 手动查询。网络超时或 `submitting` 结果未知时只查原单，不自动再次创建订阅；恢复中明确失败且仍有次数时，会保留 CDK 并要求用户提交同一账号的最新 Session 继续。未确认开卡/补款保留原身份确认，已知补款订单只查原流水。

自动前台跟踪最多 15 分钟，后台继续有间隔地恢复未确认订单。同一 API Key 遇到 HTTP 429 后，所有 Open API 操作共同遵守平台 `Retry-After` 冷却时间。订阅成功后记录卡片和账户资金快照；后台可按卡查询脱敏消费交易用于对账。交易记录不直接决定订阅结果，也不触发自动退款。平台服务费和订阅状态分别记录；`charge_pending` / `charge_failed` 不会把订阅成功改成失败。

## 套餐

| CDK 类型 | Orbitcard 套餐 |
| --- | --- |
| `plus` | `gpt-plus` |
| `pro100` | `gpt-pro-5x` |
| `pro200` | `gpt-pro-20x` |
| `pro500` | `gpt-pro-25x` |

历史 `pro_5x`、`pro_20x` 仍可读取；新 CDK 使用上述四种类型。是否开放某套餐以平台实时目录为准。

## 状态与数据

任务、CDK 和订单绑定保存在 MySQL；按日及按任务 JSONL 保存在 `data/logs`，后台可下载。完整 Session、签名和验证码凭据不写入任务数据库或普通日志。验证码链接仅保留在响应和短时内存中。

升级不会删除旧数据库表、历史账单、Session 数据或宿主机文件。历史非 Orbitcard 运行任务转为人工核对并保留 CDK；这些数据不会被重新执行，也不再提供原有支付入口。

## 验证

```bash
npm test
```

测试包括 HMAC 签名、CDK 与卡片额度事务、订阅提交原子认领、三张不同卡失败后的 CDK 锁定与换卡、并发预占、分套餐地区默认值、批量选卡与异常响应、账户余额门槛、批量卡片状态筛选与补款前余额核对、差额补款与原开卡/补款意图恢复、目录服务费剔除和下单上限透传、API 限流、只读交易脱敏、原单恢复、日志脱敏及管理员权限。使用模拟数据库和上游接口，不会发起真实开卡或充值。

容器体积需在实际构建后测量；不再下载安装 Chromium、PyTorch 等组件。更换轻量镜像不会自动删除服务器上的旧镜像或构建缓存。

本项目基于 KC（TG：KcCatk）的 [KC-CatK/KC-PAY-GPT](https://github.com/KC-CatK/KC-PAY-GPT) 定制，保留 [MIT License](LICENSE) 及原始版权。
