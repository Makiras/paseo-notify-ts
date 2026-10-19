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
  const workspaceRefresh = vi.fn(
    async (): Promise<{
      name: string;
      projectId?: string;
      projectDisplayName?: string;
      projectCustomName?: string | null;
    } | null> => null,
  );
  const workspaceRef = vi.fn((_id: string) => ({ refresh: workspaceRefresh }));
  const paseo = {
    agents: { ref: () => ({ timeline: { refetch }, refresh, send }) },
    workspaces: { ref: workspaceRef },
  } as unknown as PaseoApi;
  return {
    port: paseoPort(paseo),
    refetch,
    refresh,
    send,
    workspaceRefresh,
    workspaceRef,
  };
}

describe("Paseo adapter", () => {
  it("reads a renamed project independently from the workspace and chat title", async () => {
    const s = adapter({ title: "排查加载队列" });
    s.workspaceRefresh.mockResolvedValue({
      name: "LSQ验证",
      projectId: "project-a",
      projectDisplayName: "旧项目名",
      projectCustomName: "香山验证",
    });
    expect(await s.port.names!("agent-a", "workspace-a")).toEqual({
      projectName: "香山验证",
      workspaceName: "LSQ验证",
      sessionTitle: "排查加载队列",
    });
    s.workspaceRefresh.mockResolvedValue({
      name: "LSQ验证",
      projectId: "project-a",
      projectDisplayName: "project-a",
    });
    s.refresh.mockRejectedValue(new Error("agent deleted"));
    expect(await s.port.names!("agent-a", "workspace-a")).toEqual({
      projectName: undefined,
      workspaceName: "LSQ验证",
      sessionTitle: undefined,
    });
  });

  it("uses the renamed workspace's display name and refreshes it for later notifications", async () => {
    const s = adapter({
      title: "这个仓库是验证 Xiangshan，Kunminghu-v3 的仓库。",
      status: "idle",
      pendingPermissions: [],
    });
    s.workspaceRefresh.mockResolvedValue({ name: "bpu-verify-kunminghu-v3" });
    expect(await s.port.names!("agent-a", "workspace-a")).toMatchObject({
      workspaceName: "bpu-verify-kunminghu-v3",
      sessionTitle: "这个仓库是验证 Xiangshan，Kunminghu-v3 的仓库。",
    });
    expect(s.workspaceRef).toHaveBeenCalledWith("workspace-a");
    s.workspaceRefresh.mockResolvedValue({ name: "BPU验证" });
    expect(await s.port.names!("agent-a", "workspace-a")).toMatchObject({
      workspaceName: "BPU验证",
    });
    expect(s.refresh).toHaveBeenCalledTimes(2);
    expect(s.refetch).not.toHaveBeenCalled();
  });
  it("keeps workspaces sharing a directory separate by their IDs", async () => {
    const s = adapter();
    s.workspaceRef.mockImplementation((id) => ({
      refresh: vi.fn(async () => ({
        name: id === "lsq" ? "LSQ验证" : "ICache验证",
      })),
    }));
    expect(await s.port.names!("agent-a", "lsq")).toMatchObject({
      workspaceName: "LSQ验证",
    });
    expect(await s.port.names!("agent-b", "icache")).toMatchObject({
      workspaceName: "ICache验证",
    });
  });
  it("falls back to the chat title when workspace metadata cannot be read", async () => {
    const s = adapter({
      title: "会话名称",
      status: "idle",
      pendingPermissions: [],
    });
    s.workspaceRefresh.mockRejectedValue(new Error("workspace unavailable"));
    expect(await s.port.names!("a", "workspace-a")).toMatchObject({
      sessionTitle: "会话名称",
      workspaceName: undefined,
    });
  });
  it("reads a missing event title from current agent metadata, without history", async () => {
    const s = adapter({
      title: "LSQ 验证",
      status: "error",
      pendingPermissions: [],
    });
    expect(await s.port.names!("a", null)).toMatchObject({
      sessionTitle: "LSQ 验证",
    });
    expect(s.refresh).toHaveBeenCalledOnce();
    expect(s.refetch).not.toHaveBeenCalled();
  });
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
