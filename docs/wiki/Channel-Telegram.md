# Telegram Bot

通过 BotFather 创建 Bot，取得 Token。把 Bot 加入目标群或频道并给予发送权限；向自己的私聊发送时，先在 Telegram 中打开 Bot 并开始会话。平台字段定义见 [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage)。

| 界面字段   | 填写方法                                                               |
| ---------- | ---------------------------------------------------------------------- |
| API 根地址 | 默认 `https://api.telegram.org`；使用自建 Bot API 或网关时填写其根地址 |
| Bot Token  | 完整 Token，例如 `123456:EXAMPLE_TOKEN`；不要放进 API 根地址           |
| Chat ID    | 数字 ID，例如 `-1001234567890`，或公开频道的 `@channel_username`       |
| 话题 ID    | 可选，论坛群的正整数 `message_thread_id`                               |

Chat ID 与群名称不同。使用你控制的 Bot 接口取得目标 ID，不需要把 Token 提交给陌生查询服务。话题 ID 仅在该群启用对应话题时填写。

插件调用 `sendMessage`，发送普通文本并关闭链接预览；支持 API 返回的限流等待时间。它不会注册 Bot Webhook，也不会读取消息、处理回复或调用 `getUpdates`。

保存后按[公共步骤](Channels.md)选择路由并测试。`chat not found` 或权限类失败通常要检查目标 ID、Bot 是否加入和发送权限；Host 还必须能访问选定 API 地址。
