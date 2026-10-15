# Paseo Notifier 文档

Paseo Notifier 将任务结果发送到指定群组或通知服务，并为临时故障提供有预算的自动恢复。配置入口在「设置 → 插件 → Paseo Notifier → 通知与自动恢复」。

第一次使用，按「安装与更新 → 快速上手 → 选择一个渠道」阅读。已经完成配置，可以直接进入对应功能页。

## 入门与日常操作

| 页面                                              | 解决的问题                                      |
| ------------------------------------------------- | ----------------------------------------------- |
| [安装与更新](Installation-and-updates.md)         | GitHub 安装、网页终端更新、本地源码和安装包更新 |
| [快速上手](Quick-start.md)                        | 注册接收目标、保存凭据、选择默认渠道和测试      |
| [版本与更新检查](Updates-and-releases.md)         | 正式 Release、自动检查和手动安装                |
| [设置与凭据](Settings-and-credentials.md)         | 一键保存、草稿保留、失败重试和并发编辑          |
| [运行状态与排错](Activity-and-troubleshooting.md) | 取消恢复、重投通知、查看日志与常见问题          |

## 功能说明

| 页面                                          | 内容                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| [通知渠道](Channels.md)                       | 九种平台的地址、Token 与接收目标填写方法             |
| [通知事件与内容](Notifications.md)            | 完成、恢复、失败、权限通知，回复摘要与投递重试       |
| [消息模板与 Pattern](Message-templates.md)    | 默认模板、内置占位符、正则提取、示例和预览           |
| [通知去向与继承](Notification-routing.md)     | Host、工作区与会话的入口、多选、继承和关闭通知       |
| [定时任务](Scheduled-tasks.md)                | 给 Schedule 绑定固定渠道，区分 Schedule 与 Heartbeat |
| [自动恢复](Automatic-recovery.md)             | 可重试异常、次数与时间预算、停止条件                 |
| [AI 复核](AI-review.md)                       | 自动恢复的可选步骤：独立 AI 判断是否继续             |
| [跨 Host 导入导出](Configuration-transfer.md) | 复制配置、选择是否迁移凭据、理解合并结果             |

## 通知平台

[通用 Webhook](Channel-Webhook.md) · [飞书 / Lark](Channel-Feishu.md) · [企业微信](Channel-WeCom.md) · [Telegram](Channel-Telegram.md) · [钉钉](Channel-DingTalk.md) · [Bark](Channel-Bark.md) · [ntfy](Channel-ntfy.md) · [Slack](Channel-Slack.md) · [Discord](Channel-Discord.md)

## 技术参考

| 页面                                         | 内容                                          |
| -------------------------------------------- | --------------------------------------------- |
| [架构](Architecture.md)                      | 客户端、宿主回调、路由、恢复与投递的职责      |
| [飞书卡片与后续扩展](Feishu-cards-design.md) | 已实现的内置卡片，以及自定义模板与交互规划    |
| [存储与可靠性](Storage-and-reliability.md)   | 状态文件、预算、去重、重启与不确定回执        |
| [配置参考](Configuration-reference.md)       | 字段、默认值、范围和绑定结构                  |
| [Webhook 协议](Webhook-protocol.md)          | JSON、签名、请求头、回执与幂等处理            |
| [宿主能力与限制](Host-limitations.md)        | 界面扩展、任务列表、事件遗漏与原子操作边界    |
| [开发、CI 与文档维护](Development-and-CI.md) | 检查、构建、打包、GitHub Actions 与 Wiki 发布 |

## 范围

目前只发送通知，不处理 Bot 回复，不注册小米 / 华为推送。任务调度由 Paseo 负责。自动恢复、AI 复核、最终回复摘要和子代理通知默认关闭。
