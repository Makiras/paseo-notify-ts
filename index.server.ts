import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "./server/types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defaultConfig, preferences } from "./shared/config";
import {
  statusRpc,
  saveCredentialsRpc,
  deleteCredentialsRpc,
  testChannelRpc,
  cancelRecoveryRpc,
  retryDeliveryRpc,
  type RuntimeStatus,
} from "./shared/contracts";
import { Storage } from "./server/storage";
import { Runtime } from "./server/runtime";
import { paseoPort } from "./server/paseo";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const directory =
    process.env.PASEO_NOTIFIER_STATE_DIR ??
    join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "notifier");
  let stopped = false;
  let bootError: string | null = null;
  const ready = (async () => {
    const storage = await Storage.open(directory);
    const runtime = new Runtime(storage);
    try {
      const state = await settings.read();
      const config =
        state.status === "ready"
          ? state.values
          : { ...defaultConfig(), enabled: false };
      await runtime.start(config);
      runtime.settingsError = state.status === "invalid" ? state.error : null;
      return runtime;
    } catch (error) {
      await storage.close();
      throw error;
    }
  })();
  void ready.catch(() => {
    bootError =
      "无法初始化运行记录。请检查数据目录权限、文件内容及是否有重复实例，然后重新加载插件。";
    console.error(
      "[paseo-notifier] Initialization failed. Check private state directory permissions, contents, and owner.lock.",
    );
  });
  let configUpdates: Promise<unknown> = Promise.resolve();
  const unsubscribe = settings.subscribe((state) => {
    configUpdates = configUpdates
      .catch(() => undefined)
      .then(async () => {
        const runtime = await ready;
        if (stopped) return;
        runtime.settingsError = state.status === "invalid" ? state.error : null;
        await runtime.configure(
          state.status === "ready"
            ? state.values
            : { ...defaultConfig(), enabled: false },
        );
      });
    return configUpdates.then(() => undefined);
  });
  async function run<T>(
    paseo: PaseoApi,
    fn: (runtime: Runtime) => Promise<T> | T,
  ): Promise<T> {
    const runtime = await ready;
    if (stopped) throw new Error("插件已停止");
    runtime.connect(paseoPort(paseo));
    return fn(runtime);
  }
  server.on("agent.turn_ended", (event, ctx) =>
    run(ctx.paseo, (r) => r.turnEnded(event)),
  );
  server.on("agent.turn_started", (event, ctx) =>
    run(ctx.paseo, (r) => r.turnStarted(event.agent.id)),
  );
  server.on("agent.permission_requested", (event, ctx) =>
    run(ctx.paseo, (r) => r.permission(event.agent, event.request.id)),
  );
  server.on("agent.archived", (event, ctx) =>
    run(ctx.paseo, (r) => r.cancelAgent(event.agent.id, "会话已归档")),
  );
  server.on("agent.closed", (event, ctx) =>
    run(ctx.paseo, (r) => r.cancelAgent(event.agent.id, "会话已关闭")),
  );
  server.on("workspace.archived", (event, ctx) =>
    run(ctx.paseo, (r) => r.cancelWorkspace(event.workspace.id)),
  );
  server.before("agent.session_open", (_event, ctx) =>
    run(ctx.paseo, () => undefined),
  );
  server.on("agent.created", (event, ctx) =>
    run(ctx.paseo, (r) => r.agentCreated(event.agent.id)),
  );
  server.handle(statusRpc, async (_input, ctx): Promise<RuntimeStatus> => {
    try {
      return await run(ctx.paseo, (r) => r.status());
    } catch {
      return {
        connected: false,
        settingsError: null,
        storageError: bootError ?? "插件正在停止或无法读取运行状态",
        credentials: [],
        recoveries: [],
        deliveries: [],
      };
    }
  });
  server.handle(saveCredentialsRpc, (input, ctx) =>
    run(ctx.paseo, async (r) => {
      await r.setCredentials(input.id, input.kind, input.credentials);
      return { ok: true as const };
    }),
  );
  server.handle(deleteCredentialsRpc, (input, ctx) =>
    run(ctx.paseo, async (r) => {
      await r.deleteCredentials(input.id);
      return { ok: true as const };
    }),
  );
  server.handle(testChannelRpc, (input, ctx) =>
    run(ctx.paseo, (r) => r.testChannel(input.id)),
  );
  server.handle(cancelRecoveryRpc, (input, ctx) =>
    run(ctx.paseo, async (r) => ({ ok: await r.cancelRecovery(input.id) })),
  );
  server.handle(retryDeliveryRpc, (input, ctx) =>
    run(ctx.paseo, async (r) => ({ ok: await r.retryDelivery(input.id) })),
  );
  return async () => {
    stopped = true;
    await unsubscribe();
    await configUpdates.catch(() => undefined);
    const runtime = await ready.catch(() => undefined);
    await runtime?.close();
  };
}
