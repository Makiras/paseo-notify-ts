import { describe, expect, it } from "vitest";
import { defaultConfig } from "../shared/config";
import { parseTransfer, transferLimit } from "../shared/transfer";
import { exportConfiguration, planImport } from "../server/transfer";
import { config, memory } from "./fixtures";

describe("portable configuration transfer", () => {
  it("omits secrets, local bindings and host-specific filters by default", () => {
    const c = config();
    c.routing.workspaces.local = ["hook-a"];
    c.routing.sessions.private = [];
    c.channels[0]!.workspaceIds = ["local"];
    const text = exportConfiguration(c, memory().secrets.read(), false);
    const bundle = parseTransfer(text);
    expect(bundle.credentials).toBeUndefined();
    expect(bundle.config.routing).toEqual({
      host: ["hook-a"],
      workspaces: {},
      sessions: {},
    });
    expect(bundle.config.channels[0]!.workspaceIds).toEqual([]);
    expect(text).not.toContain("example.invalid");
    expect(text).not.toContain("secret-token");
    expect(c.routing.sessions.private).toEqual([]);
  });
  it("exports credentials only when explicitly included, excluding orphaned secrets", () => {
    const secrets = memory().secrets.read();
    secrets.orphan = { ...secrets["hook-a"]! };
    const bundle = parseTransfer(exportConfiguration(config(), secrets, true));
    expect(Object.keys(bundle.credentials!)).toEqual(["hook-a"]);
    expect(bundle.credentials!["hook-a"]!.values.bearerToken).toBe(
      "secret-token",
    );
  });
  it("preserves target bindings and remaps imported defaults around ID conflicts", () => {
    const current = config(),
      secrets = memory().secrets.read();
    current.routing.sessions.local = ["hook-a"];
    const incoming = parseTransfer(
      exportConfiguration(config(), secrets, true),
    );
    incoming.credentials!["hook-a"]!.values.url =
      "https://example.invalid/other-group";
    const result = planImport(current, secrets, incoming, () => "import-new");
    expect(result.config.routing.host).toEqual(["import-new"]);
    expect(result.config.routing.sessions.local).toEqual(["hook-a"]);
    expect(result.staged["hook-a"]).toBeUndefined();
    expect(result.staged["import-new"]!.values.url).toContain("other-group");
    expect(result.added).toBe(1);
  });
  it("reuses identical imported channels on repeated synchronization", () => {
    const bundle = parseTransfer(
      exportConfiguration(config(), memory().secrets.read(), true),
    );
    const first = planImport(defaultConfig(), {}, bundle, () => "import-new");
    const second = planImport(first.config, first.staged, bundle);
    expect(second.reused).toBe(1);
    expect(second.added).toBe(0);
    expect(second.config.channels).toHaveLength(1);
    expect(second.staged).toEqual({});
  });
  it("also reuses secret-free imports using their stable origin", () => {
    const bundle = parseTransfer(exportConfiguration(config(), {}, false));
    const first = planImport(defaultConfig(), {}, bundle, () => "import-new");
    const second = planImport(first.config, {}, bundle);
    expect(second.reused).toBe(1);
    expect(second.missingCredentials).toBe(1);
  });
  it("rejects foreign formats, local bindings, mismatched secrets and oversized input without echoing it", () => {
    expect(() => parseTransfer('{"token":"private"}')).toThrow("配置格式无效");
    expect(() => parseTransfer("x".repeat(transferLimit + 1))).toThrow("超过");
    const bundle = parseTransfer(
      exportConfiguration(config(), memory().secrets.read(), true),
    );
    bundle.config.routing.sessions.local = [];
    expect(() => parseTransfer(JSON.stringify(bundle))).toThrow("配置格式无效");
    bundle.config.routing.sessions = {};
    bundle.credentials!["hook-a"]!.kind = "telegram";
    expect(() => parseTransfer(JSON.stringify(bundle))).toThrow("配置格式无效");
  });
  it("validates transport credentials before staging or activating any channel", () => {
    const bundle = parseTransfer(
      exportConfiguration(config(), memory().secrets.read(), true),
    );
    bundle.credentials!["hook-a"]!.values.url = "file:///private";
    expect(() => planImport(defaultConfig(), {}, bundle)).toThrow("HTTP(S)");
  });
});
