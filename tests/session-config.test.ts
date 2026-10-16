import { describe, it, expect, vi } from "vitest";
import { defaultConfig } from "../shared/config";
import { prepareSessionConfigCleanup } from "../server/session-config";
import type { PaseoApi } from "../server/types";

describe("confirmed missing session configuration cleanup", () => {
  it("removes only requested session bindings and returns the latest revision without mutating storage", async () => {
    const config = defaultConfig();
    config.routing.sessions = { deleted: [], kept: [] };
    config.recoveryOverrides.sessions = {
      deleted: config.recovery,
      kept: config.recovery,
    };
    config.recoveryOverrides.workspaces.w = config.recovery;
    config.routing.schedules.task = [];
    const refresh = vi.fn(async () => null);
    const paseo = {
      agents: { ref: () => ({ refresh }) },
    } as unknown as PaseoApi;
    const read = vi.fn(async () => ({
      status: "ready",
      revision: "latest",
      values: config,
    }));
    const result = await prepareSessionConfigCleanup(paseo, ["deleted"], read);
    expect(result.revision).toBe("latest");
    expect(result.changed).toBe(true);
    expect(result.config.routing.sessions).toEqual({ kept: [] });
    expect(result.config.recoveryOverrides.sessions).toEqual({
      kept: config.recovery,
    });
    expect(result.config.recoveryOverrides.workspaces).toEqual(
      config.recoveryOverrides.workspaces,
    );
    expect(result.config.routing.schedules).toEqual(config.routing.schedules);
    expect(config.routing.sessions.deleted).toEqual([]);
    expect(read.mock.invocationCallOrder[0]).toBeGreaterThan(
      refresh.mock.invocationCallOrder[0]!,
    );
  });
  it("preserves bindings for existing or unreadable sessions, including archived sessions", async () => {
    const refresh = vi.fn(
      async (): Promise<unknown> => ({ agent: { archivedAt: "today" } }),
    );
    const paseo = {
      agents: { ref: () => ({ refresh }) },
    } as unknown as PaseoApi;
    const read = vi.fn(async () => ({
      status: "ready",
      revision: "r",
      values: defaultConfig(),
    }));
    await expect(
      prepareSessionConfigCleanup(paseo, ["s"], read),
    ).rejects.toThrow("仍存在");
    refresh.mockRejectedValue(new Error("offline"));
    await expect(
      prepareSessionConfigCleanup(paseo, ["s"], read),
    ).rejects.toThrow("offline");
    expect(read).not.toHaveBeenCalled();
  });
});
