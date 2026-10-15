import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const channelKindSchema = z.enum([
  "webhook",
  "feishu",
  "wecom",
  "telegram",
  "dingtalk",
  "bark",
  "ntfy",
  "slack",
  "discord",
]);
export const channelNames: Record<z.infer<typeof channelKindSchema>, string> = {
  webhook: "通用 Webhook",
  feishu: "飞书 / Lark 群机器人",
  wecom: "企业微信群机器人",
  telegram: "Telegram Bot",
  dingtalk: "钉钉群机器人",
  bark: "Bark",
  ntfy: "ntfy",
  slack: "Slack",
  discord: "Discord",
};
export const noticeKindSchema = z.enum([
  "completed",
  "recovered",
  "failed",
  "blocked",
  "permission",
  "test",
]);
export const failureKindSchema = z.enum([
  "network",
  "overloaded",
  "rate_limited",
  "quota_exhausted",
  "context_exhausted",
  "policy_blocked",
  "unknown",
]);
export type FailureKind = z.infer<typeof failureKindSchema>;
export type NoticeKind = z.infer<typeof noticeKindSchema>;
export const channelIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const selectionSchema = z
  .array(channelIdSchema)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "通知渠道不能重复",
  });
const scopeIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => !["__proto__", "constructor", "prototype"].includes(id));
const scopeSelections = z
  .unknown()
  .superRefine((value, ctx) => {
    if (
      value &&
      typeof value === "object" &&
      Object.keys(value).some((key) =>
        ["__proto__", "constructor", "prototype"].includes(key),
      )
    )
      ctx.addIssue({ code: "custom", message: "无效的绑定标识" });
  })
  .pipe(z.record(scopeIdSchema, selectionSchema));
export const routingSchema = z.object({
  host: selectionSchema.default([]),
  // Missing key means inheritance; an explicit [] means muted.
  workspaces: scopeSelections
    .default({})
    .refine((v) => Object.keys(v).length <= 1000, "工作区绑定过多"),
  sessions: scopeSelections
    .default({})
    .refine((v) => Object.keys(v).length <= 5000, "会话绑定过多"),
});

export const channelSchema = z.object({
  id: channelIdSchema,
  originId: channelIdSchema.optional(),
  name: z.string().trim().min(1).max(80),
  kind: channelKindSchema,
  enabled: z.boolean().default(true),
  events: z
    .array(noticeKindSchema)
    .default(["completed", "recovered", "failed", "blocked", "permission"]),
  providers: z.array(z.string().min(1).max(80)).max(32).default([]),
  workspaceIds: z.array(z.string().min(1).max(256)).max(100).default([]),
});
export type Channel = z.infer<typeof channelSchema>;

export const reviewSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.string().trim().max(200).default(""),
    timeoutSeconds: z.number().int().min(10).max(600).default(90),
    maxReviews: z.number().int().min(1).max(20).default(5),
    contextCharacters: z.number().int().min(1000).max(24000).default(8000),
  })
  .refine(
    (v) => !v.provider || /^(codex|claude|opencode)(\/\S+)?$/.test(v.provider),
    {
      message:
        "复核提供方填写 codex、claude、opencode，或提供方/模型；留空沿用原会话",
      path: ["provider"],
    },
  );
export type ReviewConfig = z.infer<typeof reviewSchema>;

export const recoverySchema = z
  .object({
    enabled: z.boolean().default(false),
    network: z.boolean().default(true),
    overloaded: z.boolean().default(true),
    rateLimited: z.boolean().default(true),
    review: reviewSchema.prefault({}),
    maxAttempts: z.number().int().min(1).max(20).default(5),
    maxElapsedMinutes: z.number().int().min(1).max(240).default(30),
    baseDelaySeconds: z.number().int().min(1).max(600).default(10),
    maxDelaySeconds: z.number().int().min(1).max(3600).default(300),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .default(
        "上一次执行因临时服务或网络故障中断。请检查已有进度，从中断处继续原任务，避免重复已经完成的操作。",
      ),
  })
  .refine((v) => v.maxDelaySeconds >= v.baseDelaySeconds, {
    message: "最大等待时间不能小于初始等待时间",
    path: ["maxDelaySeconds"],
  });

export const configSchema = z
  .object({
    enabled: z.boolean().default(true),
    includeSubagents: z.boolean().default(false),
    recovery: recoverySchema.prefault({}),
    notifications: z
      .object({
        includePreview: z.boolean().default(false),
        previewCharacters: z.number().int().min(80).max(2000).default(600),
        maxAttempts: z.number().int().min(1).max(12).default(5),
        retentionDays: z.number().int().min(1).max(30).default(7),
      })
      .prefault({}),
    channels: z.array(channelSchema).max(20).default([]),
    routing: routingSchema.prefault({}),
  })
  .refine(
    (v) => new Set(v.channels.map((c) => c.id)).size === v.channels.length,
    { message: "渠道 ID 不能重复", path: ["channels"] },
  )
  .superRefine((v, ctx) => {
    const known = new Set(v.channels.map((c) => c.id));
    for (const ids of [
      v.routing.host,
      ...Object.values(v.routing.workspaces),
      ...Object.values(v.routing.sessions),
    ]) {
      if (ids.some((id) => !known.has(id))) {
        ctx.addIssue({
          code: "custom",
          path: ["routing"],
          message: "通知选择包含不存在的渠道",
        });
        break;
      }
    }
  });
export type Config = z.infer<typeof configSchema>;
export const defaultConfig = (): Config => configSchema.parse({});
export function migrateSettings(values: unknown, fromVersion: number): Config {
  if (fromVersion !== 1) throw new Error("不支持的设置格式");
  const config = configSchema.parse(values);
  // Preserve the previous fan-out for existing installations only.
  config.routing.host = config.channels.map((c) => c.id);
  return config;
}
export const preferences = defineSettings({
  id: "notifier",
  scope: "host",
  version: 2,
  schema: configSchema,
  migrate: migrateSettings,
});

export const failureLabels: Record<FailureKind, string> = {
  network: "网络故障",
  overloaded: "服务繁忙",
  rate_limited: "请求限流",
  quota_exhausted: "额度耗尽",
  context_exhausted: "上下文已满",
  policy_blocked: "安全策略拦截",
  unknown: "未识别的错误",
};
export const noticeLabels: Record<NoticeKind, string> = {
  completed: "任务完成",
  recovered: "恢复后完成",
  failed: "任务失败",
  blocked: "需要处理",
  permission: "等待权限确认",
  test: "测试通知",
};
