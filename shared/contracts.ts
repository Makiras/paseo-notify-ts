import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  channelIdSchema,
  channelKindSchema,
  failureKindSchema,
  noticeKindSchema,
} from "./config";

export const credentialsSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  signingSecret: z.string().max(1024).default(""),
  bearerToken: z.string().max(4096).default(""),
  headers: z.record(z.string(), z.string().max(4096)).default({}),
  target: z.string().trim().max(256).optional(),
  threadId: z.string().trim().regex(/^\d*$/).max(32).optional(),
});
export type Credentials = z.infer<typeof credentialsSchema>;
export const reviewRecordSchema = z.object({
  agentId: z.string(),
  status: z.enum(["pending", "continue", "stop", "needs_user", "error"]),
  reason: z.string().max(500),
  createdAt: z.number(),
  cleanupPending: z.boolean(),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export const recoveryCardSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  phase: z.enum([
    "waiting",
    "reviewing",
    "dispatching",
    "running",
    "paused",
    "exhausted",
    "done",
    "canceled",
  ]),
  reason: z.string(),
  attempts: z.number().int(),
  dueAt: z.number().nullable(),
  updatedAt: z.number(),
  reviews: z.array(reviewRecordSchema).max(20).default([]),
});
export type RecoveryCard = z.infer<typeof recoveryCardSchema>;
export const statusSchema = z.object({
  connected: z.boolean(),
  settingsError: z.string().nullable(),
  storageError: z.string().nullable(),
  credentials: z.array(
    z.object({
      id: z.string(),
      kind: channelKindSchema,
      configured: z.boolean(),
    }),
  ),
  recoveries: z.array(recoveryCardSchema),
  deliveries: z.array(
    z.object({
      id: z.string(),
      channelId: z.string(),
      title: z.string(),
      kind: noticeKindSchema,
      phase: z.enum(["pending", "sent", "failed", "canceled"]),
      attempts: z.number(),
      dueAt: z.number(),
      error: z.string().nullable(),
      updatedAt: z.number(),
    }),
  ),
});
export type RuntimeStatus = z.infer<typeof statusSchema>;
export const statusRpc = defineRpc({
  name: "notifier.status",
  input: z.object({}),
  output: statusSchema,
});
export const saveCredentialsRpc = defineRpc({
  name: "notifier.credentials.save",
  input: z.object({
    id: channelIdSchema,
    kind: channelKindSchema,
    credentials: credentialsSchema,
  }),
  output: z.object({ ok: z.literal(true) }),
});
export const deleteCredentialsRpc = defineRpc({
  name: "notifier.credentials.delete",
  input: z.object({ id: channelIdSchema }),
  output: z.object({ ok: z.literal(true) }),
});
export const testChannelRpc = defineRpc({
  name: "notifier.channel.test",
  input: z.object({ id: channelIdSchema }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
export const cancelRecoveryRpc = defineRpc({
  name: "notifier.recovery.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
export const retryDeliveryRpc = defineRpc({
  name: "notifier.delivery.retry",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const notificationSchema = z.object({
  id: z.string(),
  kind: noticeKindSchema,
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  provider: z.string(),
  title: z.string(),
  summary: z.string(),
  preview: z.string().optional(),
  createdAt: z.number(),
  failure: failureKindSchema.optional(),
  attempts: z.number().int().default(0),
});
export type Notification = z.infer<typeof notificationSchema>;
