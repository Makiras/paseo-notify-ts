import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Use the installed host's real publisher, timeline projection, settings store,
// compiler and plugin evaluator. All agent data is synthetic; no model or
// notification credentials are configured and the user's daemon is never used.
const host = resolve(
  process.env.PASEO_TEST_SERVER_DIR ||
    ".build/preview-host/node_modules/@getpaseo/server",
);
const base = pathToFileURL(
  join(host, "dist/server/server/plugins/compiler.js"),
);
const { compilePlugin } = await import(base.href);
const { evaluateBundle } = await import(
  new URL("./bundle-evaluator.js", base).href
);
const { publishAgentStream } = await import(
  new URL("./lifecycle/index.js", base).href
);
const { PluginSettingsStore } = await import(
  new URL("./settings/index.js", base).href
);
const { InMemoryAgentTimelineStore } = await import(
  new URL("../agent/agent-timeline-store.js", base).href
);
const version = JSON.parse(
  await readFile(join(host, "package.json"), "utf8"),
).version;
const directory = await mkdtemp(join(tmpdir(), "paseo-preview-smoke-"));
const previousHome = process.env.PASEO_HOME;
const previousState = process.env.PASEO_NOTIFIER_STATE_DIR;
process.env.PASEO_HOME = directory;
process.env.PASEO_NOTIFIER_STATE_DIR = join(directory, "state");
let cleanup;
try {
  const compiled = await compilePlugin({
    client: resolve("index.client.tsx"),
    server: resolve("index.server.ts"),
  });
  const contribute = evaluateBundle(compiled.serverBundle);
  await mkdir(join(directory, "settings"));
  await writeFile(
    join(directory, "settings/notifier.json"),
    JSON.stringify({
      version: 1,
      values: {
        notifications: { includePreview: true },
        channels: [
          { id: "test", name: "Test", kind: "webhook", enabled: true },
        ],
        routing: { host: ["test"] },
      },
    }),
  );
  const settings = new PluginSettingsStore(
    join(directory, "settings"),
    () => {},
  );
  const hooks = new Map(),
    methods = new Map();
  let registered;
  cleanup = contribute({
    registerSettings(definition) {
      registered = settings.register(definition);
      return registered.settings;
    },
    handle(contract, handler) {
      methods.set(contract.name, handler);
    },
    on(name, handler) {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
    before() {
      return () => {};
    },
  });
  const timeline = new InMemoryAgentTimelineStore();
  const agent = {
    id: "a",
    workspaceId: "w",
    parentAgentId: null,
    provider: "codex",
    cwd: directory,
    title: "Preview smoke",
  };
  timeline.initialize(agent.id);
  const append = (turnId, type, text) =>
    timeline.append(agent.id, { type, text }, { turnId });
  append("previous", "user_message", "previous task");
  append("previous", "assistant_message", "NEVER USE PREVIOUS REPLY");
  append("target", "user_message", "target task");
  append("target", "assistant_message", "本轮最终回复：");
  append("target", "assistant_message", "PROJ-123");
  append("future", "user_message", "future task");
  append("future", "assistant_message", "NEVER USE NEXT REPLY");
  let reads = 0;
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => ({
          name: "Workspace",
          projectDisplayName: "Project",
        }),
      }),
    },
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            title: agent.title,
            status: "idle",
            pendingPermissions: [],
            activeTurn: null,
          },
        }),
        timeline: {
          refetch: async (options) => {
            reads++;
            assert.equal(options.projection, "projected");
            assert.equal(options.limit, 100);
            const result = timeline.fetch(agent.id, options);
            return {
              ...result,
              agentId: agent.id,
              error: null,
              entries: result.rows,
              startCursor:
                result.startSeq === null
                  ? null
                  : { epoch: result.epoch, seq: result.startSeq },
            };
          },
        },
      }),
    },
  };
  const status = await methods.get("notifier.status")({}, { paseo });
  assert.equal(status.storageError, null);
  const captured = [];
  const complete = async (turnId, items) => {
    publishAgentStream(
      {
        emit(name, event) {
          if (name === "agent.turn_ended") captured.push(event);
        },
      },
      agent,
      { type: "turn_completed", turnId },
      items,
    );
    const event = captured.at(-1);
    assert.equal(event.turnId, turnId);
    await hooks.get("agent.turn_ended")(event, { paseo });
    return event;
  };
  const ending = await complete("target", [
    { type: "user_message", text: "target task" },
    { type: "assistant_message", text: "本轮最终回复：PROJ-123" },
  ]);
  const readOperations = async () =>
    JSON.parse(
      await readFile(join(directory, "state/operations.json"), "utf8"),
    );
  let notices = (await readOperations()).deliveries.map((d) => d.notice);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].preview, "本轮最终回复：PROJ-123");
  assert.equal(
    reads,
    ending.timeline.length ? 0 : 1,
    "Only missing callback text needs a history query",
  );
  await hooks.get("agent.turn_ended")(ending, { paseo });
  assert.equal(
    (await readOperations()).deliveries.length,
    1,
    "Repeated end events must not duplicate notifications",
  );
  await complete("no-reply", [
    { type: "user_message", text: "task without reply" },
  ]);
  notices = (await readOperations()).deliveries.map((d) => d.notice);
  assert.equal(notices.length, 2);
  assert.equal(
    notices[1].preview,
    undefined,
    "Never borrow an earlier or later turn's reply",
  );
  const current = await registered.read.handle();
  const saved = await registered.write.handle({
    revision: current.revision,
    values: {
      ...current.values,
      notifications: { ...current.values.notifications, includePreview: false },
    },
  });
  assert.equal(saved.status, "saved");
  const before = reads;
  await complete("privacy-off", []);
  assert.equal(
    reads,
    before,
    "Privacy switch must prevent additional history reads",
  );
  assert.ok(
    (await readOperations()).deliveries.every(
      (d) => d.notice.preview === undefined,
    ),
  );
  console.log(
    `Paseo ${version}: real turn-ended publisher (${ending.timeline.length ? "populated" : "empty"} timeline), projected reply, turn isolation, deduplication and privacy switch verified.`,
  );
} finally {
  await cleanup?.();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  if (previousState === undefined) delete process.env.PASEO_NOTIFIER_STATE_DIR;
  else process.env.PASEO_NOTIFIER_STATE_DIR = previousState;
  await rm(directory, { recursive: true, force: true });
}
