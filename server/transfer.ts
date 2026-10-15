import { randomUUID } from "node:crypto";
import { configSchema, type Channel, type Config } from "../shared/config";
import {
  portableConfig,
  transferLimit,
  transferSchema,
  type Transfer,
  type TransferSecrets,
} from "../shared/transfer";
import { validateCredentials } from "./channels";

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const definition = ({ id: _id, originId: _origin, ...channel }: Channel) =>
  canonical(channel);

export function exportConfiguration(
  config: Config,
  secrets: TransferSecrets,
  includeCredentials: boolean,
): string {
  const value: Transfer = {
    schema: "paseo-notify-ts/config",
    version: 1,
    config: portableConfig(config),
  };
  if (includeCredentials) {
    value.credentials = {};
    for (const channel of config.channels) {
      const secret = secrets[channel.id];
      if (secret?.kind === channel.kind)
        value.credentials[channel.id] = structuredClone(secret);
    }
  }
  const text = JSON.stringify(transferSchema.parse(value), null, 2);
  if (text.length > transferLimit)
    throw new Error("配置过大，无法通过剪贴板导出");
  return text;
}

export function planImport(
  current: Config,
  secrets: TransferSecrets,
  incoming: Transfer,
  newId = () => `import-${randomUUID()}`,
) {
  const channels = structuredClone(current.channels);
  const staged: TransferSecrets = {};
  const mapped = new Map<string, string>();
  let reused = 0;
  for (const channel of incoming.config.channels) {
    const secret = incoming.credentials?.[channel.id];
    if (secret) validateCredentials(secret.kind, secret.values);
    const existing = channels.find(
      (candidate) =>
        definition(candidate) === definition(channel) &&
        (secret
          ? canonical(secrets[candidate.id] ?? staged[candidate.id]) ===
            canonical(secret)
          : (candidate.originId ?? candidate.id) ===
            (channel.originId ?? channel.id)),
    );
    if (existing) {
      mapped.set(channel.id, existing.id);
      reused++;
      continue;
    }
    // New random IDs keep staged credentials unreachable by existing selections.
    const id = newId();
    if (channels.some((c) => c.id === id) || secrets[id])
      throw new Error("导入渠道 ID 冲突，请重试");
    channels.push({ ...channel, id, originId: channel.originId ?? channel.id });
    mapped.set(channel.id, id);
    if (secret) staged[id] = structuredClone(secret);
  }
  if (channels.length > 20)
    throw new Error("合并后渠道超过 20 个，请先移除不再使用的渠道");
  const config = configSchema.parse({
    ...incoming.config,
    channels,
    routing: {
      ...current.routing,
      host: incoming.config.routing.host.map((id) => mapped.get(id)!),
    },
  });
  return {
    config,
    staged,
    added: incoming.config.channels.length - reused,
    reused,
    missingCredentials: [...mapped.values()].filter(
      (id) => !secrets[id] && !staged[id],
    ).length,
  };
}
