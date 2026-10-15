# 通知渠道目录

渠道是在当前 Host 注册的发送目标。一个群、一台设备或一个 Webhook 可以各建一个渠道；同一种平台可以注册多个，最多 20 个。

## 注册和使用

1. 在「设置 → 插件 → Paseo Notifier → 通知与自动恢复」的「添加通知渠道」选择平台。
2. 填写便于辨认的名称，例如“开发群”或“我的手机”。在凭据区域填写地址、Token 等。
3. 在「Host 默认通知渠道」勾选默认目标，或随后为工作区、会话、定时任务单独指定。
4. 点页面上方「保存设置」。渠道配置先保存，填写过的凭据随后提交。
5. 在渠道卡片发送测试通知，再运行一个实际任务核对路由。

测试会直接发送到该渠道，不受默认路由、事件过滤和通知总开关影响。测试成功不代表当前会话已经选中此渠道。

## 平台说明

| 平台         | 需要准备                                            | 专页                             |
| ------------ | --------------------------------------------------- | -------------------------------- |
| 通用 Webhook | HTTP 接收地址，可选签名、Bearer Token、自定义请求头 | [Webhook](Channel-Webhook.md)    |
| 飞书 / Lark  | 自定义群机器人 Webhook，可选签名密钥                | [飞书 / Lark](Channel-Feishu.md) |
| 企业微信     | 群机器人 Webhook                                    | [企业微信](Channel-WeCom.md)     |
| Telegram     | Bot Token、Chat ID，可选话题 ID                     | [Telegram](Channel-Telegram.md)  |
| 钉钉         | 群机器人 Webhook，可选加签密钥                      | [钉钉](Channel-DingTalk.md)      |
| Bark         | 带设备 Key 的推送 URL                               | [Bark](Channel-Bark.md)          |
| ntfy         | 服务根地址、Topic，可选访问 Token                   | [ntfy](Channel-ntfy.md)          |
| Slack        | Incoming Webhook                                    | [Slack](Channel-Slack.md)        |
| Discord      | 频道 Webhook，可选线程参数                          | [Discord](Channel-Discord.md)    |

## 公共设置

「启用」控制该渠道是否参加正常投递；事件、提供方和工作区过滤进一步限制已经选中的渠道。空的提供方或工作区列表表示不限制。过滤后没有可用渠道时不会回退到其他群组。

URL、密钥、Token、目标 ID 与自定义请求头通过独立凭据接口保存。界面只展示是否配置，不回填现有秘密；留空的未修改表单不会覆盖已保存凭据。需要完整替换凭据时重新填写，详见[设置与凭据](Settings-and-credentials.md)。

相关：[通知去向与继承](Notification-routing.md) · [通知事件与内容](Notifications.md) · [排错](Activity-and-troubleshooting.md)
