# 定时任务

本插件给 Paseo Schedule 绑定通知渠道。任务创建、时间安排、启停和执行仍在 Paseo Schedules 中管理。

## 创建任务

在 Paseo Schedules 页面填写工作目录、提供方 / 模型、提示词、cron 和时区。也可通过 Host 终端创建，例如工作日北京时间 09:00 检查项目：

```sh
paseo schedule create \
  --name daily-check \
  --cron "0 9 * * 1-5" \
  --timezone Asia/Shanghai \
  --provider codex \
  --cwd /path/to/project \
  "检查项目状态并汇总需要处理的问题。"
```

替换为该 Host 实际可用的提供方与目录。Host 需要保持运行。更多操作见 [Paseo Schedules](https://paseo.sh/docs/schedules) 和[定时任务 CLI](https://paseo.sh/docs/schedules-cli)。

## 绑定渠道

1. 在插件 Host 设置注册渠道、保存凭据，并发送测试。
2. 切换到「定时任务」栏目，在「定时任务通知渠道」的下拉列表选择任务。也可从命令中心「Notifier：定时任务通知渠道」直接进入此栏目。
3. 关闭「跟随上级」，勾选一个或多个接收渠道。
4. 点击顶部「保存设置」。
5. 在 Schedules 运行一次，或执行 `paseo schedule run-once <任务ID>`，验证实际完成通知。

保留跟随表示使用 Host 默认。关闭跟随且清空选择表示关闭该任务通知。新增任务未出现时点「刷新任务列表」。

## 跨次运行

绑定使用稳定任务 ID。每次运行生成新工作区、新会话，仍使用同一绑定。改名不影响；删除后重新创建会得到新 ID，需要重新选择。

优先级为 **会话明确选择 → 工作区明确选择 → 任务明确选择 → Host 默认**。上次运行的会话选择不会复制到下次运行。

列表读取失败不会清空已有绑定。已绑定但不在列表中的任务仍可修改；恢复「跟随上级」并保存即可移除专用绑定。

## 通知范围

渠道仍受事件、提供方和工作区过滤。任务工作区可能每次不同，限定旧工作区 ID 会挡住新运行的通知。

本插件处理任务会话的完成、失败、权限和恢复事件。在会话创建之前发生的调度失败无法通过这些事件通知，应在 Schedules 查看运行记录。

## Heartbeat

Heartbeat 继续已有会话，不列入 Schedule 选择器。在原会话输入区「通知」中设置渠道即可，继承按该会话的上下文处理。

相关：[通知去向与继承](Notification-routing.md) · [自动恢复](Automatic-recovery.md) · [宿主能力与限制](Host-limitations.md)
