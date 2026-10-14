# paseo-notify-ts

[MIT License](LICENSE) · Copyright (c) 2026 Makiras

纯 TypeScript 的 Paseo 原生插件：事件回调驱动的自动恢复（可选 AI 复核）、任务通知、桌面与移动端共用的配置页。支持通用 Webhook、飞书 / Lark、企业微信、Telegram、钉钉、Bark、ntfy、Slack 和 Discord。通过宿主 SDK 接入，没有 MCP 客户端、会话轮询、独立 Web 服务或会话数据库。

## 使用

从 GitHub 安装：

```sh
paseo plugin install git:Makiras/paseo-notify-ts
```

从本地源码开发和安装：

```sh
git clone https://github.com/Makiras/paseo-notify-ts.git
cd paseo-notify-ts
npm ci --ignore-scripts
npm run check
paseo plugin install "$PWD"
```

宿主需要启用插件。打开 **设置 → 插件 → Paseo Notifier → 通知与自动恢复**，或在命令中心搜索 `Notifier`。

1. 添加渠道，选择通知事件和可选的提供方 / 工作区过滤，点击「保存设置」。
2. 按渠道填写地址、Token、目标等信息，点击「保存凭据」。
3. 点击「发送测试」，确认渠道收到消息。
4. 按需开启自动继续并设置预算；需要时启用其子选项「重试前由 AI 复核」。自动继续、复核、最终回复摘要默认关闭，默认只处理主会话。

运行需要 Node.js 22+，生产环境没有额外依赖。修改源码后运行检查，再执行 `paseo plugin reload paseo-notifier`。本项目不会修改宿主的全局插件开关。

## 恢复与通知

| 中断                               | 行为                             |
| ---------------------------------- | -------------------------------- |
| 网络错误、连接断开                 | 指数退避加抖动后继续             |
| 服务繁忙、容量不足、临时服务端错误 | 按预算重试                       |
| 请求限流                           | 退避，遵守明确的等待提示         |
| 额度耗尽、上下文已满               | 通知人工处理                     |
| 安全策略 / cyber 拦截              | 识别并通知，不自动绕过或反复提交 |
| 用户取消、归档、权限等待           | 取消后续恢复                     |
| 未识别错误                         | 通知，避免盲目循环               |

优先使用结构化错误码，再识别失败事件的错误文本。成功结果仅对明确的最终拒绝回复作保守识别，不扫描历史关键词。提供方未暴露的中断可能被归为未知错误。

每个会话串行处理，同一次故障的预算跨自动轮次和重启保留。发送前核对用户消息、历史摘要指纹、会话状态和权限。发送意图先落盘；回执不明时暂停。之后若收到对应轮次的明确终止事件，可沿原预算处理。自动恢复期间合并失败通知，最终恢复成功或预算用尽才通知。取消不会停止已执行的任务。

通知渠道各自串行、控制发送间隔、独立重试。HTTP 408 / 429 / 5xx、网络故障和已识别的平台临时错误可重试；同时检查各平台的业务状态。Telegram 和 Discord 的 JSON `retry_after` 也会被遵守。永久错误停止重试，可在配置页手动再次投递。

### 可选：重试前 AI 复核

在「自动恢复」中开启自动继续，再按需打开子选项「重试前由 AI 复核」，展开模型、超时等详细设置。配置存放在 `recovery.review`；关闭自动恢复后复核不执行，已有复核设置保留。每次符合恢复规则的重试，在退避到期后按以下顺序执行：

1. 核对原会话仍空闲、用户消息和历史未变。
2. 通过 Paseo SDK，在同一工作区创建独立的审查子会话。把任务名、故障类别、已尝试次数、拟发送的继续指令、有限消息摘录与工具名称/状态交给审查员。
3. 严格解析 `continue` / `stop` / `needs_user` 和理由。不会执行模型返回的命令，也不会让模型生成继续指令。
4. 归档审查会话，再次核对原会话和配置。只有有效的 `continue` 能触发原会话的继续指令。

可以指定 `codex`、`claude`、`opencode` 或 `提供方/模型`，留空沿用原会话的提供方和模型。使用 Paseo 已配置的账户；每次复核是一次额外模型调用，会将摘录交给所选提供方。默认单次 90 秒、每个恢复计划最多 5 次、消息摘录最多 8000 字符，全局最多 2 个审查员同时运行。复核时间也计入原恢复计划的总时间上限。

Codex 使用公开的 `auto` 模式配合只读 sandbox、禁用网页搜索及多代理选项；Claude 使用 plan 模式及工具拒绝规则；OpenCode 使用 deny 权限。插件不会批准权限请求。提供方配置不是宿主级沙箱，实际限制由相应提供方执行；不支持受限配置的提供方会暂停复核。审查只使用传入摘录，不能证明工具调用完全没有副作用；存在歧义时要求人工处理。

拒绝、超时、调用失败、无效 JSON、清理未确认都会暂停并通知，审查员本身不再自动重试。安全拦截、额度、上下文耗尽与权限等待仍按固定规则处理，AI 无权解除这些限制。用户接手、取消或修改恢复配置会使旧结论作废。审查会话不会触发新的通知或恢复链，即使开启子会话通知也一样。

恢复卡片和运行状态展示审查次数与理由。理由只保存在插件运行记录及 Paseo 中，不直接附在外部通知里。插件不保存完整审查输入；Paseo 自己仍会保存已归档审查会话的历史。重启时中断的审查暂停，首次取得 SDK 后只清理已记录的审查员，不自动重跑 AI。创建请求迟到时也会尝试归档；连接中断导致无法确认归档时，会保留清理标记，重新加载后再处理。

## 通知渠道配置

| 渠道         | 需要填写                                                  | 说明                                                  |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| 通用 Webhook | 接收地址；可选签名、Bearer Token、请求头                  | JSON 事件，可继续对接其他服务                         |
| 飞书 / Lark  | 自定义群机器人 Webhook；可选签名密钥                      | 文本通知                                              |
| 企业微信     | 含 `key` 的群机器人 Webhook                               | 按 UTF-8 字节限制截断                                 |
| Telegram     | API 根地址、Bot Token、Chat ID；可选话题 ID               | 默认官方 API，支持自建 Bot API；私聊先向 Bot 发起会话 |
| 钉钉         | 含 `access_token` 的机器人 Webhook；可选签名密钥          | 支持加签；使用关键词校验时可配置关键词 `Paseo`        |
| Bark         | 含设备 Key 的推送地址，例如 `https://api.day.app/设备Key` | 支持自建 Bark 服务；按消息大小截断                    |
| ntfy         | 服务根地址、Topic；可选 Bearer Token                      | 支持自建服务；私密内容应使用有访问控制的 Topic        |
| Slack        | Incoming Webhook 地址                                     | 同时支持 GovSlack，关闭自动提及和链接预览             |
| Discord      | Webhook 地址；论坛可在 URL 保留 `thread_id`               | 禁止消息内容自动提及，等待平台确认保存                |

以上均只发送通知，不接收 Bot 回复，不注册小米 / 华为推送。公共 ntfy 服务的公开 Topic 可被其他人订阅。凭据始终由宿主发送，客户端查询只显示是否已配置。

## Webhook 协议

通用 Webhook 使用 JSON POST，字段为 `schema: "paseo-notifier/v1"`、`id`、`kind`、`agentId`、`workspaceId`、`provider`、`title`、`summary`、可选的 `preview`、`attempts`、`createdAt` 和 `text`。时间为 Unix 毫秒。事件种类为 `completed`、`recovered`、`failed`、`blocked`、`permission`、`test`。

- `Idempotency-Key`、`X-Paseo-Event-Id`：稳定事件 ID，用于接收方去重。
- `X-Paseo-Timestamp`：请求时间，Unix 秒。
- 可选 `X-Paseo-Signature`：`sha256=` 加上 `HMAC-SHA256(secret, timestamp + "." + 原始请求体)` 的十六进制结果。
- 支持可选 Bearer Token 和字符串自定义请求头。接收方应校验签名、时间窗口及事件 ID。

飞书以 `timestamp + "\n" + secret` 为 HMAC key，对空字符串签名并 Base64 编码。企业微信按 UTF-8 字节数截断文本。摘要只在显式开启后发送，可能包含工作内容。

## 存储

普通配置由 Paseo settings API 保存，写入带 revision，避免客户端互相覆盖。凭据通过单独 RPC 写入，查询不返回地址、密钥或 Token。

目录依次取 `PASEO_NOTIFIER_STATE_DIR`、`$PASEO_HOME/notifier`、`~/.paseo/notifier`。自定义 daemon home 和多个实例应分别指定独立目录。Unix 目录权限为 `0700`，文件为 `0600`。

| 文件               | 内容                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `operations.json`  | 预算、计划、消息 ID / 指纹、审查员 ID / 结论 / 清理标记、通知队列 |
| `credentials.json` | 渠道地址、签名密钥、Token、目标 / 话题、自定义请求头              |
| `owner.lock`       | 进程占用，防止重复实例写入                                        |

使用串行事务、临时文件、fsync 和原子替换。文件损坏时保留原文件并停止自动操作，不重置预算。凭据由文件权限保护，并非加密保险库。可选摘要随通知队列落盘，完整会话不落盘。

记录在启动、配置变更、事件和投递时清理。活动计划和待投递通知保留；最多 1000 个活动计划、2000 条通知记录、5000 条去重记录。容量不足时报告并暂停，不丢弃活动预算。卸载清理计时器和 HTTP 请求，重新加载读取待处理操作。Paseo 删除插件不会删除此数据目录；如需彻底清理，先停用插件，再删除目录。

## 宿主接口限制

1. 初始化上下文不提供 `PaseoApi`。通知队列可以独立恢复；会话恢复要等首次生命周期回调或配置页 RPC 取得 SDK 后核对。正常事件处理不要求客户端在线。
2. `send()` 没有原子的 `ifIdle` / `expectedRevision`。插件重复核对并使用 `activeTurnBehavior: "steer"` 避免默认中断；极短的检查与发送间隔内，继续指令仍可能进入用户刚开始的新一轮。完全消除需要宿主提供条件提交。
3. 离线期间的生命周期事件不会重放。已入队通知可以恢复，未收到的完成事件无法保证补发。重启后发现执行已结束但缺少终止事件时，提示检查结果，不把空闲当成成功。
4. HTTP 回执丢失时重试可能重复通知，不能保证恰好一次。通用 Webhook 可按事件 ID 去重。
5. 用户消息边界缺失、历史分页被替换或状态无法核对时，停止自动继续。

## 开发与验证

`shared/` 定义 Zod 配置和 RPC；`client/` 包含原生设置页与时间线卡片；`server/` 包含分类、纯重试策略、调度器、宿主适配、通知传输和存储。

`npm run check` 执行类型检查、测试和双端构建。测试覆盖预算、去重、取消竞争、回执丢失、重启、平台错误码、本地 HTTP、存储、配置草稿冲突，以及审查创建、决策校验、取消、超时、并发上限、递归抑制和过期结论作废。错误样例、AI 结果和宿主状态由测试构造；真实提供方和通知账户需要实际凭据联调。配置页尚未在真实手机上人工验收。

可使用已安装的宿主编译器做隔离加载验证，无需修改 daemon：

```sh
PASEO_COMPILER_PATH=/path/to/server/plugins/compiler.js npm run build:check
PASEO_COMPILER_PATH=/path/to/server/plugins/compiler.js node scripts/host-smoke.mjs
PASEO_COMPILER_PATH=/path/to/server/plugins/compiler.js npm run package:check
```

接口依据：[Paseo 插件](https://paseo.sh/docs/plugins/reference)、[Paseo SDK](https://paseo.sh/docs/sdk/reference)、[独立代理与结构化输出](https://paseo.sh/docs/sdk/agents)、[提供方选项](https://paseo.sh/docs/sdk/provider-options)、[飞书机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)、[企业微信机器人](https://developer.work.weixin.qq.com/document/path/91770)、[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)、[钉钉加签](https://open.dingtalk.com/document/robots/customize-robot-security-settings)、[Bark](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)、[ntfy](https://docs.ntfy.sh/publish/)、[Slack Webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)、[Discord Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)。
