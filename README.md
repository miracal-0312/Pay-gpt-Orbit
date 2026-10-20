# Pay-gpt-Orbit

CDK 订阅兑换与管理平台。用户提交 CDK 和完整 Session JSON 后，系统通过 **Orbitcard HMAC V1** 创建订阅、追踪原订单并更新 CDK 状态。后台提供套餐、余额、服务费和订单查询，以及卡池、账单、任务和安全设置。

本项目基于 [KC-CatK/KC-PAY-GPT](https://github.com/KC-CatK/KC-PAY-GPT) 定制，保留本地 Stripe / Playwright 自动化能力。第三方代充已统一为 Orbitcard，不再提供旧 Bearer 代充协议选项。

[项目仓库](https://github.com/miracal-0312/Pay-gpt-Orbit) · [部署指南](DEPLOY.md) · [接入说明](对接api.md) · [Orbitcard 协议](orbitcard-subscription-api-v1.md) · [MIT License](LICENSE)

## 运行环境

| 组件 | 要求 |
|------|------|
| Node.js | >= 24；部署推荐 24 LTS，`.nvmrc` 和 Docker 镜像均使用 24 |
| MySQL | 8.0；应用数据库账号需要建表、ALTER 和读写权限 |
| Docker | 使用 Docker 部署时需要 Docker Engine / Desktop 和 Compose V2 |
| 网络 | 服务端可以通过 HTTPS 访问配置的 Orbitcard 根域名，系统时间准确 |
| 本地自动化 | 使用本地 Stripe 流程时另外安装 Chromium；Python 验证码组件按需安装 |

Orbitcard 代充不依赖本地卡池、代理、Chromium 或 Python。新环境模板默认 `BROWSER_POOL=0`；已在数据库中保存的浏览器池开关优先，请在后台同步关闭。Docker 镜像仍包含完整浏览器和 Python 组件，供本地流程使用。

Node.js 版本选择依据：[官方发布与支持周期](https://nodejs.org/en/about/previous-releases)。

## 快速部署

### Docker

先通过有权访问该私有仓库的 GitHub 账号获取代码：

```bash
git clone https://github.com/miracal-0312/Pay-gpt-Orbit.git
cd Pay-gpt-Orbit
cp .env.example .env
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。已有部署请合并环境配置，不要覆盖原 `.env`。

编辑 `.env`，填写数据库密码、管理员登录密码、二级密码、随机管理员签名密钥，以及配对的 `ORBITCARD_API_SECRET`。配置项说明见下表，然后启动：

```bash
docker compose up -d --build
docker compose logs -f app
```

默认用户入口为 `http://localhost:3000/`，后台登录为 `http://localhost:3000/admin-login`。端口取 `.env` 中的 `PORT`，已有后台自定义路径以数据库保存值为准。

Compose 项目名和数据卷命名保持原来的 `kc-gpt-pay2`，便于已有部署继续使用原数据库。升级时保持原 Compose 项目名与 `DB_NAME`。不要用 `docker compose down -v` 更新服务，它会删除数据库卷。

### 裸机

安装 Node.js 24 LTS 和 MySQL 8 后，在项目目录执行：

```bash
npm ci --omit=dev --ignore-scripts
cp .env.example .env
# 编辑 .env，填写连接信息、管理员信息和 Orbitcard Secret
npm start
```

PowerShell 对应使用 `npm.cmd` 和 `Copy-Item`。`npm start`、`node server.js` 和 PM2 启动都会先读取项目根目录 `.env`，再初始化数据库及应用模块；已存在的进程环境变量优先。

也可使用 `bash scripts/install.sh` 或 `powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1`。安装脚本默认只安装 Node 依赖，不安装浏览器。使用本地自动化时分别加 `--with-browser` / `-WithBrowser`。完整步骤见 [DEPLOY.md](DEPLOY.md)。

## 环境变量与后台配置

| 配置 | 设置位置 | 用途 |
|------|----------|------|
| `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME` | `.env` | 裸机数据库连接；Compose 内部固定连接 `mysql:3306`，用户为 `root` |
| `ADMIN_EMAIL`、`ADMIN_PASSWORD`、`ADMIN_SECONDARY_PASSWORD` | `.env` | 仅初始化新数据库的管理员；已有账号在后台修改 |
| `ADMIN_TOKEN_SECRET` | `.env` | 管理员令牌签名密钥，生产部署填写随机值 |
| `ORBITCARD_API_SECRET` | 服务端 `.env` / 进程环境 | Orbitcard HMAC Secret，与后台 API Key 配对 |
| API 根域名、API Key、平台卡 ID | 后台「系统配置 → 第三方代充 API」 | 根域名默认 `https://orbitcard.cc`，卡 ID 是平台正整数 ID |
| 支付地区、最高服务费 | 同上 | 可选；地区根据当前套餐实时验证，服务费单位 USDT |
| 第三方代充开关 | 同上 | 控制新 CDK 兑换是否使用 Orbitcard |
| `BROWSER_POOL` | `.env` / 后台「浏览器池」 | 仅 Orbitcard 代充时关闭；后台保存值优先 |

API Key、平台卡 ID 和开关不从 `.env` 导入。Secret 不进入后台表单或数据库，也不会由管理接口返回。不要混用卡片供应商的 `CARD_SUPPLIER_WEBHOOK_SECRET`。

修改 `.env` 后，裸机重启进程；Docker 执行 `docker compose up -d --force-recreate app`。`docker compose restart app` 不会重新注入修改后的环境变量。

## 启用 Orbitcard

1. 在服务端设置 `ORBITCARD_API_SECRET`，重启或重建应用。
2. 后台填写 HTTPS 根域名、配对 API Key 和本人平台卡 ID。根域名不包含 `/api/open/v1` 子路径。
3. Key 需要 `subscriptions:read` 和 `subscriptions:create`；余额查询另需 `account:read`。如通过平台 `getCardList` 查卡 ID，还需要 `cards:read`。
4. 设置可选地区与服务费上限，测试连接，保存并开启第三方代充。
5. 创建对应套餐的自助 CDK，用户提交该 CDK 和完整 Session JSON 后才会创建订阅。

“测试连接”只查询套餐和余额；打开代充开关本身不会充值。订阅订单由 CDK 兑换触发，会产生真实业务请求。

| CDK 套餐 | Orbitcard 套餐 |
|----------|---------------|
| Plus (`plus`) | `gpt-plus` |
| Pro 100 (`pro100`，兼容 `pro_5x`) | `gpt-pro-5x` |
| Pro 200 (`pro200`，兼容 `pro_20x`) | `gpt-pro-20x` |
| Pro 500 (`pro500`) | `gpt-pro-25x` |

是否开放套餐、可用地区及默认地区由 Orbitcard 实时返回。上游支持的其他套餐不会自动成为本项目的 CDK 类型。

## CDK 与订单状态

CDK 占用和订单关联在同一数据库事务中创建。每次兑换尝试使用固定客户订单号和幂等键，提交前保存关联信息。

| 订单结果 | CDK 行为 |
|----------|----------|
| 处理中、需要人机验证 | 保持占用，查询原订单 |
| 上游确认订阅成功 | 核销 CDK，成功状态不会被后续查询降级 |
| 明确拒绝提交或上游确认失败 | 释放 CDK；修正资料后再次兑换会创建新的尝试 |
| 超时、断网、结果未知 | 保留 CDK，不自动换订单重下 |

刷新或服务重启后，验证同一 CDK 可以恢复订单。前台「查询代充结果」只查询原订单；自动追踪最多 15 分钟，之后可继续手动查询。关闭第三方代充接单后，已有订单仍可查询，但需要保留原域名及有效凭据。

出现人机验证时打开上游 HTTPS 链接，完成后继续查询。验证链接只在当前响应和内存中使用；Orbitcard 提交/返回的 Session 不保存到代充任务日志。服务费 `charge_failed` 独立于订阅结果，不会将已成功订阅改成失败。

关闭第三方代充后，新兑换会进入项目原有本地流程。仅部署 API 环境时，请配置完成并启用 Orbitcard 后再接收用户兑换。

## 升级

- 合并 `.env.example` 中新增配置，保留已有数据库连接、管理员信息和业务凭据。
- 更新到 Node.js 24；Docker 使用 `docker compose up -d --build app` 更新镜像和环境。
- 启动自动补齐 Orbitcard 订单关联字段并迁移协议配置，数据库账号需要 `ALTER TABLE` 权限。
- 已有 Orbitcard 配置保留；尚未迁移的旧代充配置会停用、清空旧 Key、恢复 Orbitcard 默认地址。重新填写参数后再启用。
- 历史任务和卡池数据保留；原供应商未完成订单需在原供应商侧核实，不会由 Orbitcard 代为查询。

## 开发与验证

```bash
# 无第三方依赖、无真实网络请求：环境加载、协议迁移、CDK 事务与查询回归
npm run test:orbitcard

# 安装开发依赖后运行完整 Vitest 测试
npm ci --ignore-scripts
npm test
```

本地测试使用模拟接口和事务存储，不会创建付费订阅，也不能替代实际部署后的数据库及连接检查。

| 文件 | 职责 |
|------|------|
| `server.js` / `load-env.js` | HTTP、WebSocket、任务调度及启动环境加载 |
| `orbitcard-client.js` / `orbitcard-config.js` | HMAC 请求、响应摘要、配置校验与迁移 |
| `orbitcard-worker.js` / `orbitcard-query.js` | 下单及轮询、重启后的原单查询 |
| `orbitcard-cdk.js` / `orbitcard-cdk-store.js` | 订单身份、CDK 事务占用与结算 |
| `mysql-store.js` / `mysql-schema.sql` | 数据库操作与结构 |
| `public/index.html` / `public/admin.html` | 用户兑换与管理界面 |
| `index.js` / `stripe-payment.js` / `browser-pool.js` | 原有本地自动化流程 |
| `.env.example` / `docker-compose.yml` / `scripts/` | 环境模板、容器部署和安装脚本 |

`gpt-api-client.js` 仅保留为 Orbitcard 客户端的兼容导出；第三方代充不再调用旧 `/pay`、`/pay/inspect` 或 `/tasks` 接口。管理后台自身的 Bearer 登录令牌与此供应商协议无关。

## 原有功能与来源

保留本地支付成功后尝试取消自动续费、单卡订阅额度、明确拒付报废与换卡、供应商开卡 Webhook 入池、管理员二级验证、动态后台路径，以及 Docker noVNC 调试。

原始开发者：KC（TG：KcCatk）。定制基线来自上游提交 `fb4da763f5cdcd6995b5b8ad3b7f758ae0684963`。代码按 [MIT License](LICENSE) 提供，保留原始版权及许可。
