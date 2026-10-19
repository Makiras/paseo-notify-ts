# OpenCode cyber 拒绝保护

OpenCode 会在内部重试部分模型请求，Paseo Notifier 的「自动继续」开关无法控制这一层。部分版本会把 `cyber_policy` 错分成未知提供商错误，继而自动重试。

本仓库提供一个独立 OpenCode 插件，在原生重试发生前否决明确的 cyber 拒绝。网络中断、限流、服务繁忙和其他错误继续使用 OpenCode 原有决定；它不会额外开启任何重试。

## 安装与生效

从本仓库或安装包取出 `server/opencode/cyber-retry-guard.ts`，复制到运行 OpenCode 的主机的用户插件目录。Linux 默认位置是 `~/.config/opencode/plugins/cyber-retry-guard.ts`；配置了 `XDG_CONFIG_HOME` 时，使用其下的 `opencode/plugins/`。

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
cp server/opencode/cyber-retry-guard.ts "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/cyber-retry-guard.ts"
```

这是 OpenCode 插件，需要单独安装。仅更新 Paseo Notifier 不会自动修改 OpenCode 配置或安装这个文件。

在运行中的任务结束后重载 OpenCode 插件或重新启动对应的 OpenCode 服务，检查插件列表中 `paseo-notify.cyber-retry-guard` 处于 active 状态。Paseo 启动的 OpenCode 和终端共享服务可能是不同进程，需要分别确认，不能仅凭文件已复制判断生效。安装不会追溯取消此前已经发出的请求。

## 判断范围

- 检查提供商错误中的 `cyber_policy`、`cyber_safety`，以及明确的 “This content was flagged for possible cybersecurity risk” 拒绝文案。
- 支持 HTTP 200 流内的 `response.failed` 及其中的 `response.error`。
- 不扫描用户聊天记录，不因为任务涉及 cybersecurity 就拦截。
- 不改写请求，不切换模型，也不让 AI 复核批准继续。

Notify 收到同类失败后会将其标记为安全拦截，沿用现有的通知与停止恢复逻辑。其他自动化插件属于独立控制层；当前 Goal 插件对这次拒绝文案按非网络故障停止，但本插件不是所有第三方自动继续行为的全局开关。

## 升级与验证

插件是无运行时依赖的单文件，通过官方 `session.retry` 钩子注册；不修改 OpenCode 可执行文件或 npm 安装目录，升级 OpenCode 通常会保留用户插件文件。更新权限复核插件也不覆盖它。

这不代表对所有未来版本保证兼容：官方接口变更仍需要测试；多个 retry 钩子按注册顺序运行，后注册的插件可能覆盖决定。缺失必需接口时本插件会报加载错误，不会假装已经启用。

CI 安装 OpenCode 2.0.30 和 npm latest，使用独立 HOME、配置和数据库连接本地模拟模型，检查未安装时的基线、安装后的 cyber 拒绝、部分输出后的拒绝，以及 429、503 和未知错误的正常重试。同时加载 Goal 0.1.64，创建隔离的活动目标，验证这次 cyber 文案导致失败后不会自动拉起。测试不使用真实模型、用户凭据或现有会话。

升级前也可以在仓库运行：

```sh
OPENCODE_BIN=/path/to/opencode npm run opencode:smoke
```

需要一起验证 Goal 时，另外设置 `OPENCODE_GOAL_PACKAGE` 为其本地安装包或运行包目录。

相关：[自动恢复](Automatic-recovery.md) · [开发与 CI](Development-and-CI.md) · [OpenCode 官方插件说明](https://opencode.ai/v2/docs/build/plugins/#retry-policy)
