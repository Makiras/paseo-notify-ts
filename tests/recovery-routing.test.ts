import { describe, expect, it } from "vitest";
import { configSchema, defaultConfig, migrateSettings } from "../shared/config";
import { resolveRecovery } from "../shared/recovery";
import { portableConfig, parseTransfer } from "../shared/transfer";
import { exportConfiguration, planImport } from "../server/transfer";

describe("recovery scope inheritance", () => {
  it("migrates old settings to live Host inheritance without enabling recovery", () => {
    const old = { recovery: { enabled: false, maxAttempts: 3 } };
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const c = migrateSettings(old, version);
      expect(c.recoveryOverrides).toEqual({ workspaces: {}, sessions: {} });
      expect(
        resolveRecovery(c, { workspaceId: "w", agentId: "s" }).value
          .maxAttempts,
      ).toBe(3);
      expect(resolveRecovery(c, {}).value.enabled).toBe(false);
    }
  });
  it("resolves Session > Workspace > Host, including explicit off and restored inheritance", () => {
    const c = defaultConfig();
    c.recovery.enabled = true;
    c.recoveryOverrides.workspaces.w = { ...c.recovery, maxAttempts: 7 };
    c.recoveryOverrides.sessions.s = { ...c.recovery, enabled: false };
    expect(
      resolveRecovery(c, { workspaceId: "w", agentId: "s" }),
    ).toMatchObject({ source: "session", value: { enabled: false } });
    delete c.recoveryOverrides.sessions.s;
    expect(
      resolveRecovery(c, { workspaceId: "w", agentId: "s" }),
    ).toMatchObject({ source: "workspace", value: { maxAttempts: 7 } });
    delete c.recoveryOverrides.workspaces.w;
    c.recovery.maxAttempts = 9;
    expect(
      resolveRecovery(c, { workspaceId: "w", agentId: "s" }),
    ).toMatchObject({ source: "host", value: { maxAttempts: 9 } });
  });
  it("validates scope IDs and each complete recovery policy", () => {
    const c = defaultConfig();
    c.recoveryOverrides.sessions.s = { ...c.recovery, maxAttempts: 0 };
    expect(configSchema.safeParse(c).success).toBe(false);
    c.recoveryOverrides.sessions = JSON.parse('{"__proto__":{}}');
    expect(configSchema.safeParse(c).success).toBe(false);
  });
  it("excludes local overrides from exports and preserves the destination's overrides on import", () => {
    const c = defaultConfig();
    c.recoveryOverrides.sessions.s = { ...c.recovery, enabled: true };
    c.recoveryOverrides.workspaces.w = { ...c.recovery, maxAttempts: 8 };
    expect(portableConfig(c).recoveryOverrides).toEqual({
      workspaces: {},
      sessions: {},
    });
    const incoming = parseTransfer(exportConfiguration(c, {}, false));
    const target = defaultConfig();
    target.recoveryOverrides.sessions.local = {
      ...target.recovery,
      maxAttempts: 2,
    };
    expect(planImport(target, {}, incoming).config.recoveryOverrides).toEqual(
      target.recoveryOverrides,
    );
    incoming.config.recoveryOverrides = c.recoveryOverrides;
    expect(() => parseTransfer(JSON.stringify(incoming))).toThrow();
  });
});
