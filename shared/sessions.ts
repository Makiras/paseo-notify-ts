import { configSchema } from "./config";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const sessionId = z.string().uuid();
export const sessionInfo = z.object({
  id: sessionId,
  title: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  status: z.string(),
  archivedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;
export const listSessionsRpc = defineRpc({
  name: "notifier.sessions.list",
  input: z.object({ cursor: z.string().max(8192).optional() }),
  output: z.object({
    sessions: z.array(sessionInfo),
    nextCursor: z.string().nullable(),
    canDelete: z.boolean(),
    unreadable: z.number().int().nonnegative(),
  }),
});
export const prepareDeleteSessionsRpc = defineRpc({
  name: "notifier.sessions.prepare-delete",
  input: z.object({
    ids: z.array(sessionId).min(1).max(20),
    archivedOnly: z.boolean().default(false),
  }),
  output: z.object({
    token: z.string().uuid(),
    sessions: z.array(sessionInfo),
  }),
});
export const deleteSessionRpc = defineRpc({
  name: "notifier.sessions.delete",
  input: z.object({ token: z.string().uuid(), id: sessionId }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const prepareSessionConfigCleanupRpc = defineRpc({
  name: "notifier.sessions.prepare-config-cleanup",
  input: z.object({ ids: z.array(sessionId).min(1).max(20) }),
  output: z.object({
    revision: z.string(),
    config: configSchema,
    changed: z.boolean(),
  }),
});

export function sessionStatus(
  session: Pick<SessionInfo, "status" | "archivedAt">,
): string {
  const labels: Record<string, string> = {
    initializing: "正在初始化",
    idle: "空闲",
    running: "运行中",
    error: "出错",
    closed: "已停止",
  };
  return [
    session.archivedAt ? "已归档" : null,
    labels[session.status] || session.status,
  ]
    .filter(Boolean)
    .join(" · ");
}
