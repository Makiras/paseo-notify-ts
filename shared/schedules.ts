import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { scopeIdSchema } from "./config";

export function scheduleIdFromLabels(
  labels?: Readonly<Record<string, string>> | null,
): string | null {
  const id = labels?.["paseo.schedule-id"];
  return scopeIdSchema.safeParse(id).success ? id! : null;
}

export const scheduleInfoSchema = z.object({
  id: scopeIdSchema,
  name: z.string(),
  status: z.enum(["active", "paused", "completed"]),
  cadence: z.string(),
  timezone: z.string(),
  cwd: z.string(),
});
export type ScheduleInfo = z.infer<typeof scheduleInfoSchema>;
export const listSchedulesRpc = defineRpc({
  name: "notifier.schedules.list",
  input: z.object({}),
  output: z.object({
    schedules: z.array(scheduleInfoSchema),
    unreadable: z.number().int().nonnegative(),
  }),
});
