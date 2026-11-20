# Pay-gpt-Orbit

通过 Orbitcard HMAC V1 完成 ChatGPT 订阅兑换的 Node.js 应用，提供自助 CDK 兑换、管理员测试与人工交付、卡池管理、套餐整额补款、原订单恢复、订单人工处理、日志审计、管理员邮件提醒和商城核销通知。支持 Plus、Pro 100、Pro 200、Pro 500。

## 快速启动

需要 Node.js 24+、MySQL 8，或 Docker Engine 与 Compose V2。以下命令在仓库根目录执行：

```bash
cp .env.example .env
# 填写数据库密码、管理员两级密码、随机 ADMIN_TOKEN_SECRET，以及配对的卡台 Key / Secret
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

默认用户入口为 `http://localhost:3000/`，管理员入口为 `http://localhost:3000/admin-login`。首次初始化的管理员登录密码和二级密码至少 8 位，`ADMIN_TOKEN_SECRET` 至少 32 字节。已有账号密码由数据库管理。首次接入还需在后台配置平台根域名、套餐 USD 金额和地区，按需设置开卡渠道/BIN，并完成只读检查后开放接单。

裸机可执行 `npm ci --omit=dev --ignore-scripts` 后运行 `npm start`；`node server.js` 启动入口保留。安装脚本只安装 Node 生产依赖并在缺少 `.env` 时复制模板。详细环境、权限和更新步骤见[部署与升级](docs/operations/DEPLOY.md)。

## 项目结构

```text
server.js       兼容启动入口
src/            按职责分组的服务端代码
public/         用户页与管理后台静态资源
database/       MySQL 初始结构
scripts/        安装与只读检查工具
test/           回归测试及模拟数据库
docs/           使用、部署、架构及 API 文档
data/           本地运行数据挂载目录
```

代码职责和阅读顺序见[架构总览](docs/architecture/OVERVIEW.md)。`.env`、运行数据、日志及 `scratch/` 不提交到仓库。

## 支付与卡片规则

- 卡片可用性由实时平台状态、币种与余额、本地停用标记、订单占用和未决资金决定；每张卡最多成功支付 3 次，满额后停止分配，释放占用并确认删卡后自动补开一张。
- 已验证的卡片相关失败会持久化停用原卡并登记唯一补开。开卡渠道采用 `product_code`，渠道与 BIN 支持多选，首充固定 20 USD；这些偏好和开卡产品规则仅用于开卡，不筛选现有支付卡。管理员可填写原因后停用或恢复卡片。
- 每条支付链最多 3 次尝试。Session、账号、配置或未知原因的已确认失败停止自动支付；受理未知只核对原订阅，未决补款只核对原资金，不另建付款。
- 自助兑换与管理员操作共用 1 个等待位，最长 30 分钟。生产环境对同一套任务运行一个应用实例。
- 所有订单保留人工处理入口，可追加备注、暂停或登记人工结果；人工成功／失败立即关闭业务订单并从待处理统计排除，未决资金也可记录人工结果，并由管理员明确选择解除本单本地占用。原资金继续核对，本地释放不代表退款；执行锁和归属校验继续生效。详见[订单人工处理](docs/operations/ORDER-MANUAL-CONTROL.md)。
- 完整 Session、签名、完整卡号及 CVV 不进入普通日志；审计日志按北京时间保留 15 个自然日。

完整状态与资金保护见[充值链路](docs/architecture/RECHARGE-AUDIT.md)，全部已公开错误代码及对应措施见[卡池与故障处置](docs/operations/ORBITCARD-CARDS.md)。

## 文档与验证

[全部文档](docs/README.md) · [后台使用](docs/operations/USER-GUIDE.md) · [部署更新](docs/operations/DEPLOY.md) · [调试与日志](docs/operations/DIAGNOSTICS.md) · [商城核销通知](docs/integrations/CDK-REDEMPTION.md) · [API 原文](docs/api/Orbitcard-Open-API-V1.md)

管理员邮件支持账户低余额预警和订阅充值成功/失败通知，在后台配置 SMTP 与收件邮箱后启用；设置、去重及发送记录见[邮件通知](docs/operations/EMAIL-NOTIFICATIONS.md)。

```bash
npm run check
npm test
```

测试使用模拟卡台及数据库，不发起真实开卡或充值；真实 MySQL 迁移、锁竞争与平台联调需在部署环境验证。测试范围及只读检查命令见[开发验证](docs/development/TESTING.md)。

本项目基于 KC（TG：KcCatk）的 [KC-CatK/KC-PAY-GPT](https://github.com/KC-CatK/KC-PAY-GPT) 定制，保留 [MIT License](LICENSE) 及原始版权。
