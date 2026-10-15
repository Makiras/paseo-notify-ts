import type { NoticeKind } from "./config";
import type { Notification } from "./contracts";

export function notificationExample(
  kind: NoticeKind = "completed",
): Notification {
  return {
    id: "example-notification",
    kind,
    agentId: "example-session",
    workspaceId: "example-workspace",
    scheduleId: "daily-check",
    provider: "codex",
    title: "每日构建检查",
    summary: "请在 Paseo 查看任务结果。",
    preview:
      "已处理工单 PROJ-123。\n结果：https://example.com/result/123\n全部检查通过。",
    createdAt: Date.UTC(2026, 0, 1, 8),
    attempts: ["recovered", "failed"].includes(kind) ? 2 : 0,
    failure:
      kind === "blocked"
        ? "policy_blocked"
        : ["recovered", "failed"].includes(kind)
          ? "network"
          : undefined,
  };
}
