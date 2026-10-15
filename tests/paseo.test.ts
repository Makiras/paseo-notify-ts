import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { paseoPort } from "../server/paseo";

function adapter(
  snapshot: Record<string, unknown> | null = {
    status: "error",
    pendingPermissions: [],
    activeTurn: null,
  },
) {
  const refetch = vi.fn(async () => ({
    entries: [{ item: { type: "assistant_message", text: "Interrupted" } }],
    epoch: "e1",
    hasOlder: true,
  }));
  const refresh = vi.fn(async () => (snapshot ? { agent: snapshot } : null));
  const send = vi.fn(async () => {});
  const paseo = {
    agents: { ref: () => ({ timeline: { refetch }, refresh, send }) },
  } as unknown as PaseoApi;
  return { port: paseoPort(paseo), refetch, refresh, send };
}

describe("Paseo adapter", () => {
  it("checks a failed long session without fetching any history or user boundary", async () => {
    const s = adapter();
    s.refetch.mockRejectedValue(new Error("history unavailable"));
    expect(await s.port.inspect("a")).toEqual({
      available: true,
      idle: true,
      status: "error",
      pendingPermissions: 0,
      error: null,
    });
    expect(s.refetch).not.toHaveBeenCalled();
  });
  it("reads only one bounded tail page for review, even without a user message", async () => {
    const s = adapter();
    expect(await s.port.history!("a")).toHaveLength(1);
    expect(s.refetch).toHaveBeenCalledExactlyOnceWith({
      direction: "tail",
      limit: 100,
      projection: "projected",
    });
    expect(s.refresh).not.toHaveBeenCalled();
  });
  it.each([
    { status: "running", activeTurn: null, pendingPermissions: [] },
    { status: "error", activeTurn: { turnId: "live" }, pendingPermissions: [] },
    { status: "error", pendingPermissions: [{ id: "permission" }] },
  ])("does not treat an occupied session as idle: %j", async (snapshot) => {
    expect((await adapter(snapshot).port.inspect("a")).idle).toBe(false);
  });
  it.each([
    { status: "closed", pendingPermissions: [] },
    { status: "error", archivedAt: "now", pendingPermissions: [] },
    { status: "error", providerUnavailable: true, pendingPermissions: [] },
  ])(
    "reports unavailable sessions without consulting history: %j",
    async (snapshot) => {
      expect((await adapter(snapshot).port.inspect("a")).available).toBe(false);
    },
  );
  it("keeps a failed snapshot request unknown rather than inventing an idle state", async () => {
    await expect(adapter(null).port.inspect("a")).rejects.toThrow(
      "暂时无法读取会话状态",
    );
    const s = adapter();
    s.refresh.mockRejectedValue(new Error("offline"));
    await expect(s.port.inspect("a")).rejects.toThrow("offline");
  });
  it("passes message identity and explicitly avoids the SDK's interrupt default", async () => {
    const s = adapter();
    await s.port.send("a", "continue", "stable-id");
    expect(s.send).toHaveBeenCalledWith("continue", {
      messageId: "stable-id",
      activeTurnBehavior: "steer",
    });
  });
});
