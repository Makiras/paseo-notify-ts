import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, transform } from "esbuild";
import { transformAsync } from "@babel/core";
import transformClasses from "@babel/plugin-transform-classes";
import { compilePlugin } from "../node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js";

await mkdir(".build", { recursive: true });
const { clientBundle } = await compilePlugin({
  client: resolve("index.client.tsx"),
});
const fixture = resolve(".build/hermes-fixture");
await mkdir(fixture, { recursive: true });
await cp("shared", resolve(fixture, "shared"), { recursive: true });
await writeFile(
  resolve(fixture, "index.client.ts"),
  `
  import { renderFeishuCard } from "./shared/feishu";
  import { renderNotification } from "./shared/templates";
  import { messageTemplateSchema, extractionExamples } from "./shared/template-schema";
  import { configSchema } from "./shared/config";
  export default function inspect() {
    return { renderFeishuCard, renderNotification, messageTemplateSchema, extractionExamples, configSchema };
  }
`,
);
// Use Paseo's compiler for this helper entry too, including its Hermes interop
// transforms. A raw esbuild CommonJS wrapper is not equivalent to the host.
const { clientBundle: templateBundle } = await compilePlugin({
  client: resolve(fixture, "index.client.ts"),
});
const harness = await build({
  stdin: {
    contents: `
      import * as zod from "zod";
      import React from "react";
      import jsx from "react/jsx-runtime";
      import { defineRpc, defineSettings } from "@getpaseo/plugin";
      function check(value, message) { if (!value) throw new Error(message); }
      const modules = {
        zod, react: React, "react/jsx-runtime": jsx,
        "@getpaseo/plugin": { defineRpc, defineSettings },
        "@getpaseo/plugin/client": {},
        "@getpaseo/plugin/client/ui": {},
        "@getpaseo/plugin/client/react-native": {},
        "react-native": {}, "@tanstack/react-query": {},
      };
      const requireHost = (name) => {
        check(Object.prototype.hasOwnProperty.call(modules, name), "Unexpected host import: " + name);
        return modules[name];
      };
      // Critical: eval the untouched host-produced plugin, exactly as Paseo does.
      // Running a precompiled Hermes bytecode file alone misses the regression.
      const evaluate = globalThis.eval;
      const entry = evaluate(${JSON.stringify(clientBundle)})(requireHost);
      check(typeof entry.default === "function", "Client entry did not load");
      const registrations = [];
      const register = (value) => { registrations.push(value); return () => {}; };
      // React Native supplies AbortController. No real agent or network is used.
      globalThis.AbortController = function() {
        this.signal = { aborted: false };
        this.abort = () => { this.signal.aborted = true; };
      };
      const cleanup = entry.default({
        addSettingsScreen: register, addTimelineRenderer: register,
        addCommandCenterItem: register, addWorkspacePanel: register,
        paseo: { agents: { list: () => Promise.resolve({
          entries: [], pageInfo: { hasMore: false, nextCursor: null },
          subscription: { subscribe: () => () => {}, release: () => Promise.resolve() },
        }) } },
      });
      check(typeof cleanup === "function", "Client contribution failed");
      check(registrations.some(r => r.id === "settings" && typeof r.Component === "function"), "Settings screen missing");
      check(registrations.some(r => r.id === "workspace-routing"), "Workspace settings missing");
      cleanup();
      const api = evaluate(${JSON.stringify(templateBundle)})(requireHost).default();
      const config = api.configSchema.parse({});
      const notice = { id: "test", agentId: "session", kind: "completed", title: "任务", summary: "完成", preview: "工单 PROJ-123\\n结果：https://example.com/result/123", createdAt: 0, attempts: 0 };
      let result = api.renderNotification(notice, config.notifications);
      check(!result.body.includes("PROJ-123"), "Preview privacy failed");
      const rules = api.extractionExamples.map(example => example.rule);
      const template = api.messageTemplateSchema.parse({
        title: "检查 · {{title}}", body: rules.map(r => "{{custom." + r.name + "}}").join("\\n"), rules,
      });
      result = api.renderNotification(notice, { ...config.notifications, includePreview: true, template });
      check(result.title === "检查 · 任务", "Builtin placeholders failed");
      check(result.body.includes("PROJ-123"), "Ticket regex failed");
      const card = api.renderFeishuCard(notice, { ...config.notifications, includePreview: true, template });
      check(card.header.title.content === "检查 · 任务", "Card title failed");
      check(card.elements[0].text.content.includes("PROJ-123"), "Card extraction failed");
      check(!api.renderFeishuCard(notice, config.notifications).elements[0].text.content.includes("PROJ-123"), "Card privacy failed");
      const longCard = api.renderFeishuCard({ ...notice, summary: "中文🌍".repeat(8000) }, { ...config.notifications, template: { ...template, body: "{{summary}}" } });
      check(longCard.elements[0].text.content.endsWith("…"), "Card truncation failed");

      check(result.body.includes("https://example.com/result/123"), "URL regex failed");
      for (const [pattern, flags, text, expected] of [
        ["([A-Z]+-[0-9]+)", "i", "proj-42", "proj-42"],
        ["(\\\\p{Han}+)", "", "hello 中文", "中文"],
        ["^(second)$", "m", "first\\nsecond", "second"],
        ["(a.b)", "s", "a\\nb", "a\\nb"],
      ]) {
        const value = api.messageTemplateSchema.parse({
          title: "{{title}}", body: "{{custom.value}}",
          rules: [{ name: "value", source: "preview", pattern, flags, group: 1, fallback: "none" }],
        });
        const rendered = api.renderNotification({ ...notice, preview: text }, { ...config.notifications, includePreview: true, template: value });
        check(rendered.body === expected, "Regex failed: " + pattern + " -> " + rendered.body);
      }
      check(!api.messageTemplateSchema.safeParse({ ...template, rules: [{ ...rules[0], pattern: "(" }] }).success, "Invalid regex accepted");
      print("Hermes: official client bundle dynamically loaded, settings registered, defaults parsed, template/card extraction, truncation and privacy passed.");
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "neutral",
  format: "iife",
  target: "es2020",
  define: { "process.env.NODE_ENV": '"production"' },
});
// Host-provided modules are compiled ahead of time by Metro on Android. Lower
// the harness only; the quoted plugin bundles above must remain unmodified.
const lowered = await transformAsync(harness.outputFiles[0].text, {
  babelrc: false,
  configFile: false,
  compact: false,
  plugins: [transformClasses],
});
assert.ok(lowered?.code);
const program = await transform(lowered.code, {
  target: "es2020",
  supported: { "async-await": false },
});
const script = resolve(".build/hermes-smoke.js");
await writeFile(script, program.code);
execFileSync(
  process.env.HERMES_PATH || resolve(".build/hermes/hermes"),
  ["-w", script],
  {
    stdio: "inherit",
    timeout: 30_000,
  },
);
