import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  channelIdSchema,
  channelKindSchema,
  configSchema,
  type Config,
} from "./config";
import { credentialsSchema } from "./contracts";

export const transferLimit = 1024 * 1024;
export const transferSecretsSchema = z.record(
  channelIdSchema,
  z.object({
    kind: channelKindSchema,
    values: credentialsSchema,
  }),
);
export type TransferSecrets = z.infer<typeof transferSecretsSchema>;
export const transferSchema = z
  .object({
    schema: z.literal("paseo-notify-ts/config"),
    version: z.union([z.literal(1), z.literal(2)]),
    config: configSchema.refine(
      (v) =>
        !Object.keys(v.routing.schedules).length &&
        !Object.keys(v.routing.workspaces).length &&
        !Object.keys(v.routing.sessions).length &&
        !Object.keys(v.recoveryOverrides.workspaces).length &&
        !Object.keys(v.recoveryOverrides.sessions).length &&
        v.channels.every((c) => !c.workspaceIds.length),
      "跨 Host 配置不能包含本地定时任务 / Workspace / Session 绑定或工作区过滤",
    ),
    credentials: transferSecretsSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const [id, secret] of Object.entries(v.credentials ?? {})) {
      if (!v.config.channels.some((c) => c.id === id && c.kind === secret.kind))
        ctx.addIssue({
          code: "custom",
          path: ["credentials"],
          message: "凭据与渠道不匹配",
        });
    }
  });
export type Transfer = z.infer<typeof transferSchema>;

export function parseTransfer(text: string): Transfer {
  if (text.length > transferLimit)
    throw new Error("导入内容超过 1 MiB 字符限制");
  try {
    return transferSchema.parse(JSON.parse(text));
  } catch {
    // Validation errors may contain secrets from the input. Do not echo them.
    throw new Error(
      "配置格式无效，请粘贴本插件导出的完整 JSON；本地绑定不能跨 Host 导入",
    );
  }
}

export function portableConfig(config: Config): Config {
  const next = structuredClone(config);
  next.routing.schedules = {};
  next.routing.workspaces = {};
  next.routing.sessions = {};
  next.recoveryOverrides = { workspaces: {}, sessions: {} };
  for (const channel of next.channels) channel.workspaceIds = [];
  return next;
}

export const exportConfigRpc = defineRpc({
  name: "notifier.config.export",
  input: z.object({ revision: z.string(), includeCredentials: z.boolean() }),
  output: z.object({ text: z.string().max(transferLimit) }),
});
export const prepareImportRpc = defineRpc({
  name: "notifier.config.prepare-import",
  input: z.object({
    revision: z.string(),
    text: z.string().max(transferLimit),
  }),
  output: z.object({
    revision: z.string(),
    config: configSchema,
    added: z.number().int(),
    reused: z.number().int(),
    missingCredentials: z.number().int(),
  }),
});
