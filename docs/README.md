# 文档索引

所有命令从仓库根目录运行。项目入口见[README](../README.md)。

| 任务 | 文档 |
| --- | --- |
| 首次安装、服务器更新、重启及迁移 | [部署与升级](operations/DEPLOY.md) |
| 用户兑换、后台管理、CDK 导出与人工核销 | [使用与后台管理](operations/USER-GUIDE.md) |
| 所有订单的人工备注、暂停、结案及资金保护 | [订单人工处理](operations/ORDER-MANUAL-CONTROL.md) |
| 选卡、渠道/BIN 多选、停用恢复、错误码措施 | [卡池与故障处置](operations/ORBITCARD-CARDS.md) |
| 接口查询、支付预检、并发模拟及日志 | [调试与日志](operations/DIAGNOSTICS.md) |
| 请求上限、连接、缓存和日志保留 | [运行与资源](operations/RUNTIME.md) |
| 管理员余额预警、充值结果邮件与 SMTP 配置 | [管理员邮件通知](operations/EMAIL-NOTIFICATIONS.md) |
| dujiao-next 商城核销回调配置与对账 | [商城核销通知](integrations/CDK-REDEMPTION.md) |
| 模块职责、代码阅读顺序及修改约定 | [架构总览](architecture/OVERVIEW.md) |
| 支付状态、事务、资金安全与重启恢复 | [充值链路与审计](architecture/RECHARGE-AUDIT.md) |
| 回归测试与平台只读检查 | [开发验证](development/TESTING.md) |

[历史版本复核](history/2026-10-22-REVIEW.md)单独归档，避免与当前规则混用。

## API 资料

以下为原有接口资料，目录整理保留其内容；本项目只接入实际使用的操作，不能由文档中列有某接口推断程序已经实现该能力。

- [Orbitcard Open API V1](api/Orbitcard-Open-API-V1.md)：平台 HMAC、卡片、资金与通用错误协议。
- [订阅 API V1](api/orbitcard-subscription-api-v1.md)：订阅、订单结果与上游错误协议。
- [原接入说明](api/对接api.md)：保留的接口接入资料。

业务运行规则以当前代码和专题文档为准。接口原文中的示例不是生产凭据；环境变量参考仓库根目录的 [.env.example](../.env.example)。历史版本复核记录只描述当时验证结果，不作为当前功能说明。
