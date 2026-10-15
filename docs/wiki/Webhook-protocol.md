# Webhook 协议

本页面向通用 Webhook 接收端开发者。其他平台由各自适配器生成请求，不使用本协议。

## 请求

使用 HTTP POST，`Content-Type: application/json`，不跟随重定向；单次请求超时 15 秒。请求体示例：

```json
{
  "schema": "paseo-notifier/v1",
  "id": "event-example",
  "kind": "completed",
  "agentId": "agent-example",
  "workspaceId": "workspace-example",
  "scheduleId": null,
  "provider": "codex",
  "title": "检查项目",
  "summary": "任务已完成",
  "attempts": 0,
  "createdAt": 1792022400000,
  "text": "Paseo · 任务完成\n检查项目\n任务已完成"
}
```

`text` 是供人阅读的文本，接收程序应使用结构化字段。`preview` 仅在启用摘要并有内容时出现；`failure` 在相关失败事件出现。普通会话的 `scheduleId` 可为 `null` 或省略。`createdAt` 是 Unix 毫秒，`attempts` 是任务恢复次数，不是 HTTP 投递次数。

`kind` 可为 `completed`、`recovered`、`failed`、`blocked`、`permission`、`test`。`failure` 可为 `network`、`overloaded`、`rate_limited`、`quota_exhausted`、`context_exhausted`、`policy_blocked`、`unknown`。

## 请求头与签名

| 请求头              | 内容                                      |
| ------------------- | ----------------------------------------- |
| `Idempotency-Key`   | 事件 ID，重试不变                         |
| `X-Paseo-Event-Id`  | 同一事件 ID                               |
| `X-Paseo-Timestamp` | 本次发送的 Unix 秒                        |
| `X-Paseo-Signature` | 配置签名密钥时为 `sha256=<十六进制 HMAC>` |
| `Authorization`     | 配置 Bearer Token 时为 `Bearer <Token>`   |

签名输入为 `timestamp + "." + 原始请求体字节`，算法 HMAC-SHA256，密钥是配置的签名密钥。接收端应使用原始 HTTP body 验证，不能把 JSON 解析后重新序列化再验签。签名比较使用常量时间比较，并按自身策略检查时间戳窗口。

自定义请求头最多 20 项，不能覆盖 `Content-Type`、幂等键、`X-Paseo-*`、Host 或连接 / 长度控制字段。

## 回执和幂等

HTTP 2xx 表示受理，不解析响应正文。408、429、5xx 和网络失败会按预算重试；其他 HTTP 错误通常直接标为失败。返回 `Retry-After` 可以要求等待，支持秒数或 HTTP 日期。

接收端应按事件 ID 去重，并在可靠受理后及时返回 2xx。如果已经处理同一事件，仍可返回 2xx。相同事件在重试时会重新生成时间戳和签名，因此不能按签名去重。

相关：[通知事件与内容](Notifications.md) · [存储与可靠性](Storage-and-reliability.md) · [Webhook 配置](Channel-Webhook.md)
