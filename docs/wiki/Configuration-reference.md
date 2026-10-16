# 配置参考

普通配置使用 Paseo Host 范围的 `notifier` 设置，当前设置格式版本为 7。源码定义在 [`shared/config.ts`](https://github.com/Makiras/paseo-notify-ts/blob/main/shared/config.ts)。推荐通过界面修改，避免绕过并发版本校验。

## 全局与通知

| 字段                              | 默认值              | 约束 / 含义                                                                      |
| --------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `enabled`                         | `true`              | 通知与恢复总开关；测试发送独立                                                   |
| `includeSubagents`                | `false`             | 是否包含普通子代理；插件自己的复核代理始终排除                                   |
| `updates.checkAutomatically`      | `true`              | 打开设置页时检查正式 Release；不自动安装                                         |
| `notifications.includePreview`    | `false`             | 是否携带最终回复截取内容                                                         |
| `notifications.previewCharacters` | `600`               | 80–2000 字符                                                                     |
| `notifications.maxAttempts`       | `5`                 | 单条投递 1–12 次                                                                 |
| `notifications.retentionDays`     | `7`                 | 已结束运行记录保留 1–30 天                                                       |
| `notifications.template.title`    | `Paseo · {{event}}` | 标题模板，1–300 字符                                                             |
| `notifications.template.body`     | 内置正文            | 正文模板，1–6000 字符；见[消息模板](Message-templates.md)                        |
| `notifications.template.rules`    | `[]`                | 最多 12 条规则，字段为 `name`、`source`、`pattern`、`flags`、`group`、`fallback` |

## 自动恢复与复核

以下字段以 `recovery.` 为前缀，表示 Host 默认值。

| 字段                                     | 默认值                                 | 范围 / 含义                                                  |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `enabled`                                | `false`                                | 自动继续开关                                                 |
| `network` / `overloaded` / `rateLimited` | 均为 `true`                            | 临时故障类别，仅在恢复开启后生效                             |
| `maxAttempts`                            | `5`                                    | 1–20 次                                                      |
| `maxElapsedMinutes`                      | `30`                                   | 1–240 分钟                                                   |
| `baseDelaySeconds`                       | `10`                                   | 1–600 秒                                                     |
| `maxDelaySeconds`                        | `300`                                  | 1–3600 秒，不能小于初始等待                                  |
| `prompt`                                 | 提醒检查进度、继续原任务并避免重复操作 | 1–2000 字符                                                  |
| `review.enabled`                         | `false`                                | 每次重试前使用独立 AI 复核                                   |
| `review.provider`                        | 空字符串                               | 沿用原会话，或 `codex` / `claude` / `opencode`，可带 `/模型` |
| `review.timeoutSeconds`                  | `90`                                   | 10–600 秒                                                    |
| `review.maxReviews`                      | `5`                                    | 每个恢复任务 1–20 次                                         |
| `review.contextCharacters`               | `8000`                                 | 1000–24000 字符                                              |

## 恢复的范围覆盖

`recoveryOverrides.workspaces` 和 `recoveryOverrides.sessions` 分别保存工作区、会话的完整恢复配置，与 `recovery` 使用相同字段和校验。缺少键表示继承，存在键表示使用这份完整配置；其中 `enabled: false` 表示明确关闭。优先级为 Session → Workspace → Host。插件总开关 `enabled` 仍控制所有范围。

默认两个映射均为空。工作区最多 1000 项，会话最多 5000 项，键使用对应的 Paseo ID。这些本地覆盖不随剪贴板导出；导入保留目标 Host 原有覆盖。

## 渠道

`channels` 最多 20 项。每项有唯一 `id`、显示 `name`、`kind`、`enabled`、`events`、`providers` 和 `workspaceIds`。`originId` 是导入冲突时用于复用的内部来源标识。

- `id`：小写字母开头，仅小写字母、数字、连字符，最多 48 字符。
- `name`：非空，最多 80 字符。
- `kind`：`webhook`、`feishu`、`wecom`、`telegram`、`dingtalk`、`bark`、`ntfy`、`slack`、`discord`。
- `feishu.messageType`：飞书渠道专用，`text` 或 `card`，缺省按 `text`；决定文本或内置卡片显示，不改变凭据。
- 默认事件：`completed`、`recovered`、`failed`、`blocked`、`permission`。
- `providers`：最多 32 项；`workspaceIds`：最多 100 项；空数组表示不限制。

凭据不在普通配置中。凭据接口字段为 `url`、`signingSecret`、`bearerToken`、`headers`、可选的 `target` 和 `threadId`；各平台使用不同子集，见[渠道目录](Channels.md)。

## 路由示例

以下为路由片段，假设已注册 `team` 和 `phone` 两个渠道：

```json
{
  "routing": {
    "host": ["team"],
    "schedules": { "daily-check": ["phone"] },
    "workspaces": { "quiet-project": [] },
    "sessions": { "important-session": ["team", "phone"] }
  }
}
```

缺少某个 scope 的键表示继承；显式 `[]` 表示静音。任务 / 工作区各最多 1000 个绑定，会话最多 5000 个；绑定必须引用已注册渠道，不能重复。

## 格式迁移

从格式版本 1 迁移时，原有广播行为转换为全部已有渠道的 Host 默认选择；版本 2 → 3 增加任务绑定并保留原默认；版本 3 → 4 增加更新偏好，默认开启检查；版本 4 → 5 补充默认消息模板和空提取规则；版本 5 → 6 支持飞书消息类型，已有渠道继续使用文本；版本 6 → 7 增加工作区和会话恢复覆盖，已有会话继续跟随 Host。迁移不触发通知测试，也不会启用原本关闭的恢复、复核或回复摘要。

剪贴板文件使用独立的 `paseo-notify-ts/config`、版本 1 / 2 包装（含飞书卡片渠道时导出版本 2，避免旧插件忽略卡片设置），省略本地绑定及工作区过滤，见[导入导出](Configuration-transfer.md)。配置版本和插件发布版本是不同概念。
