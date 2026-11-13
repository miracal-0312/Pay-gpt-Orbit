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

后台只填写 API 根域名和开卡策略，凭据状态会显示在页面上；可设置最高 USDT 服务费、开卡产品代码和单卡首充上限。升级后请先在「套餐卡支付金额（USD）」填写需要开放的各档金额；未配置或留空时暂停该套餐代充。金额应与所选支付地区相符，最多 8 位小数，保存于现有数据库配置键 orbitcard_plan_prices，不增加环境变量。新产品接口不提供套餐报价，不再使用 gpt_plan_prices；USDT 平台服务费也不能当成 USD 卡支付金额。修改地区或平台价格变化时应同时核对金额。在「Orbitcard 配置 → 默认充值地区」中分别选择 Plus、Pro 100、Pro 200、Pro 500 的地区后保存。选「平台默认」则省略 `payment_region`，指定地区则在资金操作前校验并用于用户兑换和管理员开通。地区选项从平台读取；先保存根域名配置，再刷新可用地区。地区查询失败会保留现有选择，失效地区不会自动回退。升级后四档均使用平台默认，不恢复历史已废弃的地区设置；此项保存在数据库配置键 `orbitcard_payment_regions` 中，无需增加环境变量或手动迁移表。无需填写固定平台卡 ID：配置页展示平台卡列表里的 ID，实际支付会重新读取并选卡。「接口调试」提供连接、套餐余额及只读地区查询；「支付链路调试」提供只读预检和真实扣款测试，均需先完成二级验证。真实测试不消耗 CDK，使用正式的自动选卡、补款/开卡与原单查询流程。日志持久化到现有 `TASK_LOG_DIR` 卷，支持按编号读取和下载；无需新增环境变量；卡池字段由启动迁移自动补齐，需要数据库 ALTER 权限。API Key 需有 `cards:create`、`cards:read`、`cards:manage`、`products:read`、`cards:fund`、`account:read` 和订阅相关权限；计次及交易对账需要 `transactions:read`。确认所需套餐的 USD 金额已保存、连接与余额有效后再打开接单开关。

所有套餐共用每卡 7 次成功消费授权上限，按 cardTransaction 返回的成功消费授权 ID 去重累计，包含接口可见的其他项目历史交易；本地开通结果不再直接加次数。授权计数依据类型、成功状态和交易 ID，不再检查交易金额，金额缺失或为零也计次。启动补齐授权账本及字段，首次同步读取完整平台记录。达到上限的空闲卡由后台维护删除，不自动补位；本地卡池不设数量上限。后台和同步卡片均不再自动开卡，管理员可手动申请一张，新卡首充 20 USD。支付主流程先用现有卡，不先补满卡池；确实无可用卡时只退役必要卡并开一张。选卡要求 ACTIVE、USD、余额资料完整且未被其他任务占用；余额不足则补差额，缺卡时按需开一张。删卡需要 cards:manage 权限；transactions:read 用于完整读取授权记录计次及交易对账，不等待清算。授权记录尚未同步、分页异常或状态未识别时暂停使用该卡。ACTIVE 和 CANCELLED 卡直接申请删除；未知删除结果只读查询确认，不再次提交删除，也不依据余额快照退款。未确认删除不补位；卡池不设目标张数，不再自动补满；历史未决开卡继续按原身份对账。完整规则见 [ORBITCARD-CARDS.md](ORBITCARD-CARDS.md)。

旧 `app_config` 中的套餐预算和支付地区值不再读取或写入；本次凭据调整要求新增 `ORBITCARD_API_KEY` 环境变量，并与 `ORBITCARD_API_SECRET` 配对。选卡详情按 20 张一批读取，选中后不逐张复核；补款提交前及确认后仍核对卡片资金。任务创建由 CDK 行锁串行化，卡片分配由 MySQL 命名锁串行化；提交前以同一订单身份原子认领 `prepared → submitting`，失败的并发执行者不得调用 `createSubscription`。平台请求继续使用固定 `client_order_no` 幂等键，超时后只查原单。这个保护不改变上文“同一套任务只运行一个应用实例”的部署要求。套餐目录服务费不参与本地预检或后台目录展示；已配置的最高 USDT 服务费仅随 `createSubscription` 提交，由平台校验。HTTP 429 后同一 Key 的 Open API 操作遵守 `Retry-After`。订阅成功后有只读资金快照，管理员可按卡查询消费交易用于对账；此功能需要已有的 `transactions:read` 权限，不执行自动退款。

新自助任务从 `preparing` 开始，卡片与资金就绪后进入 `prepared`，随后原子认领 `submitting` 并只提交一次订阅。提交超时或结果未知保持 `pending`，由后台查询原订单，不自动转为 `manual`。自助和管理员订单统一按原单结论结算：成功为 `success`；已受理后明确失败为 `support_locked`，保留 CDK、释放卡片并冷却 5 分钟；明确拒绝提交为 `rejected`，释放 CDK 和卡片。旧 `manual` 保留人工状态，`retry_waiting` 转为售后锁定，均不恢复付款。旧重试字段保留用于历史归属及审计；数据库账号必须保留升级所需的 `ALTER` 权限。

支付卡在订阅确认成功或已提交后明确失败时进入 5 分钟冷却；授权次数同步完成也需等待冷却结束。启动自动补齐 `orbitcard_managed_cards.reuse_after_ms` 字段，无需新增环境变量。冷却期间可选其他合格卡，全池冷却则暂停分配；多实例需同步系统时间。

卡片已释放占用且冷却到期后，新增授权仍未同步只阻止复用该卡；若没有其他合格现有卡，新订单可按需开一张，不清除旧卡的授权门槛。已知冻结的空闲卡也先排除。真正忙碌、冷却未结束、未知授权次数或卡片状态、未决开卡或删卡仍阻止新开卡。后台同步继续只更新资料和处理退役，不自动开卡。

主流程优先使用现有卡，足额时直接准备订阅；卡内不足才用账户 `available_balance` 与补款差额比较，差额含产品最低留存，不扣除其他卡片余额。账户不足时直接报错，释放未提交且没有未决资金操作的卡片和 CDK；历史 `balance_blocked` 仍可按原规则恢复，新任务不再进入该状态。账户足够则提交一次补款，自助和管理员订单统一每至少 5 秒只读核对原流水与卡余额，更长 `Retry-After` 优先，原 Session 续跑等待最多 120 秒。等待不持全局选卡锁，窗口内到账足额且 Session 有效才提交原订阅一次。超时、Session 失效或重启后转为 `funding_review` 人工对账工单（自助任务 `status=manual`）；后台只读原资金号。有已保存订单号的 `funding_pending` 同样继续只读原流水，须通过原平台、凭据、卡片和金额校验；补款成功还需余额足额才记为 `ready`。原资金确认 `ready` 或 `failed` 后，在事务中复核无未决操作再释放未提交任务的卡片与普通 CDK，要求最新 Session。人工核销不阻断原资金对账，已核销及历史支付重试 CDK 仍保持锁定；资源清理不依赖交易授权同步。未知结果不能仅因超时释放。

`card_pending` 有原平台订单号时使用原 key 和 Body 确认同一开卡申请；`prepared` 意图按未发送确认失败，可能已发送但无订单号的意图不自动重放。本地原申请 `ready` 或 `failed` 后经事务核验安全收尾，不提交会员充值。普通 `manual`、`support_locked` 不恢复付款。本次恢复修复复用现有表和状态，无新增环境变量或数据库列；已有 `orbitcard_card_fundings` 表和历史 `task_logs.orbitcard_required_balance` 字段继续保留。旧安全余量配置不再参与计算。

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

旧浏览器、验证码、卡池、代理、支付调试和本地账单接口已移除。后台页面应刷新缓存，新前端资源与镜像版本一起发布。

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

`npm test` 不调用真实充值接口。部署后还需确认 MySQL 迁移完成、任务日志可写、管理员可登录，并在后台测试 Orbitcard 连接。

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
| 卡片长期等待授权 | 已释放且冷却到期的卡仍禁复用，但不会单独阻止新订单按需开卡；检查是否还有真实占用、未知次数/状态或未决开卡、删卡 |
| 开卡待确认 | `card_pending` 有原订单号时以原 key 和 Body 确认；未发送意图可失败，无订单号的未知意图保留人工核对。确认本地 `ready` / `failed` 后安全收尾 |
| CDK 显示待确认 | 查询原单，不能根据超时直接释放或重新下单 |
| 旧记录没有下载日志 | 升级前未持久化的内存日志无法补录 |

反向代理需支持 HTTPS，并转发 WebSocket Upgrade 头；HTTP 查单也能恢复订单状态。
