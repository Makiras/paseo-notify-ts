import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const releaseSchema = z.object({
  id: z.number().int().positive(),
  tag: z.string(),
  version: z.string(),
  url: z.string(),
  publishedAt: z.string(),
});
export type Release = z.infer<typeof releaseSchema>;
export const updateStatusSchema = z.object({
  currentVersion: z.string(),
  currentRevision: z.string().nullable(),
  release: releaseSchema.nullable(),
  available: z.boolean(),
  checkedAt: z.number().nullable(),
  error: z.string().nullable(),
  canInstall: z.boolean(),
  installHint: z.string(),
  command: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export const checkUpdatesRpc = defineRpc({
  name: "notifier.updates.check",
  input: z.object({ force: z.boolean().default(false) }),
  output: updateStatusSchema,
});
export const updateWorkspacesRpc = defineRpc({
  name: "notifier.updates.workspaces",
  input: z.object({}),
  output: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const installUpdateRpc = defineRpc({
  name: "notifier.updates.install",
  input: z.object({
    releaseId: z.number().int().positive(),
    tag: z
      .string()
      .regex(/^v\d+\.\d+\.\d+$/)
      .max(40),
    workspaceId: z.string().min(1).max(256),
    revision: z.string(),
  }),
  output: z.object({ terminalId: z.string(), workspaceId: z.string() }),
});
