# Slack Incoming Webhook

为 Slack 应用启用 Incoming Webhooks，授权到目标频道并复制 URL。步骤见 [Slack 官方 Incoming Webhook 说明](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)。

| 界面字段    | 填写方法                                                                             |
| ----------- | ------------------------------------------------------------------------------------ |
| Webhook URL | `https://hooks.slack.com/services/<路径>`；也支持 Slack Gov 的 `hooks.slack-gov.com` |

此渠道不需要单独 Bot Token 或 Channel ID，目标由 Webhook 授权决定。发送至多个频道时，为各频道分别注册渠道。

插件发送文本，转义 Slack 特殊字符，关闭链接展开，并检查响应中的 `ok`。原任务中的文本不会直接变成频道或用户提及。

保存后按[公共步骤](Channels.md)选择路由并测试。若返回永久错误，检查应用授权、频道是否可用及 Webhook 是否被撤销。
