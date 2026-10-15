import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { scopeIdSchema } from "../shared/config";
import { scheduleIdFromLabels, type ScheduleInfo } from "../shared/schedules";
import type { PaseoApi } from "./types";

// The plugin SDK has no schedule-list API. Read only the host's persisted
// metadata; never return prompts, provider options, credentials, or run output.
const storedMetadata = z.object({
  id: scopeIdSchema,
  name: z.string().nullable(),
  status: z.enum(["active", "paused", "completed"]),
  cadence: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("cron"),
      expression: z.string(),
      timezone: z.string().optional(),
    }),
    z.object({ type: z.literal("every"), everyMs: z.number().positive() }),
  ]),
  target: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("new-agent"),
      config: z.object({ cwd: z.string() }),
    }),
    z.object({ type: z.literal("agent") }),
  ]),
});

export async function listSchedules(
  paseoHome: string,
): Promise<{ schedules: ScheduleInfo[]; unreadable: number }> {
  const directory = join(paseoHome, "schedules");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schedules: [], unreadable: 0 };
    throw new Error("无法读取定时任务列表，请检查 Host 数据目录权限");
  }
  const schedules: ScheduleInfo[] = [];
  let unreadable = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const file = await open(join(directory, entry.name), "r");
      let value: unknown;
      try {
        if ((await file.stat()).size > 16 * 1024 * 1024)
          throw new Error("Too large");
        value = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      const metadata = storedMetadata.parse(value);
      if (metadata.target.type !== "new-agent") continue;
      schedules.push({
        id: metadata.id,
        name: metadata.name || metadata.id,
        status: metadata.status,
        cadence:
          metadata.cadence.type === "cron"
            ? metadata.cadence.expression
            : `每 ${metadata.cadence.everyMs / 1000} 秒`,
        timezone:
          metadata.cadence.type === "cron"
            ? (metadata.cadence.timezone ?? "UTC")
            : "UTC",
        cwd: metadata.target.config.cwd,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable++;
    }
  }
  return {
    schedules: schedules.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    unreadable,
  };
}

export async function resolveAgentSchedule(
  paseo: PaseoApi,
  agentId: string,
): Promise<string | null> {
  const snapshot = await paseo.agents.ref(agentId).refresh();
  if (!snapshot?.agent)
    throw new Error("无法核对会话的定时任务来源，已停止本次通知处理");
  return scheduleIdFromLabels(snapshot.agent.labels);
}
