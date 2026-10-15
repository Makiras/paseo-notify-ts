# 飞书 / Lark 群机器人

在接收群添加自定义机器人，复制机器人的 Webhook；如果开启了签名校验，同时取得签名密钥。具体入口以[飞书自定义机器人说明](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)为准。

| 界面字段    | 填写方法                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------ |
| Webhook URL | `https://open.feishu.cn/open-apis/bot/v2/hook/<机器人 ID>`；Lark 使用 `open.larksuite.com` |
| 签名密钥    | 开启机器人签名时填写，否则留空                                                             |

插件发送文本消息，自动计算签名，并检查平台业务返回码。消息中的 `<at` 会被转义，避免任务内容意外触发提醒其他成员。

保存渠道、选择默认或局部路由后测试。收不到消息时先核对完整地址、签名配置以及机器人允许的关键词或来源策略。这里使用自定义群机器人，不使用应用机器人的 App ID / App Secret。

相关：[公共配置步骤](Channels.md) · [设置与凭据](Settings-and-credentials.md)
