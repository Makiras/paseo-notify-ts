# paseo-notify-ts

Paseo 原生通知与自动恢复插件。任务结束、失败或等待权限时发送通知；遇到网络或服务临时故障时，可按预算继续原会话，并在重试前交给独立 AI 复核。

[Wiki](https://github.com/Makiras/paseo-notify-ts/wiki) · [文档目录](docs/wiki/Home.md) · [Releases](https://github.com/Makiras/paseo-notify-ts/releases) · [CI](https://github.com/Makiras/paseo-notify-ts/actions/workflows/ci.yml) · [MIT License](LICENSE)

## 功能

- **九种通知渠道**：通用 Webhook、飞书 / Lark、企业微信、Telegram、钉钉、Bark、ntfy、Slack、Discord；飞书支持文本与内置卡片。
- **消息模板与 Pattern**：自定义标题、正文，使用内置占位符和正则提取补全信息；页面内提供示例和实时预览。
- **分层选择接收目标**：Host、工作区、会话可以分别选择渠道，也可跟随上级或关闭通知。
- **定时任务绑定**：给 Paseo Schedule 固定接收渠道，跨次运行有效。
- **自动恢复与可选 AI 复核**：Host → 工作区 → 会话继承与单独配置，控制重试预算及复核；输入框提供独立「自动继续」入口。
- **原生配置界面**：桌面、网页与移动端共用；渠道和凭据一键保存，会话内可进入工作区设置。
- **会话清理**：会话内删除与归档列表选择删除，展示清单并二次确认。
- **正式版本更新**：打开设置时检查 Release，手动通过 Host 终端安装；CI 验证、打包与发布。
- **跨 Host 配置迁移**：通过剪贴板导入导出，可显式选择是否包含凭据。

当前支持发送通知，不包含 Bot 回复和小米 / 华为推送注册。

## 文档导航

| 阅读目的           | 页面                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开始使用或更新插件 | [安装与更新](docs/wiki/Installation-and-updates.md) · [快速上手](docs/wiki/Quick-start.md) · [版本与更新检查](docs/wiki/Updates-and-releases.md)          |
| 连接通知平台       | [渠道配置目录](docs/wiki/Channels.md) · [通知事件与内容](docs/wiki/Notifications.md)                                                                      |
| 自定义消息内容     | [消息模板与 Pattern](docs/wiki/Message-templates.md)                                                                                                      |
| 设置群组与继承     | [通知去向与继承](docs/wiki/Notification-routing.md) · [定时任务](docs/wiki/Scheduled-tasks.md)                                                            |
| 保存与同步配置     | [设置与凭据](docs/wiki/Settings-and-credentials.md) · [跨 Host 导入导出](docs/wiki/Configuration-transfer.md)                                             |
| 自动继续任务       | [自动恢复](docs/wiki/Automatic-recovery.md) · [AI 复核](docs/wiki/AI-review.md)                                                                           |
| 清理归档会话       | [会话清理与删除](docs/wiki/Session-cleanup.md)                                                                                                            |
| 查询状态或排错     | [运行状态与排错](docs/wiki/Activity-and-troubleshooting.md)                                                                                               |
| 了解技术原理       | [架构](docs/wiki/Architecture.md) · [存储与可靠性](docs/wiki/Storage-and-reliability.md) · [宿主能力与限制](docs/wiki/Host-limitations.md)                |
| 开发与集成         | [开发、CI 与文档维护](docs/wiki/Development-and-CI.md) · [配置参考](docs/wiki/Configuration-reference.md) · [Webhook 协议](docs/wiki/Webhook-protocol.md) |

Wiki 页面源文件保存在 `docs/wiki/`，可随代码审阅和离线阅读。使用教程、功能说明与实现原理分别维护。

Copyright (c) 2026 Makiras · [MIT](LICENSE)
