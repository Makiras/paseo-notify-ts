import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PASEO_COMPILER_PATH)
  throw new Error("Set PASEO_COMPILER_PATH to the installed host compiler.js");
const base = pathToFileURL(process.env.PASEO_COMPILER_PATH);
const { evaluateBundle } = await import(
  new URL("./bundle-evaluator.js", base).href
);
const { PluginSettingsStore } = await import(
  new URL("./settings/index.js", base).href
);
const { ScheduleStore } = await import(
  new URL("../schedule/store.js", base).href
);
const directory = await mkdtemp(join(tmpdir(), "paseo-notifier-smoke-"));
const previous = process.env.PASEO_NOTIFIER_STATE_DIR;
const previousHome = process.env.PASEO_HOME;
process.env.PASEO_NOTIFIER_STATE_DIR = join(directory, "operations");
process.env.PASEO_HOME = directory;
let cleanup;
try {
  await mkdir(join(directory, "settings"));
  await writeFile(
    join(directory, "settings", "notifier.json"),
    JSON.stringify({
      version: 1,
      values: {
        channels: [
          { id: "legacy", name: "Legacy", kind: "webhook", enabled: false },
        ],
      },
    }),
  );
  const contribute = evaluateBundle(
    await readFile(".build/host-server.js", "utf8"),
  );
  const settings = new PluginSettingsStore(
    join(directory, "settings"),
    () => {},
  );
  const methods = new Map(),
    hooks = new Map();
  let registered;
  cleanup = contribute({
    registerSettings(definition) {
      registered = settings.register(definition);
      return registered.settings;
    },
    handle(contract, handler) {
      methods.set(contract.name, { contract, handler });
    },
    on(name, handler) {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
    before(name, handler) {
      hooks.set(`before:${name}`, handler);
      return () => hooks.delete(`before:${name}`);
    },
  });
  const invoke = async (name, input = {}) => {
    const { contract, handler } = methods.get(name);
    return contract.output.parse(
      await handler(contract.input.parse(input), { paseo: {} }),
    );
  };
  const first = await invoke("notifier.status");
  assert.equal(first.storageError, null);
  // Use the actual host store so format drift breaks CI before deployment.
  const tasks = new ScheduleStore(join(directory, "schedules"), {
    error: () => assert.fail("Unexpected invalid schedule"),
  });
  const now = new Date().toISOString();
  const schedule = await tasks.create({
    name: "Daily smoke",
    prompt: "private task prompt",
    cadence: {
      type: "cron",
      expression: "0 9 * * *",
      timezone: "Asia/Shanghai",
    },
    target: {
      type: "new-agent",
      config: { provider: "codex", cwd: directory },
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
  });
  const listed = await invoke("notifier.schedules.list");
  assert.equal(listed.unreadable, 0);
  assert.equal(listed.schedules.length, 1);
  assert.equal(listed.schedules[0].id, schedule.id);
  assert.equal(listed.schedules[0].timezone, "Asia/Shanghai");
  assert.equal(JSON.stringify(listed).includes(schedule.prompt), false);
  const current = await registered.read.handle();
  assert.equal(current.status, "ready");
  assert.deepEqual(current.values.routing.host, ["legacy"]);
  assert.equal(
    current.values.notifications.template.title,
    "Paseo · {{event}}",
  );
  assert.deepEqual(current.values.notifications.template.rules, []);
  assert.equal(current.values.notifications.includePreview, false);
  assert.equal(
    JSON.parse(
      await readFile(join(directory, "settings", "notifier.json"), "utf8"),
    ).version,
    7,
  );
  const values = {
    ...current.values,
    notifications: {
      ...current.values.notifications,
      template: {
        title: "检查 · {{event}}",
        body: "工单：{{custom.ticket}}",
        rules: [
          {
            name: "ticket",
            source: "title",
            pattern: "工单：([A-Z]+-[0-9]+)",
            flags: "",
            group: 1,
            fallback: "未提供",
          },
        ],
      },
    },
    channels: [
      {
        id: "local",
        name: "Local",
        kind: "webhook",
        enabled: false,
        events: ["completed"],
        providers: [],
        workspaceIds: [],
      },
      {
        id: "scheduled",
        name: "Scheduled",
        kind: "webhook",
        enabled: true,
        events: ["completed", "recovered", "failed", "permission"],
        providers: [],
        workspaceIds: [],
      },
    ],
    routing: {
      host: ["local"],
      schedules: { [schedule.id]: ["scheduled"] },
      workspaces: { workspace: ["local"] },
      sessions: {},
    },
  };
  const saved = await registered.write.handle({
    revision: current.revision,
    values,
  });
  assert.equal(saved.status, "saved");
  assert.deepEqual(
    saved.values.notifications.template,
    values.notifications.template,
  );
  await invoke("notifier.credentials.save", {
    id: "local",
    kind: "webhook",
    credentials: {
      url: "http://127.0.0.1:1/unused",
      signingSecret: "private-smoke-value",
      bearerToken: "",
      headers: {},
    },
  });
  const status = await invoke("notifier.status");
  assert.equal(status.credentials[0].configured, true);
  assert.equal(JSON.stringify(status).includes("private-smoke-value"), false);
  const transferSettings = await registered.read.handle();
  const ordinary = await invoke("notifier.config.export", {
    revision: transferSettings.revision,
    includeCredentials: false,
  });
  assert.equal(ordinary.text.includes("private-smoke-value"), false);
  assert.deepEqual(JSON.parse(ordinary.text).config.routing.workspaces, {});
  assert.deepEqual(JSON.parse(ordinary.text).config.routing.schedules, {});
  assert.deepEqual(
    JSON.parse(ordinary.text).config.notifications.template,
    values.notifications.template,
  );
  const full = await invoke("notifier.config.export", {
    revision: transferSettings.revision,
    includeCredentials: true,
  });
  const incoming = JSON.parse(full.text);
  incoming.credentials.local.values.url = "http://127.0.0.1:1/another-unused";
  const planned = await invoke("notifier.config.prepare-import", {
    revision: transferSettings.revision,
    text: JSON.stringify(incoming),
  });
  assert.equal(planned.added, 1);
  assert.equal(JSON.stringify(planned).includes("private-smoke-value"), false);
  const beforeImport = await registered.read.handle();
  assert.equal(beforeImport.revision, transferSettings.revision);
  assert.deepEqual(beforeImport.values.routing.host, ["local"]);
  const conflict = await registered.write.handle({
    revision: "stale",
    values: planned.config,
  });
  assert.equal(conflict.status, "conflict");
  const imported = await registered.write.handle({
    revision: planned.revision,
    values: planned.config,
  });
  assert.equal(imported.status, "saved");
  assert.deepEqual(imported.values.routing.workspaces, {
    workspace: ["local"],
  });
  assert.deepEqual(imported.values.routing.schedules, {
    [schedule.id]: ["scheduled"],
  });
  assert.notEqual(imported.values.routing.host[0], "local");
  const privateValues = JSON.parse(
    await readFile(join(directory, "operations", "credentials.json"), "utf8"),
  );
  assert.equal(
    privateValues[imported.values.routing.host[0]].values.url,
    incoming.credentials.local.values.url,
  );
  assert.ok(hooks.has("agent.turn_ended"));
  assert.ok(hooks.has("agent.turn_started"));
  for (const id of ["scheduled-run-one", "scheduled-run-two"]) {
    await hooks.get("agent.turn_ended")(
      {
        agent: {
          id,
          workspaceId: id,
          provider: "codex",
          parentAgentId: null,
          cwd: directory,
          title: "Scheduled run",
        },
        turnId: id,
        outcome: { kind: "completed" },
        timeline: [],
      },
      {
        paseo: {
          agents: {
            ref: () => ({
              refresh: async () => ({
                agent: { labels: { "paseo.schedule-id": schedule.id } },
              }),
            }),
          },
        },
      },
    );
  }
  const routed = await invoke("notifier.status");
  assert.equal(routed.deliveries.length, 2);
  assert.ok(routed.deliveries.every((d) => d.channelId === "scheduled"));
  // This channel deliberately has no credentials: no live notifications run.
  const reviewSettings = await registered.read.handle();
  await registered.write.handle({
    revision: reviewSettings.revision,
    values: {
      ...reviewSettings.values,
      includeSubagents: true,
      recovery: {
        ...reviewSettings.values.recovery,
        enabled: true,
        baseDelaySeconds: 1,
        review: { ...reviewSettings.values.recovery.review, enabled: true },
      },
    },
  });
  const origin = {
    id: "source",
    workspaceId: "workspace",
    provider: "codex",
    model: "mock-model",
    parentAgentId: null,
    cwd: directory,
    title: "Smoke",
  };
  const timeline = [
    { type: "user_message", text: "Check task", clientMessageId: "user-id" },
    { type: "assistant_message", text: "Interrupted" },
  ];
  let reviewId,
    archived = false,
    submitted = false;
  const source = {
    refresh: async () => ({
      agent: {
        ...origin,
        labels: { "paseo.schedule-id": schedule.id },
        status: submitted ? "running" : "error",
        persistence: { sessionId: "session" },
        lastUserMessageAt: "2026-01-01",
        pendingPermissions: [],
      },
    }),
    timeline: {
      refetch: async () => ({
        entries: timeline.map((item) => ({ item })),
        epoch: "e",
        hasOlder: false,
      }),
      append: async () => {},
    },
    send: async (_text, options) => {
      assert.ok(archived);
      assert.equal(options.activeTurnBehavior, "steer");
      submitted = true;
    },
  };
  const reviewer = {
    refresh: async () => ({ agent: { archivedAt: archived ? "now" : null } }),
    archive: async () => {
      archived = true;
    },
    waitForFinish: async () => {
      await hooks.get("agent.turn_ended")(
        {
          agent: { ...origin, id: reviewId, parentAgentId: origin.id },
          turnId: "review-turn",
          outcome: { kind: "completed" },
          timeline: [],
        },
        { paseo },
      );
      return {
        status: "idle",
        lastMessage:
          '{"decision":"continue","reason":"Mock transient failure"}',
      };
    },
  };
  const paseo = {
    agents: { ref: (id) => (id === "source" ? source : reviewer) },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            reviewId = options.agentId;
            assert.equal(options.idempotencyKey, reviewId);
            assert.equal(options.config.options.sandbox_mode, "read-only");
            await hooks.get("agent.created")(
              { agent: { ...origin, id: reviewId, parentAgentId: origin.id } },
              { paseo },
            );
            return { ...reviewer, id: reviewId };
          },
        },
      }),
    },
  };
  await hooks.get("agent.turn_ended")(
    {
      agent: origin,
      turnId: "source-turn",
      outcome: {
        kind: "failed",
        error: { code: "ECONNRESET", message: "connection reset" },
      },
      timeline,
    },
    { paseo },
  );
  const deadline = Date.now() + 5000;
  while (!submitted && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(submitted, "host bundle should review, archive, then continue");
  const checked = await invoke("notifier.status");
  assert.equal(checked.recoveries.length, 1);
  assert.equal(checked.recoveries[0].reviews[0].status, "continue");
  assert.equal(checked.deliveries.length, 2);
  const operations = JSON.parse(
    await readFile(join(directory, "operations", "operations.json"), "utf8"),
  );
  assert.equal(operations.recoveries[0].scheduleId, schedule.id);
  // Reproduce the long-session capacity failure through the installed server
  // bundle. A successful ordinary recovery must never read timeline history.
  const ordinarySettings = await registered.read.handle();
  await registered.write.handle({
    revision: ordinarySettings.revision,
    values: {
      ...ordinarySettings.values,
      recovery: { ...ordinarySettings.values.recovery, enabled: false },
      recoveryOverrides: {
        workspaces: {},
        sessions: {
          "long-session": {
            ...ordinarySettings.values.recovery,
            enabled: true,
            prompt: "session-specific continuation",
            review: {
              ...ordinarySettings.values.recovery.review,
              enabled: false,
            },
          },
        },
      },
    },
  });
  let longSubmitted = false;
  let historyReads = 0;
  const longOrigin = { ...origin, id: "long-session", title: "Long task" };
  const longPaseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            ...longOrigin,
            labels: {},
            status: longSubmitted ? "running" : "error",
            activeTurn: null,
            pendingPermissions: [],
          },
        }),
        timeline: {
          refetch: async () => {
            historyReads++;
            throw new Error("History unavailable");
          },
          append: async () => {},
        },
        send: async (_text, options) => {
          assert.equal(_text, "session-specific continuation");
          assert.equal(options.activeTurnBehavior, "steer");
          assert.ok(options.messageId);
          longSubmitted = true;
        },
      }),
    },
  };
  await hooks.get("agent.turn_ended")(
    {
      agent: longOrigin,
      turnId: "long-failed",
      outcome: {
        kind: "failed",
        error: {
          message:
            "Selected model is at capacity. Please try a different model.",
        },
      },
      timeline: Array.from({ length: 1200 }, () => ({
        type: "assistant_message",
        text: "progress",
      })),
    },
    { paseo: longPaseo },
  );
  const longDeadline = Date.now() + 5000;
  while (!longSubmitted && Date.now() < longDeadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    longSubmitted,
    "long sessions recover without a user-message boundary",
  );
  assert.equal(historyReads, 0, "ordinary recovery must not read history");
  const latestOperations = JSON.parse(
    await readFile(join(directory, "operations", "operations.json"), "utf8"),
  );
  assert.equal(
    latestOperations.recoveries.find((r) => r.agentId === "long-session")
      .attempts,
    1,
  );
  console.log(
    "Host smoke: settings migrated and applied before credential writes; schedule metadata and repeated-run routing validated; portable transfer preserved local bindings; credentials masked; isolated AI review archived before continuation, with reviewer callbacks excluded; long-session capacity failure recovered without any history reads.",
  );
} finally {
  await cleanup?.();
  if (previous === undefined) delete process.env.PASEO_NOTIFIER_STATE_DIR;
  else process.env.PASEO_NOTIFIER_STATE_DIR = previous;
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
}
