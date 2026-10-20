# Pay-gpt-Orbit

仅通过 **Orbitcard HMAC V1** 完成 ChatGPT 订阅兑换。提供 CDK 管理、订单追踪、重启恢复、持久化审计、管理员认证及 Telegram 通知。

本地支付、卡池、代理池、账单地址、浏览器自动化、验证码求解、支付链接调试和直接订阅管理均已移除。容器只运行 Node.js；生产依赖为 `axios`、`express`、`mysql2`、`ws`，不安装浏览器、Python 或 AI 模型。

[部署与升级](DEPLOY.md) · [完整链路](RECHARGE-AUDIT.md) · [接口接入](对接api.md) · [Orbitcard 原始协议](orbitcard-subscription-api-v1.md)

## 快速开始

需要 Node.js 24+ 和 MySQL 8；或 Docker Engine 与 Compose V2。

```bash
cp .env.example .env
# 填写数据库密码、管理员密码、随机签名密钥、Orbitcard HMAC Secret
docker compose up -d --build
docker compose logs -f app
```

默认用户入口 `http://localhost:3000/`，管理员入口 `http://localhost:3000/admin-login`。首次创建管理员需要至少 8 位的登录密码、二级密码；`ADMIN_TOKEN_SECRET` 每次启动都必须为至少 32 字节的随机值。

后台配置配对的 Orbitcard API Key、HTTPS 根域名和平台卡 ID，测试连接后开放接单。关闭开关会拒绝新兑换，已有订单继续查询。不会切换到其他充值流程。

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
3. 在一个事务中锁定 CDK、创建任务、保存本次唯一 `client_order_no` 并占用 CDK。
4. 查询当前套餐和支付地区，按同一订单身份提交一次 `createSubscription`。
5. 查询原订单；需要人机验证时，用户通过有时效的上游链接完成验证。
6. 上游明确订阅成功则核销 CDK；明确失败或拒绝提交则释放；未知结果继续占用。
7. 重启后自动恢复原单查询，用户也可用原 CDK 手动查询。不会自动再次创建订阅。

自动前台跟踪最多 15 分钟，后台继续有间隔地恢复未确认订单。平台服务费和订阅状态分别记录；`charge_pending` / `charge_failed` 不会把订阅成功改成失败。

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

测试包括 HMAC 签名、CDK 事务与竞争、暂停接单、配置缺失、原单恢复、服务费独立状态、日志脱敏与重载，以及 HTTP 路由移除。使用模拟数据库和上游接口，不会发起真实充值。

容器体积需在实际构建后测量；不再下载安装 Chromium、PyTorch 等组件。更换轻量镜像不会自动删除服务器上的旧镜像或构建缓存。

本项目基于 KC（TG：KcCatk）的 [KC-CatK/KC-PAY-GPT](https://github.com/KC-CatK/KC-PAY-GPT) 定制，保留 [MIT License](LICENSE) 及原始版权。
