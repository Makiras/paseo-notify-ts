// Exercise the real OpenCode loader and retry loop with loopback-only fixtures.
// A clean environment isolates credentials, config, DB, goals and the shared service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "paseo-cyber-smoke-"));
const binary = process.env.OPENCODE_BIN || "opencode";
const goalPackage = process.env.OPENCODE_GOAL_PACKAGE;
let goalRuntime;
if (goalPackage) {
  // Explicit native entrypoint, including packages whose local-directory entry is V1.
  const path = resolve(goalPackage);
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  const entry =
    pkg.name === "@prevalentware/opencode-goal-plugin"
      ? join(path, "dist/server.js")
      : join(path, "server.js");
  goalRuntime = join(root, "goal-runtime");
  await mkdir(goalRuntime);
  await writeFile(
    join(goalRuntime, "package.json"),
    JSON.stringify({
      name: "fixture-goal-runtime",
      type: "module",
      exports: { ".": "./server.js", "./server": "./server.js" },
    }),
  );
  await writeFile(
    join(goalRuntime, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\n`,
  );
}
const fixtureMessage =
  "This content was flagged for possible cybersecurity risk.";
let scenario = "";
let requests = 0;
const model = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    if (requests === 1 && ["503", "429"].includes(scenario)) {
      res.writeHead(Number(scenario), { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              scenario === "503"
                ? "Service unavailable"
                : "Rate limit exceeded",
          },
        }),
      );
      return;
    }
    const response = {
      id: `resp_${requests}`,
      object: "response",
      created_at: 1,
      model: "fixture",
      status: "in_progress",
      output: [],
    };
    const events = [{ type: "response.created", response }];
    if (requests === 1 && scenario === "cyber-goal") {
      const tool = body.tools.find(
        (tool) =>
          tool.name === "create_goal" || tool.name?.endsWith("_create_goal"),
      );
      assert(tool, "Goal tool must be registered");
      const item = {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: tool.name,
        arguments: JSON.stringify({
          objective: "Local cyber refusal fixture",
          max_auto_turns: 3,
        }),
        status: "completed",
      };
      events.push(
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            ...response,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          },
        },
      );
    } else if (
      (requests === 1 || (scenario === "cyber-goal" && requests === 2)) &&
      scenario.startsWith("cyber")
    ) {
      if (scenario === "cyber-partial") {
        const item = {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        };
        events.push(
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: "Fixture partial output.",
          },
        );
      }
      events.push({
        type: "response.failed",
        response: {
          ...response,
          status: "failed",
          error: {
            type: "invalid_request",
            code: "cyber_policy",
            message: fixtureMessage,
          },
        },
      });
    } else if (requests === 1 && scenario === "unknown") {
      events.push({
        type: "response.failed",
        response: {
          ...response,
          status: "failed",
          error: {
            code: "fixture_unknown",
            message: "Unknown upstream failure",
          },
        },
      });
    } else {
      const item = {
        id: `msg_${requests}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Fixture complete.", annotations: [] },
        ],
      };
      events.push(
        { type: "response.output_item.added", output_index: 0, item },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "Fixture complete.",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            ...response,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
          },
        },
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      events
        .map(
          (event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
        )
        .join(""),
    );
  } catch (error) {
    res.destroy(error);
  }
});
await new Promise((done) => model.listen(0, "127.0.0.1", done));
let passed = false;
try {
  for (const guarded of [false, true]) {
    const dir = join(root, guarded ? "guarded" : "baseline");
    const project = join(dir, "project");
    const config = join(dir, "config/opencode");
    await mkdir(project, { recursive: true });
    await mkdir(join(config, "plugins"), { recursive: true });
    if (guarded)
      await copyFile(
        resolve("server/opencode/cyber-retry-guard.ts"),
        join(config, "plugins/cyber-retry-guard.ts"),
      );
    await writeFile(
      join(config, "opencode.json"),
      JSON.stringify({
        model: "fixture/fixture",
        snapshots: false,
        ...(guarded && goalRuntime ? { plugins: [goalRuntime] } : {}),
        providers: {
          fixture: {
            env: ["FIXTURE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible/responses",
            settings: {
              baseURL: `http://127.0.0.1:${model.address().port}/v1`,
            },
            models: {
              fixture: {
                name: "Fixture",
                limit: { context: 100000, output: 1000 },
              },
            },
          },
        },
      }),
    );
    const password = "isolated-fixture";
    const child = spawn(
      binary,
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: project,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: join(dir, "home"),
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_DATA_HOME: join(dir, "data"),
          XDG_STATE_HOME: join(dir, "state"),
          XDG_CACHE_HOME: join(dir, "cache"),
          OPENCODE_DB: join(dir, "opencode.db"),
          OPENCODE_PASSWORD: password,
          FIXTURE_API_KEY: "fixture-only",
          OPENCODE_GOAL_STATE_PATH: join(dir, "goals.json"),
        },
      },
    );
    let output = "",
      launchError;
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", (error) => {
      launchError = error;
    });
    const exited = new Promise((done) => {
      child.once("exit", done);
      child.once("error", done);
    });
    const waitFor = async (check, label) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null)
          throw new Error(`OpenCode exited: ${output.slice(-2000)}`);
        if (await check()) return;
        await sleep(50);
      }
      throw new Error(
        `Timeout: ${label}; requests=${requests}; diagnostics=${dir}`,
      );
    };
    try {
      await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "startup");
      const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
      const api = async (path, body) => {
        const response = await fetch(base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        assert(
          response.ok,
          `${path}: ${response.status} ${await response.clone().text()}`,
        );
        const text = await response.text();
        return text ? JSON.parse(text) : undefined;
      };
      for (const name of guarded
        ? [
            "cyber",
            "cyber-partial",
            "503",
            "429",
            "unknown",
            ...(goalPackage ? ["cyber-goal"] : []),
          ]
        : ["cyber"]) {
        scenario = name;
        requests = 0;
        const session = (
          await api("/api/session", {
            location: { directory: project },
            title: "Retry fixture",
            agent: "build",
            model: { providerID: "fixture", id: "fixture" },
          })
        ).data;
        if (guarded) {
          await waitFor(async () => {
            const plugins = (
              await api(
                `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`,
              )
            ).data;
            const plugin = plugins.find(
              (p) => p.id === "paseo-notify.cyber-retry-guard",
            );
            if (plugin?.state?.status === "error")
              throw new Error(JSON.stringify(plugin.state));
            return plugin?.state?.status === "active";
          }, "guard active");
        }
        if (name === "cyber-goal")
          await api(`/api/session/${session.id}/command`, {
            name: "goal",
            text: "Create a goal for the local cyber refusal fixture; leave it active.",
          });
        else
          await api(`/api/session/${session.id}/prompt`, {
            text: "Run the local retry fixture.",
          });
        let outcome;
        await waitFor(async () => {
          const current = (await api(`/api/session/${session.id}`)).data;
          outcome = current.outcome;
          const active = (await api("/api/session/active")).data;
          return requests > 0 && !(session.id in active) && !!outcome;
        }, name);
        const blocked = guarded && name.startsWith("cyber");
        if (name === "cyber-goal") {
          const goals = JSON.parse(
            await readFile(join(dir, "goals.json"), "utf8"),
          );
          assert.equal(
            goals.goals[session.id]?.status,
            "active",
            "Fixture must have an active goal",
          );
          // Goal defaults to a 3s interval. Observe beyond two intervals after failure.
          await sleep(6500);
          assert.equal(
            requests,
            2,
            "Goal must not revive the refused execution",
          );
        }
        // A newer upstream may already recognize cyber; don't require its bug to persist.
        if (!guarded) {
          assert(
            [1, 2].includes(requests),
            "baseline: unexpected model request count",
          );
          assert.equal(outcome, requests === 1 ? "failed" : "succeeded");
        } else {
          assert.equal(
            requests,
            blocked && name !== "cyber-goal" ? 1 : 2,
            `${name}: unexpected model request count`,
          );
          assert.equal(
            outcome,
            blocked ? "failed" : "succeeded",
            `${name}: unexpected outcome`,
          );
        }
        console.log(
          `PASS ${guarded ? "guard" : "baseline"} ${name}: ${requests} request(s), ${outcome}`,
        );
      }
    } finally {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(force);
      await writeFile(join(dir, "server.log"), output);
    }
  }
  passed = true;
} finally {
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`Diagnostics: ${root}`);
}
