# Pay-gpt-Orbit 部署指南

本指南对应 **Orbitcard HMAC V1 + CDK** 版本，协议细节见 [orbitcard-subscription-api-v1.md](orbitcard-subscription-api-v1.md)。

## 1. 环境要求与模式

| 项目 | 配置 |
|------|------|
| Node.js | >= 24，推荐 24 LTS；可使用 `.nvmrc` 选择版本 |
| MySQL | 8.0；数据库账号具备应用库建表、ALTER、索引及读写权限 |
| Docker | 采用容器部署时使用 Compose V2；宿主机不需要额外安装 Node.js |
| 网络和时钟 | 服务端可访问 Orbitcard HTTPS 根域名；保持系统时间同步，避免 HMAC 时间戳验证失败 |
| 内存与磁盘 | 按数据库和并发量分配；完整浏览器镜像包含 Chromium、Python 和模型依赖，预留充足空间 |

仅 Orbitcard 模式只需 Node 依赖和数据库。设置 `BROWSER_POOL=0`、`HEADFUL=0`，无需安装 Chromium、配置本地卡池、代理或验证码服务。已有数据库的浏览器池开关优先，请在后台关闭。默认 Docker 镜像保留完整本地自动化组件，首次构建时间较长。

Node.js 支持周期见 [官方发布表](https://nodejs.org/en/about/previous-releases)。环境加载使用 [Node.js 原生 `process.loadEnvFile`](https://nodejs.org/docs/latest-v24.x/api/process.html#processloadenvfilepath)，不需要额外安装 dotenv。

## 2. 配置环境

项目地址为私有仓库 [miracal-0312/Pay-gpt-Orbit](https://github.com/miracal-0312/Pay-gpt-Orbit)，请使用有访问权限的账号克隆。

```bash
git clone https://github.com/miracal-0312/Pay-gpt-Orbit.git
cd Pay-gpt-Orbit
cp .env.example .env
```

PowerShell 复制命令为 `Copy-Item .env.example .env`。已有 `.env` 只合并新增变量，保留原有值。

在本机编辑 `.env`，填写以下值：

```dotenv
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD='your_database_password'
DB_NAME=plus_papay
DB_POOL_LIMIT=60
ADMIN_EMAIL=your_admin@example.com
ADMIN_PASSWORD='your_admin_password'
ADMIN_SECONDARY_PASSWORD='your_secondary_password'
ADMIN_TOKEN_SECRET='your_random_admin_signing_secret'
ADMIN_LOGIN_PATH=admin-login
ADMIN_PANEL_PATH=admin
ORBITCARD_API_SECRET='your_orbitcard_hmac_secret'
BROWSER_POOL=0
HEADFUL=0
```

示例值必须替换。可用以下命令生成管理员签名密钥；Orbitcard Secret 则必须使用平台签发的配对值：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`#`、`$` 和空格包含在值中时用单引号包裹。不要在文档、Git 或前端配置中填写真实凭据。

### 配置生效规则

- `server.js` 先读取项目根目录 `.env`，然后加载数据库等模块；从其他目录启动也读取项目内的文件。
- 已有进程环境变量优先，包括 Docker 注入值。不存在 `.env` 时可完全使用进程环境变量。
- 管理员邮箱、登录密码、二级密码、后台路径仅在初始化新数据库时使用；已有配置通过后台修改。
- API Key、平台卡 ID、地区、服务费上限及代充开关在后台保存到数据库，不通过 `.env` 初始化。
- `ORBITCARD_API_SECRET` 只存服务端环境，与 `CARD_SUPPLIER_WEBHOOK_SECRET` 用途不同。
- 不要把 `.env` 当成 shell 脚本执行。应用使用环境文件解析器，不执行其中的命令。

## 3. Docker 部署

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Compose 自动注入 Orbitcard Secret、管理员信息、数据库密码等配置；容器内部固定连接 `mysql:3306`、数据库用户 `root`，`DB_NAME` 与 `DB_PASSWORD` 取自 `.env`。容器内服务端口固定为 3000，宿主机映射使用 `PORT`。

| 入口 | 默认地址 |
|------|----------|
| 用户兑换 | `http://localhost:3000/` |
| 管理登录 | `http://localhost:3000/admin-login` |
| MySQL 宿主机映射 | `localhost:3310`（容器内部仍为 3306） |
| noVNC | `http://127.0.0.1:6080/vnc.html`，仅有头调试时使用 |

`/admin-login.html` 和 `/admin.html` 不作为访问入口；使用配置中的动态路径。

### 更新与重启

```bash
# 更新源码、依赖或 Dockerfile 后
docker compose up -d --build app

# 仅修改 .env 后，让新环境变量进入容器
docker compose up -d --force-recreate app

# 仅重启已有进程，不会更新容器环境变量
docker compose restart app

# 停止服务，保留数据库数据卷
docker compose down
```

项目名仍为 `kc-gpt-pay2`，数据库卷仍由同一项目管理。已有部署若使用 `-p` 或 `COMPOSE_PROJECT_NAME`，升级时继续使用相同值，并保留原 `DB_NAME`。不要执行 `docker compose down -v` 或删除 `mysql_data` 数据卷来更新应用。

已有 MySQL 卷不会因修改 `.env` 中 `DB_PASSWORD` 自动更改数据库密码。数据库密码轮换需同时更新 MySQL 内部账号和应用环境。

### 本地浏览器调试

需要本地 Stripe 流程时，在后台配置资产和代理。Docker 镜像已包含 Chromium 和 Python 组件。可设置：

```dotenv
HEADFUL=1
VNC_PASSWORD='your_debug_password'
NOVNC_PORT=6080
```

重建 app 后通过本机 noVNC 查看浏览器；远程主机可使用 SSH 隧道。仅 Orbitcard 模式保持 `HEADFUL=0` 即可。

## 4. 裸机部署

安装 Node.js 24 LTS 和 MySQL 8，创建数据库：

```sql
CREATE DATABASE IF NOT EXISTS plus_papay
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

若使用已有数据库，保留其名称和账号，不要重新初始化。应用启动会创建缺失表、执行兼容字段迁移。

```bash
npm ci --omit=dev --ignore-scripts
# 按第 2 节准备 .env
npm start
```

Windows PowerShell 使用 `npm.cmd ci --omit=dev --ignore-scripts` 和 `npm.cmd start`，避免 `npm.ps1` 的执行策略限制。

### 安装脚本

```bash
# Linux / macOS：仅 API 环境
bash scripts/install.sh

# 需要本地浏览器流程时
bash scripts/install.sh --with-browser
```

```powershell
# Windows：仅 API 环境
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

# 需要本地浏览器流程时
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -WithBrowser
```

脚本只在缺少 `.env` 时从模板创建，不覆盖已有配置。Linux/macOS 脚本在缺少 Node.js 时尝试安装 24，已安装旧版会提示升级；Windows 需要预先安装 Node.js。

手工安装本地浏览器可运行 `npx playwright install chromium`；Linux 需安装 Playwright 系统依赖。Windows 使用 `npx.cmd`。本地 Python 验证码组件按需在虚拟环境中安装 `requirements-hcaptcha.txt`，并把对应 Python 的绝对路径填入 `HCAPTCHA_SOLVER_PYTHON`。Orbitcard 人机验证使用上游链接，无需此组件。

### 进程守护

如使用 PM2，从项目目录启动：

```bash
pm2 start server.js --name pay-gpt-orbit
pm2 save
pm2 logs pay-gpt-orbit

# .env 或进程环境更新后
pm2 restart pay-gpt-orbit --update-env
```

如同一变量也在 PM2 环境中设置，需同步修改该值，它优先于 `.env`。

## 5. Orbitcard 后台配置与 CDK

1. 启动应用，确认后台显示服务端 Secret 已配置。
2. 填写 HTTPS 根域名（默认 `https://orbitcard.cc`），不追加 `/api/open/v1` 或查询参数。
3. 填写与 Secret 配对的 API Key。订阅需要 `subscriptions:read`、`subscriptions:create`；查询余额需要 `account:read`。
4. 填写本人平台卡 ID，必须是正整数，不是卡号或卡后四位。通过平台 `getCardList` 查卡需要 `cards:read`。
5. 可选两位支付地区代码与最高 USDT 服务费。地区留空时使用上游对应套餐默认值，可用性实时查询。
6. 测试连接、保存并启用第三方代充，再发放对应套餐自助 CDK。

连接测试只调用套餐与余额查询，不创建订单。开启开关本身也不充值；用户兑换 CDK 并提交完整 Session JSON 时才会下单。裸机仅 API 环境未启用 Orbitcard 时，不具备本地浏览器支付条件。

CDK 套餐映射见 [README](README.md#启用-orbitcard)。每次兑换先事务绑定 CDK 与本次订单身份，再调用创建接口。订阅成功核销；明确拒绝或明确失败释放；超时和未知结果继续占用。

前台可通过 `POST /api/cdk/orbitcard/status` 查询原订单，重启后仍能恢复；关闭代充接单后仍可查已有订单。需要保留原根域名及可访问订单的凭据。查询不创建新订单，未知状态不要手工清除占用后重复下单。

验证码链接仅在当前响应和内存中传递，不持久化；完成验证后继续查原单。自动查询最多 15 分钟，之后可手动继续。服务费失败与订阅失败分别展示。

## 6. 从旧协议升级

升级前备份应用数据库及已有 `.env`，然后更新源码、环境并重启应用。

- 原 Orbitcard 配置保留。
- 尚未迁移的旧 Bearer 代充配置被停用，旧 API Key 清空，地址恢复 Orbitcard 默认值。
- `gpt_api_protocol_version=orbitcard-hmac-v1` 标记一次性迁移；旧协议、套餐 key、国家和币种配置项被移除。
- 启动为 `task_logs` 添加 `orbitcard_client_order_no`、`orbitcard_state`、`orbitcard_plan_type`、`orbitcard_email`、`orbitcard_base_url` 字段。
- 历史任务、账单及卡池数据保留。原供应商未完成订单需在原供应商侧核实。

确认新配置有效并启用 Orbitcard 后再开放兑换。关闭代充时新兑换仍走原本地流程；升级不会为未知订单自动补下新单。

## 7. 部署验证与排查

```bash
# 无外部依赖、无付费请求的回归测试
npm run test:orbitcard

# 安装开发依赖后运行 Vitest
npm ci --ignore-scripts
npm test
```

部署后检查应用日志无数据库迁移错误、后台 Secret 状态已配置，并执行后台连接测试。连接测试不验证实际卡片扣款能力；真实 CDK 兑换会创建订阅订单。

| 现象 | 检查 |
|------|------|
| Secret 显示未配置 | `.env` 是否在项目根目录；Docker 是否重新创建 app；是否存在同名空进程环境变量 |
| HMAC 鉴权失败 | Key 与 Secret 是否配对、权限是否齐全、系统时钟与根域名是否正确 |
| 套餐可查但余额失败 | API Key 是否有 `account:read` |
| MySQL 拒绝连接 | 裸机连接地址与权限；Compose 内部为 `mysql:3306`，宿主机映射为 3310 |
| 升级报 ALTER 权限错误 | 给应用库账号补齐结构迁移权限后重启 |
| CDK 一直等待确认 | 使用原 CDK 查询原订单；超时不表示充值失败 |
| 没有浏览器但启动尝试预热 | 数据库保存的浏览器池开关优先，在后台关闭 |
| 修改管理员 `.env` 不生效 | 初始化后管理员信息由数据库管理，在后台修改 |

如通过反向代理对外提供服务，需要转发 WebSocket 的 `Upgrade` / `Connection` 头，避免订单进度推送断开。代理到应用实际端口，并配置 HTTPS。

### 充值审计修复升级

使用 `docker compose up -d --build app` 更新应用（不要删除 MySQL 数据卷）；裸机部署重启 Node 服务。前后端需同时更新并刷新浏览器缓存，任务 WebSocket 订阅现在校验对应 CDK 或管理员登录。

启动会自动增加 `task_logs.local_payment_state`。未启动的本地任务可释放 CDK；已启动但未结算的本地任务会转为待确认并继续占用 CDK。该恢复逻辑按单个应用实例设计，不要让多个应用实例同时管理同一套本地浏览器任务。

默认日志在项目 `data/logs/`；裸机可设置 `TASK_LOG_DIR`，Compose 固定使用 `/app/data/logs` 并通过 `./data:/app/data` 保存到宿主机。部署账号必须能创建和追加日志。把该目录与数据库一起备份并监控剩余空间；按日文件和按任务文件均保留，不自动清理历史。后台“清空显示缓存”不会删除磁盘文件。

升级前已丢失的内存日志无法恢复。账单 `pending`、任务 `manual` 表示需要核对原支付或原订单，不要直接把 CDK 改为未使用后再次充值。详情见 [RECHARGE-AUDIT.md](RECHARGE-AUDIT.md)。
