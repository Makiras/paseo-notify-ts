# 钉钉群机器人

在目标群创建自定义机器人，复制 Webhook。安全设置可使用加签；若启用关键词检查，将 `Paseo` 加入允许关键词。见[钉钉自定义机器人安全设置](https://open.dingtalk.com/document/robots/customize-robot-security-settings)。

| 界面字段    | 填写方法                                                    |
| ----------- | ----------------------------------------------------------- |
| Webhook URL | `https://oapi.dingtalk.com/robot/send?access_token=<Token>` |
| 加签密钥    | 开启加签时填写机器人给出的完整密钥                          |

插件按平台协议添加时间戳和签名，发送以 `Paseo` 开头的文本；不启用全体提醒。它会检查平台业务返回码，而不只检查 HTTP 成功。

保存后按[公共步骤](Channels.md)选择路由并测试。若仍被拒绝，检查关键词、签名密钥、Host 出口 IP 限制和机器人的可用状态。不要将已经带有临时时间戳或签名的请求 URL 当作长期 Webhook 保存。
