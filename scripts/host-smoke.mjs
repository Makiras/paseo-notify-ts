import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const directory = await mkdtemp(join(tmpdir(), "paseo-notifier-smoke-"));
const previous = process.env.PASEO_NOTIFIER_STATE_DIR;
process.env.PASEO_NOTIFIER_STATE_DIR = join(directory, "operations");
let cleanup;
try {
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
  const current = await registered.read.handle();
  assert.equal(current.status, "ready");
  const values = {
    ...current.values,
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
    ],
  };
  const saved = await registered.write.handle({
    revision: current.revision,
    values,
  });
  assert.equal(saved.status, "saved");
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
  assert.ok(hooks.has("agent.turn_ended"));
  assert.ok(hooks.has("agent.turn_started"));
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
        status: submitted ? "running" : "idle",
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
  assert.equal(checked.deliveries.length, 0);
  console.log(
    "Host smoke: bundle loaded, native settings persisted, RPC schemas validated, credentials masked; isolated AI review archived before continuation, with reviewer callbacks excluded.",
  );
} finally {
  await cleanup?.();
  if (previous === undefined) delete process.env.PASEO_NOTIFIER_STATE_DIR;
  else process.env.PASEO_NOTIFIER_STATE_DIR = previous;
  await rm(directory, { recursive: true, force: true });
}
