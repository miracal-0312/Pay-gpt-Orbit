# 部署与升级

## 环境

- Node.js 24 或更新版本，MySQL 8；Docker 部署使用 Compose V2。
- 数据库账号需要应用库建表、索引、ALTER 和读写权限。
- 服务器可以访问配置的 Orbitcard HTTPS 根域名，系统时钟保持同步。
- 只运行一个应用实例管理同一套任务；目前没有跨实例的任务租约。

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
ORBITCARD_API_SECRET='replace_with_platform_issued_secret'
```

不要使用这些占位值。登录密码和二级密码首次初始化时至少 8 位；已有账号由数据库管理，改 `.env` 不会重置已有账号。CDK 管理需要有效的管理员登录和二级验证。

生成随机管理员签名密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Orbitcard Secret 必须使用平台签发、与 API Key 配对的值。它只保留在服务端环境。含 `$`、`#` 或空格的配置使用单引号包裹，不要把 `.env` 当 shell 脚本执行。

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

容器内应用固定使用 `mysql:3306`、数据库用户 `root`，宿主机应用端口取 `PORT`。数据库宿主机端口取 `MYSQL_PORT`（默认 3310），只绑定 `127.0.0.1`。HTTP 健康检查 `/api/health` 检查应用与数据库，不保证 Orbitcard 凭据和卡片余额有效。

后台填写 API 根域名、API Key；可分别设置 Plus、Pro 100、Pro 200、Pro 500 的默认支付地区，并可设置最高 USDT 服务费、开卡产品代码和单卡首充上限。先保存 Key 和域名，再点击「读取各套餐可用地区」；每档留空时下单省略 `payment_region`，由平台自行选默认地区，不要求目录带 `default=true`。旧全局 `orbitcard_region` 值保留，但不参与新订单。产品未返回会员 USD 价格时，填写四档单次预算；不要把 USDT 平台服务费当成会员支付金额。无需再填写固定平台卡 ID。测试连接只查询套餐与余额；在「卡片与开卡」查询产品、同步卡片及脱敏消费交易检查读取权限。API Key 增加 `cards:create`、`cards:read`、`products:read`、`cards:fund`、`transactions:read`，余额查询需 `account:read`；无需敏感卡资料权限。确认配置有效后打开接单开关，再创建对应套餐的 CDK。

同一卡可以 Plus 4 次、Pro 100/200/500 各 1 次，分别计数、允许混用，共最多 7 次。历史卡同步后需二级验证确认四项历史次数。充值先检查账户 `available_balance`；不足套餐金额时锁定 CDK 并提醒联系管理员。之后拉取平台卡列表与批量详情，只从 ACTIVE、USD、资料和次数合格且未占用的卡中选一张；缺项时跳过该卡，不逐张补查。有剩余次数的卡异常或占用时锁定 CDK 并提示人工售后；无卡或当前套餐次数用尽时自动首充 20 USD 开卡，卡余额不足则补差额。管理员也可手动申请卡，完整规则见 [ORBITCARD-CARDS.md](ORBITCARD-CARDS.md)。

本次幂等与地区配置更新不新增环境变量或数据库表迁移；四档地区值由现有 `app_config` 自动初始化。选卡详情按 20 张一批读取，选中后不逐张复核；补款提交前及确认后仍核对卡片资金。任务创建由 CDK 行锁串行化，卡片分配由 MySQL 命名锁串行化；提交前以同一订单身份原子认领 `prepared → submitting`，失败的并发执行者不得调用 `createSubscription`。平台请求继续使用固定 `client_order_no` 幂等键，超时后只查原单。这个保护不改变上文“同一套任务只运行一个应用实例”的部署要求。套餐目录服务费不参与本地预检或后台目录展示；已配置的最高 USDT 服务费仅随 `createSubscription` 提交，由平台校验。HTTP 429 后同一 Key 的 Open API 操作遵守 `Retry-After`。订阅成功后有只读资金快照，管理员可按卡查询消费交易用于对账；此功能需要已有的 `transactions:read` 权限，不执行自动退款。

支付换卡任务使用 `task_logs` 中的重试序号、首卡／次卡 ID、重试根任务及 API Key 身份哈希字段；数据库账号必须保留 `ALTER` 权限。无需新增环境变量。每张卡只提交一笔订阅；仅在平台明确确认失败后换另一张卡，最多换两次。第三张卡也明确失败时 CDK 标为人工售后锁定，不能再次兑换。超时或未知结果只查询原订单，不消耗下一次尝试。服务重启后确认上一单失败时，客户需重新提交原账号最新 Session。

账户余额不足、开卡待确认、补款待确认均保留原身份与 CDK。余额恢复或后台确认卡准备完成后，需要用户重新提交最新 Session；不自动执行会员充值。升级新增 `orbitcard_card_fundings` 表和 `task_logs.orbitcard_required_balance` 字段，需要建表与 ALTER 权限。旧安全余量配置不再参与计算。

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

## 环境更新与存储

```bash
# 更新源码、依赖或 Dockerfile
docker compose up -d --build app

# 只改 .env，让新变量进入容器
docker compose up -d --force-recreate app
```

`docker compose restart app` 不会注入新的环境值。已有 MySQL 数据卷的内部账号密码也不会因修改 `.env` 自动轮换。

Compose 只挂载 `${APP_DATA_DIR:-./data}` 到 `/app/data`，审计日志在其中的 `logs`。源码从镜像加载；只更新宿主机代码而不重建应用镜像不会更新正在运行的代码。

`TASK_LOG_DIR` 仅用于裸机自定义日志路径；Compose 固定使用 `/app/data/logs`。部署账号需要能创建并追加文件。备份数据库和数据目录，监控磁盘空间；Docker 控制台日志轮转不会删除任务 JSONL 历史。

旧镜像和构建缓存不会因换用轻量镜像自动消失。应用确认运行后，可先用 `docker system df` 查看占用，再按实际镜像和容器引用情况制定清理方案。

## 单独调试一套环境

另一套环境必须同时隔离项目名、容器名、端口和数据目录。只改容器名仍会发生端口冲突或共享日志。示例：

```bash
PORT=3001 MYSQL_PORT=3311 APP_DATA_DIR=./data-isolated \
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
| Secret 未配置 | 服务器 `.env` 是否填写 `ORBITCARD_API_SECRET`，修改后是否重建容器 |
| HMAC 失败 | Key/Secret 配对、HTTPS 根域名、系统时钟与权限 |
| CDK 因账户余额锁定 | 管理员向平台账户充值，后台只读检查达到保存门槛后释放；重新提交 Session |
| 补款待确认 | 检查卡资金/交易读取权限，确认原订单流水，不换键补款 |
| CDK 显示待确认 | 查询原单，不能根据超时直接释放或重新下单 |
| 旧记录没有下载日志 | 升级前未持久化的内存日志无法补录 |

反向代理需支持 HTTPS，并转发 WebSocket Upgrade 头；HTTP 查单也能恢复订单状态。
