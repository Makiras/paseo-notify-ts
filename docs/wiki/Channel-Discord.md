# Discord Webhook

在目标频道的集成设置中创建 Webhook 并复制地址。接口参数见 [Discord Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)。

| 界面字段    | 填写方法                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| Webhook URL | `https://discord.com/api/webhooks/<ID>/<Token>`；支持官方 canary / ptb 和兼容旧域名 |

需要向已有线程发送时，可在 URL 添加 `?thread_id=<线程 ID>`。插件不创建论坛帖子或线程，也不提供 Bot 回复能力。

插件发送文本，关闭提及解析和链接嵌入，并强制等待消息确认；超过长度限制时截短。API 返回限流时遵守其重试等待时间。

保存后按[公共步骤](Channels.md)选择路由并测试。地址失效时重新复制 Webhook，线程目标不可用时核对线程是否存在、归档及权限状态。
