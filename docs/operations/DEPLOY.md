# 部署与升级

管理员邮件提醒在后台配置 SMTP 后启用，详见[邮件通知](EMAIL-NOTIFICATIONS.md)。本次更新包含 `nodemailer` 依赖与三张独立通知表，需要安装依赖或重建镜像，并允许应用创建缺少的表。邮件配置默认关闭；SMTP 密码使用 `ADMIN_TOKEN_SECRET` 加密，变更该密钥后须重新保存邮件密码。

## 环境

- Node.js 24 或更新版本，MySQL 8；Docker 部署使用 Compose V2。
- 数据库账号需要应用库建表、索引、ALTER 和读写权限。
- 服务器可以访问配置的 Orbitcard HTTPS 根域名，系统时钟保持同步。
- 生产部署仍使用一个应用实例管理同一套任务。支付执行已增加跨进程 MySQL 命名锁，但并发容量、WebSocket 推送和上游限流缓存仍按进程维护，不能据此直接扩容为多副本。
- 命名锁须连到同一个 MySQL 主库，不能经过按请求切换连接的事务池代理。执行锁和选卡锁使用独立连接：每笔活跃支付最多额外占用两条连接；设置 MySQL 连接额度时，在业务查询池、这些锁连接之外保留管理和恢复任务余量。无需新增环境变量。

生产运行不需要 Chromium、Python、PyTorch、Transformers、OpenCV 或 noVNC；Python 仅用于可选的开发检查脚本。平台卡 ID 是 Orbitcard 侧的卡片标识，不是本项目的卡池 ID。

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

## 业务配置与数据库迁移

后台保存 HTTPS API 根域名、各档套餐的 USD 卡支付金额、默认充值地区、最高 USDT 服务费及单卡首充上限。API Key / Secret 只从服务端环境变量读取；更换平台或凭据前先核对未完成原订单。USD 金额保存在 `orbitcard_plan_prices`，最多 8 位小数，留空时暂停对应套餐。产品接口不提供套餐报价，USDT 服务费也不能代替 USD 卡支付金额。地区保存在 `orbitcard_payment_regions`；平台默认省略 `payment_region`，指定地区在资金操作前校验，失败不回退。修改地区后须重新核对金额。

渠道与 BIN 在后台通过 `getProductCode` 实时读取并多选，分别保存为 `orbitcard_product_codes`、`orbitcard_bins`；各自留空表示全部，同时选择取交集。旧单一产品配置迁移为单项选择；这些偏好与开卡产品规则不筛选现有支付卡。手动开卡和错误补开均为首充 20 USD、数量 1，需同时满足产品库存、最低首充、账户余额和配置上限。

每张卡累计最多成功支付 3 次，选卡前核对 API 可见的历史成功订单，事务预占再次校验次数。第三次成功时持久化停用原卡。历史满额卡同样停止分配。仅当有实际支付任务且预选无合格现有卡时，才按需补开一张，新卡首充固定 20 USD。实际选卡还检查 ACTIVE、USD、资料与余额、本地 `disabled_*` 停用记录、占用及未决资金。已验证的卡片相关失败仍会持久化停用，补开按原失败任务唯一登记。结算、卡片同步与后台恢复不自动发送开卡请求。同步保留停用标记和历史计数；删卡结果未知时只读核对，补开沿用持久化身份。需要历史订阅读取、开卡权限及足够余额。此改动复用成功订单账本、停用字段和补开唯一约束。

每条支付链最多 3 次尝试；Session、账号、配置或未知原因的已确认终态失败转 `support_locked`。受理未知只查原订阅；补款有原资金号时只读核对，无号的已发送补款保留人工核对，不重复 POST。卡片错误补开不重置支付次数。共享等待最多 1 个任务、30 分钟；补款原 Session 续跑等待最多 120 秒，之后仅核对资金并安全收尾。详细流程和全部错误措施见[卡池规则](ORBITCARD-CARDS.md)与[充值审计](../architecture/RECHARGE-AUDIT.md)。

启动由 `database/mysql-schema.sql` 与 `src/db/mysql-store.js` 创建缺少的表、字段及索引，包括成功订单账本、独立授权账本、`disabled_*`、补开来源/唯一索引和管理员 `retry_history`。数据库账号需要 CREATE、ALTER、索引及读写权限；迁移不删除历史表列或业务记录。旧 `orbitcard_max_authorizations`、`reuse_after_ms`、`authorization_pending_count`、`authorization_baseline` 不再参与业务判断；已存在的旧列不主动 DROP。Session 只留内存，重启后需要同账号新 Session 才能继续符合规则的剩余尝试。

API Key 需具备 `subscriptions:read/create`、`cards:create/read/fund`、`products:read`、`account:read`，消费与资金流水对账需 `transactions:read`。后台「调试与日志」提供接口查询与只读预检，真实扣款测试需单独二级验证和扣款确认。确认迁移、日志、权限、USD 金额、卡片及账户资金后开放接单。完整操作见[使用说明](USER-GUIDE.md)、[调试说明](DIAGNOSTICS.md)。

本次套餐补款规则更新后，卡内不足时按套餐完整 USD 金额（向上取到分）充值，足额不充值；账户不足提示联系客服。现有卡支付目标为套餐 USD 金额，不叠加开卡产品最低留存；旧资金意图的原金额、已保存 `target_balance`、正文、幂等键保持不变，升级不批量修改或重发补款。金额示例见[套餐整额补款](ORBITCARD-CARDS.md#套餐整额补款)。

## 日常更新与重启

先暂停新增接单，等待并核对正在执行的支付，备份数据库、原 `.env` 和数据目录。始终在原部署目录和原 Compose 项目名下执行：

```bash
git status --short
git pull --ff-only origin main
git log -1 --oneline
docker compose up -d --build --no-deps app
docker compose ps
docker compose logs --tail=100 app
curl -fsS http://127.0.0.1:3000/api/health
```

有本地改动时先核对并保存，不用强制覆盖命令。健康检查成功返回 `{"success":true}`；宿主端口改过时替换命令中的 `3000`。检查后台功能与原订单恢复后再开放接单。代码目录整理后启动命令仍为 `npm start` / `node server.js`，数据库初始文件位于 `database/mysql-schema.sql`；Compose 挂载路径已同步调整，更新时需一起拉取部署文件。

只需重启、没有修改配置或代码时可执行 `docker compose restart app`。代码更新必须重新构建镜像；环境变量更新需要重建容器，见下一节。不要同时运行旧应用和新应用共享数据库，也不要用 `docker compose down -v` 更新。

## 从包含本地支付的旧版本升级

1. 先在旧后台暂停新任务，核对并等待正在执行的旧支付；无法确认的订单保留 CDK 占用。
2. 备份原 MySQL 数据、`.env` 和宿主机数据目录，保留原项目名、`DB_NAME` 和数据库密码。
3. 更新源码，将 `.env.example` 新增的必需项合并进已有 `.env`。签名密钥不足 32 字节会拒绝启动；更换后原管理员登录令牌失效，需要重新登录。
4. 使用原 Compose 项目启动更新。不要同时运行旧应用和新应用并共享同一个数据库。

```bash
git pull --ff-only origin main
docker compose up -d --build --no-deps app
docker compose ps
docker compose logs --tail=100 app
```

项目默认名仍为 `kc-gpt-pay2`，MySQL 命名卷仍为 `mysql_data`。此前使用 `-p` 或 `COMPOSE_PROJECT_NAME` 的部署必须继续使用相同项目名；否则会创建另一套数据库卷。不要用 `docker compose down -v` 更新服务。

启动只创建缺少的核心表和字段，不执行 `DROP` / `TRUNCATE`，也不清空旧卡池、账单、Session 或历史配置。历史非 Orbitcard 运行任务改为 `manual` 并保留 CDK，不再执行原流程。历史完整 Session 等敏感记录仍可能存在于旧数据库，请按原有备份权限管理。

旧浏览器、验证码、卡池、代理、本地支付链接调试和本地账单接口已移除。当前 Orbitcard 调试与日志统一在新入口；刷新后台缓存，前端资源与镜像一并发布。

手动开卡统一为共享卡池申请，`POST /api/admin/orbitcard/cards/apply` 只接收 `{}`，旧 `plan_type` 被拒绝；未确认历史申请按原 key 和 Body 核对。独立产品预览按钮已移除；`GET /api/admin/orbitcard/products` 现供配置页读取真实渠道与 BIN 多选目录。手动申请时自动读取产品并校验库存、固定首充及配置上限；现有卡支付准备和只读预检不查询开卡产品，不受渠道、BIN、库存或产品最低金额限制。产品只读排查统一使用“调试与日志 → 接口查询”。只读预检维护摘要删除自动补满和开卡的固定占位字段 `capacity_limit`、`auto_refill`、`open_count`、`opening_amount`；并发模拟统计不再返回始终为零的 `summary.opening`。管理客户端使用 `Authorization: Bearer`，不把令牌放 URL；`gpt-api/status` 不附带 `recent_orders`，订单查询仍保留。无需删除历史订单、卡片或迁移记录。

## 环境更新与存储

对接 dujiao-next 核销通知时，需要同时发布商城接收端及本程序，并在两端配置相同的独立签名密钥。先启用商城接收端，再设置本程序的 `CDK_REDEMPTION_WEBHOOK_URL`、`CDK_REDEMPTION_SOURCE`、`CDK_REDEMPTION_WEBHOOK_SECRET` 并重建应用。商城 URL 是实际部署域名下的 `/api/v1/card-secrets/redemption-callback`，不是 GitHub 地址。首次启用仅发送之后新确认的核销，不自动回填历史数据。完整部署与排查见 [商城核销回调说明](../integrations/CDK-REDEMPTION.md)。

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

`npm test` 使用模拟上游，不调用真实充值接口；后台真实扣款测试位于「调试与日志 → 支付预检与测试」，会实际支付。部署后确认 MySQL 迁移（包含停用字段、补开索引与 retry_history）完成、日志可写、管理员可登录，再在「接口查询」测试连接及「支付预检与测试」进行只读预检。运行事件在「运行日志」，管理员订单和支付日志在「订单链路」，登录审计在「登录记录」。

| 现象 | 检查 |
| --- | --- |
| Compose 提示缺少配置 | `DB_PASSWORD` 和 `ADMIN_TOKEN_SECRET` 是否非空 |
| 首次启动要求管理员密码 | 新数据库需要 8 位以上登录密码和二级密码 |
| 启动拒绝签名密钥 | `ADMIN_TOKEN_SECRET` 是否为随机值且不少于 32 字节 |
| 新兑换返回暂未开放 | 后台 Orbitcard 接单开关是否启用 |
| 弹窗提示 10 分钟后下单 | 唯一共享等待位已满；按提示稍后提交，已有等待任务用原 CDK 或请求编号查询 |
| 订单显示等待并发或卡片 | 全局最多 1 个等待任务，最长 30 分钟；前单释放后，本地停用标记、状态、余额和资金校验通过即自动继续，无固定卡片冷却 |
| 等待因超时、Session 失效或停机结束 | 首笔未付款且无未决资金可安全释放并重新提交 Session；支付重试 CDK 保持售后锁定，未知资金继续对账 |
| Key 或 Secret 未配置 | 检查服务器 `.env` 中的 `ORBITCARD_API_KEY`、`ORBITCARD_API_SECRET`，并重建应用容器 |
| HMAC 失败 | Key/Secret 配对、HTTPS 根域名、系统时钟与权限 |
| 历史 CDK 因账户余额锁定 | 管理员向平台账户充值，后台只读检查达到保存门槛后释放；新任务账户不足时提示联系客服，只有无未决资金的首笔准备才能安全释放 |
| 提示平台余额不足、需联系客服 | 管理员核对账户可用余额和当前套餐完整 USD 补款金额；不改写原资金意图，不要求用户重复提交未确认订单 |
| 补款待确认 | 有原订单号时每至少 5 秒只读核对，原 Session 最多等待 120 秒；之后 `funding_review` / `funding_pending` 继续只读原流水，身份校验与资金结果确认后安全释放。无订单号或持续身份异常保留原记录，不换键补款 |
| 卡片长期显示等待授权 | 当前流程不等待消费授权同步；核对容器是否更新，以及原订阅是否仍 pending、active_job 是否仍占用、是否有未决资金，不能仅凭授权流水为空强制释放 |
| 开卡待确认 | `card_pending` 有原订单号时以原 key 和 Body 确认；未发送意图可失败，历史绑定任务无订单号的未知意图保留人工核对；共享卡池开卡仍按固定 key 和原正文确认原申请。确认本地 `ready` / `failed` 后安全收尾 |
| CDK 显示待确认 | 未知订阅只查原单，不能根据超时释放或重新下单；若为 retry_waiting 且 Session 已丢失，用原账号新 Session 继续剩余额度 |
| 旧记录没有下载日志 | 升级前未持久化的内存日志无法补录 |

反向代理需支持 HTTPS，并转发 WebSocket Upgrade 头；HTTP 查单也能恢复订单状态。
