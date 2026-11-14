# 部署与升级

## 环境

- Node.js 24 或更新版本，MySQL 8；Docker 部署使用 Compose V2。
- 数据库账号需要应用库建表、索引、ALTER 和读写权限。
- 服务器可以访问配置的 Orbitcard HTTPS 根域名，系统时钟保持同步。
- 生产部署仍使用一个应用实例管理同一套任务。支付执行已增加跨进程 MySQL 命名锁，但并发容量、WebSocket 推送和上游限流缓存仍按进程维护，不能据此直接扩容为多副本。
- 命名锁须连到同一个 MySQL 主库，不能经过按请求切换连接的事务池代理。执行锁和选卡锁使用独立连接：每笔活跃支付最多额外占用两条连接；设置 MySQL 连接额度时，在业务查询池、这些锁连接之外保留管理和恢复任务余量。无需新增环境变量。

不需要 Chromium、Python、PyTorch、Transformers、OpenCV、noVNC 或本地卡池。平台卡 ID 是 Orbitcard 侧的卡片标识，不是本项目的卡池 ID。

## 首次安装

```bash
git clone https://github.com/miracal-0312/Pay-gpt-Orbit.git
cd Pay-gpt-Orbit
cp .env.example .env
```

填写 `.env`：

```dotenv
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD='replace_with_database_password'
DB_NAME=plus_papay
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD='replace_with_login_password'
ADMIN_SECONDARY_PASSWORD='replace_with_secondary_password'
ADMIN_TOKEN_SECRET='replace_with_random_secret_at_least_32_bytes'
ORBITCARD_API_KEY='replace_with_platform_issued_api_key'
ORBITCARD_API_SECRET='replace_with_matching_platform_secret'
```

不要使用这些占位值。登录密码和二级密码首次初始化时至少 8 位；已有账号由数据库管理，改 `.env` 不会重置已有账号。CDK 管理需要有效的管理员登录和二级验证。

生成随机管理员签名密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Orbitcard API Key 和 API Secret 必须由平台签发且相互配对，两者都只从服务端环境变量读取。后台不接收凭据。升级前先把两项值加入现有 `.env`；旧数据库凭据立即停止用于请求，两项环境变量齐全后会在启动时清除旧记录。修改 `.env` 后使用 `docker compose up -d --force-recreate app` 使新值进入容器；仅执行 `restart` 不会更新环境变量。含 `$`、`#` 或空格的 `.env` 配置使用单引号包裹，不要把 `.env` 当 shell 脚本执行。

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

容器内应用固定使用 `mysql:3306`、数据库用户 `root`，宿主机应用端口取 `PORT`。数据库宿主机端口取 `MYSQL_PORT`（默认 3310），只绑定 `127.0.0.1`。HTTP 健康检查 `/api/health` 检查应用与数据库，不保证 Orbitcard 凭据和卡片余额有效。

后台配置 API 根域名、手动开卡策略、最高 USDT 服务费、产品代码及单卡首充上限，凭据只显示配置状态。升级后先填写各档「套餐卡支付金额（USD）」，留空则停用该套餐；金额须与支付地区相符，最多 8 位小数，保存于 `orbitcard_plan_prices`，不新增环境变量。产品不提供套餐报价，不读取 `gpt_plan_prices`，也不用 USDT 服务费替代 USD 卡支付金额。「Orbitcard 配置 → 默认充值地区」为四档分别选择地区；平台默认省略 `payment_region`，指定地区在资金操作前校验，用户与管理员共用。选项从平台读取，先保存根域名再刷新；查询失败保留选择，失效不回退。地区存于 `orbitcard_payment_regions`，不恢复已废弃的历史地区。无需固定卡 ID，支付重新读取并选卡。「调试与日志」集中五个子页：接口查询、支付预检与测试、订单链路、运行日志、登录记录。真实测试仅在支付预检与测试，需要二级验证和扣款确认，不消耗 CDK，使用现有卡、差额补款及正式失败换卡规则。管理员订单列表在订单链路，显示第 N / 3 次及历史用卡日志，手动开通只保留人工交付；旧 `#logs` 自动进入运行日志。Telegram 发送测试移至接口查询的独立通知面板，使用已保存配置真实发送，设置页保留快捷入口；卡台查询面板保持只读。日志写入 `TASK_LOG_DIR` 卷，可按编号读取、下载。启动迁移补齐卡池字段、授权账本及 `orbitcard_admin_orders.retry_history MEDIUMTEXT`，数据库需 ALTER 权限；本次无新增环境变量。API Key 需有 `cards:create/read/manage/fund`、`products:read`、`account:read`、订阅相关权限及 `transactions:read`。确认 USD 金额、连接、余额和现有卡有效后再开放接单。

所有套餐共用每卡 7 次成功消费授权上限，按 cardTransaction 的成功授权 ID 去重，包含可见历史交易，不检查交易金额，本地开通结果不加次数。启动补齐账本，首次读取完整平台记录；达限空闲卡由后台维护删除，不补位。本地卡池不设数量上限，任何订单、后台维护和同步卡片都禁止自动开卡；仅管理员手动申请，每张首充 20 USD。支付只选 ACTIVE、USD、资料完整、授权不足 7 次、冷却结束且未占用的现有卡，不足则补差额，缺卡停止。授权未知、分页异常或状态未识别暂停使用该卡。ACTIVE 和 CANCELLED 卡直接申请删除；未知删除结果只读确认，不重复删除或据余额推测退款。历史自动开卡申请只有已保存平台 `order_no` 时，才用原平台、API Key、正文和幂等键核对同一申请；无订单号的未知申请不重发，未发送 `prepared` 意图可关闭为失败。完整规则见 [ORBITCARD-CARDS.md](ORBITCARD-CARDS.md)。

旧 `app_config` 中的套餐预算和支付地区值不再读取或写入；本次凭据调整要求新增 `ORBITCARD_API_KEY` 环境变量，并与 `ORBITCARD_API_SECRET` 配对。选卡详情按 20 张一批读取，选中后不逐张复核；补款提交前及确认后仍核对卡片资金。任务创建由 CDK 行锁串行化，卡片分配由 MySQL 命名锁串行化；提交前以同一订单身份原子认领 `prepared → submitting`，失败的并发执行者不得调用 `createSubscription`。平台请求继续使用固定 `client_order_no` 幂等键，超时后只查原单。这个保护不改变上文“同一套任务只运行一个应用实例”的部署要求。套餐目录服务费不参与本地预检或后台目录展示；已配置的最高 USDT 服务费仅随 `createSubscription` 提交，由平台校验。HTTP 429 后同一 Key 的 Open API 操作遵守 `Retry-After`。订阅成功后有只读资金快照，管理员可按卡查询消费交易用于对账；此功能需要已有的 `transactions:read` 权限，不执行自动退款。

新自助任务从 `preparing` 开始，资金就绪进入 `prepared`，随后原子认领 `submitting`，每次尝试只提交一次。超时或未知结果保持 `pending`，后台只查本次原单，不换卡；资金异常也不触发换卡。确认订阅成功为 `success`；归属一致的已受理订阅明确失败后，释放该卡并冷却 5 分钟、保留 CDK，最多换两张不同现有卡，总计最多 3 次。仍有额度进入 `retry_waiting`，无卡、重试准备失败或耗尽才 `support_locked`。首笔明确拒绝提交为 `rejected`，释放占用；历史 `manual` 和无可核验失败证据的旧等待记录不自动付款。

自助沿用已有 retry 字段与子任务保存每次尝试，管理员原 `request_id` 不变、旧失败订单追加到新列 `retry_history MEDIUMTEXT`，由启动自动迁移；次数和已用卡持久化，重启不重置。Session 只留内存，管理员最多保留 15 分钟、64 份，并检查其自身有效期。失效、丢失或重启后保持 `retry_waiting`，要求原 CDK 或原管理员 `request_id`、同账号新 Session 及匹配的原平台/API Key，继续剩余额度。数据库账号需保留 ALTER 权限。

支付卡在订阅确认成功或已提交后明确失败时进入 5 分钟冷却；授权次数同步完成也需等待冷却结束。启动自动补齐 `orbitcard_managed_cards.reuse_after_ms` 字段，无需新增环境变量。冷却期间可选其他合格卡，全池冷却则暂停分配；多实例需同步系统时间。

卡片已释放占用且冷却到期后，新增授权仍未同步只阻止复用该卡，保留原授权门槛；已知冻结闲卡也排除。有其他合格现有卡时继续选择，缺卡停止，不自动开卡；真正占用、冷却未结束、未知次数或状态、未决资金操作仍按原等待和对账规则处理。后台同步只更新资料和处理退役。

主流程优先使用现有卡，足额时直接准备订阅；卡内不足才用账户 `available_balance` 与补款差额比较，差额含产品最低留存，不扣除其他卡片余额。首笔账户不足时直接报错，释放未提交且没有未决资金操作的卡片和 CDK；重试准备失败保留 CDK 供售后；历史 `balance_blocked` 仍可按原规则恢复，新任务不再进入该状态。账户足够则提交一次补款，自助和管理员订单统一每至少 5 秒只读核对原流水与卡余额，更长 `Retry-After` 优先，原 Session 续跑等待最多 120 秒。等待不持全局选卡锁，窗口内到账足额且 Session 有效才提交原订阅一次。超时、Session 失效或重启后转为 `funding_review` 人工对账工单（自助任务 `status=manual`）；后台只读原资金号。有已保存订单号的 `funding_pending` 同样继续只读原流水，须通过原平台、凭据、卡片和金额校验；补款成功还需余额足额才记为 `ready`。原资金确认 `ready` 或 `failed` 后，在事务中复核无未决操作再释放未提交任务的卡片与普通 CDK，要求最新 Session。人工核销不阻断原资金对账，已核销及支付重试 CDK 仍保持锁定；资源清理不依赖交易授权同步。未知结果不能仅因超时释放。

历史 `card_pending` 有原平台订单号时使用原 key 和 Body 确认同一开卡申请；`prepared` 意图按未发送确认失败，可能已发送但无订单号的意图不重放。本地原申请 `ready` 或 `failed` 后经事务核验安全收尾，不提交会员充值。普通 `manual`、`support_locked` 不恢复付款。资金恢复复用现有资金表及状态，`orbitcard_card_fundings` 和历史 `task_logs.orbitcard_required_balance` 继续保留；管理员重试历史需新增上述 `retry_history` 列，无新增环境变量。旧安全余量配置不再参与计算。

## 从包含本地支付的旧版本升级

1. 先在旧后台暂停新任务，核对并等待正在执行的旧支付；无法确认的订单保留 CDK 占用。
2. 备份原 MySQL 数据、`.env` 和宿主机数据目录，保留原项目名、`DB_NAME` 和数据库密码。
3. 更新源码，将 `.env.example` 新增的必需项合并进已有 `.env`。签名密钥不足 32 字节会拒绝启动；更换后原管理员登录令牌失效，需要重新登录。
4. 使用原 Compose 项目启动更新。不要同时运行旧应用和新应用并共享同一个数据库。

```bash
git pull
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

项目默认名仍为 `kc-gpt-pay2`，MySQL 命名卷仍为 `mysql_data`。此前使用 `-p` 或 `COMPOSE_PROJECT_NAME` 的部署必须继续使用相同项目名；否则会创建另一套数据库卷。不要用 `docker compose down -v` 更新服务。

启动只创建缺少的核心表和字段，不执行 `DROP` / `TRUNCATE`，也不清空旧卡池、账单、Session 或历史配置。历史非 Orbitcard 运行任务改为 `manual` 并保留 CDK，不再执行原流程。历史完整 Session 等敏感记录仍可能存在于旧数据库，请按原有备份权限管理。

旧浏览器、验证码、卡池、代理、本地支付链接调试和本地账单接口已移除。当前 Orbitcard 调试与日志统一在新入口；刷新后台缓存，前端资源与镜像一并发布。

手动开卡已统一为共享卡池申请，管理接口 `POST /api/admin/orbitcard/cards/apply` 只接收 `{}`，旧 `plan_type` 参数会被拒绝；未确认的历史申请继续通过原 key 和 Body 恢复。自定义管理客户端需使用 `Authorization: Bearer`，不再把令牌放在 URL；`gpt-api/status` 不再附带 `recent_orders`，订单查询入口保留。产品预览不再返回每产品的 `plans` 字段。无需删除历史订单、卡片数据或迁移记录。

## 环境更新与存储

对接 dujiao-next 核销通知时，需要同时发布商城接收端及本程序，并在两端配置相同的独立签名密钥。先启用商城接收端，再设置本程序的 `CDK_REDEMPTION_WEBHOOK_URL`、`CDK_REDEMPTION_SOURCE`、`CDK_REDEMPTION_WEBHOOK_SECRET` 并重建应用。商城 URL 是实际部署域名下的 `/api/v1/card-secrets/redemption-callback`，不是 GitHub 地址。首次启用仅发送之后新确认的核销，不自动回填历史数据。完整部署与排查见 [README 核销回调说明](README.md#主动通知-dujiao-next-商城核销)。

```bash
# 更新源码、依赖或 Dockerfile
docker compose up -d --build app

# 只改 .env，让新变量进入容器
docker compose up -d --force-recreate app
```

`docker compose restart app` 不会注入新的环境值。已有 MySQL 数据卷的内部账号密码也不会因修改 `.env` 自动轮换。

Compose 保留 `${APP_DATA_DIR:-./data}` 到 `/app/data` 的旧数据挂载，新增 `${APP_LOG_DIR:-/var/log/pay-gpt-orbit}` 到容器 `/var/log/pay-gpt-orbit` 的独立日志挂载。Linux 默认宿主路径在系统盘；Windows Docker 请将 `APP_LOG_DIR` 设置为 `C:/ProgramData/Pay-gpt-Orbit/logs`（以实际系统盘为准）。源码从镜像加载；只更新宿主机代码而不重建应用镜像不会更新正在运行的代码。

`TASK_LOG_DIR` 可覆盖裸机日志路径；留空时 Linux 默认 `/var/log/pay-gpt-orbit`，Windows 默认系统盘的 `ProgramData\Pay-gpt-Orbit\logs`。Compose 容器内固定使用 `/var/log/pay-gpt-orbit`，宿主位置由 `APP_LOG_DIR` 指定。部署账号需要能创建、追加、替换和删除该目录中的文件。每个应用实例使用独立日志目录，不能由多个进程共同写入同一目录。

日志按北京时间的自然日分组，保留当天及之前 14 天，共 15 天。运行日志为根目录的 `runtime-YYYY-MM-DD.jsonl`；订单日志为 `YYYY-MM-DD/task-订单编号.jsonl`。程序在每天零点直接按文件名/日期目录删除过期日期的日志，不每小时检查，不解析日志内容，也不重写日志。启动时补清理停机期间过期的日志一次，然后等待下一个北京时间零点；清理失败记录错误并在下个零点再试。后台支持跨天翻页及合并下载，过期日期删除后自动重置翻页位置。清理只删除本程序命名的日志文件和清空后的日期目录，保留其他文件及数据库业务记录。Docker 控制台日志仍按容量轮转。

升级前先停止应用，将旧 `${APP_DATA_DIR:-./data}/logs` 下的 `runtime-*.jsonl` 和 `task-*.jsonl` 文件保留修改时间复制到新的空日志目录，再重建启动；新目录必须可写。不要把已有同名文件直接覆盖。旧版未分天的 `task-*.jsonl` 不再追加写入，兼容读取，并按文件最后修改日期整份过期删除；旧运行日志按文件名日期删除。确认迁移成功后再按备份策略处理旧目录；旧目录不会被程序自动删除。

旧镜像和构建缓存不会因换用轻量镜像自动消失。应用确认运行后，可先用 `docker system df` 查看占用，再按实际镜像和容器引用情况制定清理方案。

## 单独调试一套环境

另一套环境必须同时隔离项目名、容器名、端口、数据目录和日志目录。只改容器名仍会发生端口冲突或共享日志。示例：

```bash
PORT=3001 MYSQL_PORT=3311 APP_DATA_DIR=./data-isolated \
APP_LOG_DIR=/var/log/pay-gpt-orbit-isolated \
APP_CONTAINER_NAME=pay-gpt-orbit-isolated-app \
MYSQL_CONTAINER_NAME=pay-gpt-orbit-isolated-mysql \
docker compose -p pay-gpt-orbit-isolated up -d --build
```

新项目名会使用全新的 MySQL 数据卷，因此需要有效的首次初始化管理员密码。该示例不会读取原环境的业务数据库。

## 裸机

创建 MySQL 数据库并配置 `.env`：

```sql
CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

```bash
npm ci --omit=dev --ignore-scripts
npm start
```

Windows 使用 `npm.cmd`，安装脚本为 `powershell -File scripts/install-windows.ps1`。Linux/macOS 可运行 `sh scripts/install.sh`。脚本不再接受浏览器安装参数。

## 验证与排查

`npm test` 使用模拟上游，不调用真实充值接口；后台真实扣款测试位于「调试与日志 → 支付预检与测试」，会实际支付。部署后确认 MySQL 迁移（包含 retry_history）完成、日志可写、管理员可登录，再在「接口查询」测试连接及「支付预检与测试」进行只读预检。运行事件在「运行日志」，管理员订单和支付日志在「订单链路」，登录审计在「登录记录」。

| 现象 | 检查 |
| --- | --- |
| Compose 提示缺少配置 | `DB_PASSWORD` 和 `ADMIN_TOKEN_SECRET` 是否非空 |
| 首次启动要求管理员密码 | 新数据库需要 8 位以上登录密码和二级密码 |
| 启动拒绝签名密钥 | `ADMIN_TOKEN_SECRET` 是否为随机值且不少于 32 字节 |
| 新兑换返回暂未开放 | 后台 Orbitcard 接单开关是否启用 |
| Key 或 Secret 未配置 | 检查服务器 `.env` 中的 `ORBITCARD_API_KEY`、`ORBITCARD_API_SECRET`，并重建应用容器 |
| HMAC 失败 | Key/Secret 配对、HTTPS 根域名、系统时钟与权限 |
| 历史 CDK 因账户余额锁定 | 管理员向平台账户充值，后台只读检查达到保存门槛后释放；新任务余额不足直接失败释放 |
| 补款待确认 | 有原订单号时每至少 5 秒只读核对，原 Session 最多等待 120 秒；之后 `funding_review` / `funding_pending` 继续只读原流水，身份校验与资金结果确认后安全释放。无订单号或持续身份异常保留原记录，不换键补款 |
| 卡片长期等待授权 | 释放且冷却到期的旧卡仍禁复用，可选其他合格现有卡；缺卡需管理员手动申请，订单不自动开卡 |
| 开卡待确认 | `card_pending` 有原订单号时以原 key 和 Body 确认；未发送意图可失败，无订单号的未知意图保留人工核对。确认本地 `ready` / `failed` 后安全收尾 |
| CDK 显示待确认 | 未知订阅只查原单，不能根据超时释放或重新下单；若为 retry_waiting 且 Session 已丢失，用原账号新 Session 继续剩余额度 |
| 旧记录没有下载日志 | 升级前未持久化的内存日志无法补录 |

反向代理需支持 HTTPS，并转发 WebSocket Upgrade 头；HTTP 查单也能恢复订单状态。
