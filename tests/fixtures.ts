import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { defaultConfig, channelSchema } from "../shared/config";
import type { RuntimeStorage } from "../server/runtime";
import type { Secrets, State } from "../server/storage";

export const agent = {
  id: "agent-a",
  workspaceId: "workspace-a",
  parentAgentId: null,
  provider: "codex",
  cwd: "/work/project",
  title: "检查项目",
};
export function event(
  outcome: PluginLifecycleEvents["agent.turn_ended"]["outcome"] = {
    kind: "failed",
    error: { message: "connection reset", code: "ECONNRESET" },
  },
  messageId = "user-a",
): PluginLifecycleEvents["agent.turn_ended"] {
  return {
    agent,
    turnId: null,
    outcome,
    timeline: [
      { type: "user_message", text: "检查项目", clientMessageId: messageId },
      {
        type: "assistant_message",
        text: outcome.kind === "completed" ? "工作已完成" : "正在检查",
      },
    ],
  };
}
export function config() {
  const value = defaultConfig();
  value.recovery.enabled = true;
  value.recovery.baseDelaySeconds = 1;
  value.recovery.maxDelaySeconds = 10;
  value.recovery.maxAttempts = 2;
  value.channels = [
    channelSchema.parse({ id: "hook-a", name: "Webhook", kind: "webhook" }),
  ];
  return value;
}
export class MemoryFile<T> {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private data: T) {}
  read(): T {
    return structuredClone(this.data);
  }
  update<R>(fn: (draft: T) => R): Promise<R> {
    const task = this.chain.then(() => {
      const next = this.read();
      const result = fn(next);
      this.data = next;
      return result;
    });
    this.chain = task.catch(() => undefined);
    return task;
  }
}
export function memory(): RuntimeStorage {
  return {
    state: new MemoryFile<State>({
      version: 1,
      recoveries: [],
      deliveries: [],
      seen: [],
    }),
    secrets: new MemoryFile<Secrets>({
      "hook-a": {
        kind: "webhook",
        values: {
          url: "https://example.invalid/hook",
          signingSecret: "do-not-echo",
          bearerToken: "secret-token",
          headers: {},
        },
      },
    }),
    async close() {},
  };
}
