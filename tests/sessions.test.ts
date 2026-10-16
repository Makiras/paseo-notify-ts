import { describe, expect, it, vi } from "vitest";
import { Sessions } from "../server/sessions";
import { deleteSessionRpc, prepareDeleteSessionsRpc } from "../shared/sessions";
import type { PaseoApi } from "../server/types";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixture() {
  let now = 1;
  let agent: Record<string, unknown> | null = {
    id,
    title: "归档测试",
    provider: "codex",
    cwd: "/test",
    workspaceId: "w",
    status: "closed",
    archivedAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
    persistence: { secret: "private" },
  };
  const refresh = vi.fn(async () => (agent ? { agent } : null));
  const list = vi.fn(async () => ({
    entries: [{ agent }],
    pageInfo: { hasMore: true, nextCursor: "next" },
  }));
  const paseo = {
    agents: { ref: () => ({ refresh }), list },
  } as unknown as PaseoApi;
  const deps = {
    readSessions: vi.fn(async () => ({
      sessions: agent
        ? [
            {
              id,
              title: "归档测试",
              provider: "codex",
              cwd: "/test",
              workspaceId: "w",
              status: "closed",
              archivedAt: "2026-10-15T00:00:00Z",
              updatedAt: "2026-10-16T00:00:00.000Z",
            },
          ]
        : [],
      unreadable: 0,
    })),
    now: () => now,
    findCli: vi.fn(async (): Promise<string | null> => "/usr/bin/paseo"),
    cli: vi.fn(async (_cli: string, _args: string[]): Promise<unknown> => {
      agent = null;
      return { deletedCount: 1, agentIds: [id] };
    }),
  };
  const service = new Sessions("/tmp/isolated home", deps),
    before = vi.fn(async () => {});
  return {
    service,
    paseo,
    deps,
    before,
    refresh,
    list,
    setAgent: (next: typeof agent) => {
      agent = next;
    },
    expire: () => {
      now += 300001;
    },
  };
}
describe("confirmed session deletion", () => {
  it("lists host metadata including unavailable providers without requesting provider history", async () => {
    const f = fixture();
    const result = await f.service.list(f.paseo);
    expect(result.sessions[0]?.id).toBe(id);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(f.deps.readSessions).toHaveBeenCalledWith("/tmp/isolated home");
    expect(f.list).not.toHaveBeenCalled();
  });
  it("paginates tied timestamps without dropping or repeating IDs and rejects invalid cursors", async () => {
    const f = fixture();
    const base = (await f.deps.readSessions()).sessions[0]!;
    const sessions = Array.from({ length: 101 }, (_, i) => ({
      ...base,
      id: `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    }));
    f.deps.readSessions.mockResolvedValue({ sessions, unreadable: 1 });
    const first = await f.service.list(f.paseo);
    const second = await f.service.list(f.paseo, first.nextCursor!);
    expect(first.sessions).toHaveLength(100);
    expect(second.sessions).toHaveLength(1);
    expect(
      new Set([...first.sessions, ...second.sessions].map((s) => s.id)).size,
    ).toBe(101);
    expect(first.unreadable).toBe(1);
    expect(second.nextCursor).toBeNull();
    await expect(f.service.list(f.paseo, "bad")).rejects.toThrow("刷新");
  });
  it("does not delete until confirmed, pins full ID and home, cancels recovery before CLI, then verifies absence", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id, id], true);
    expect(plan.sessions).toHaveLength(1);
    expect(f.deps.cli).not.toHaveBeenCalled();
    expect(await f.service.remove(f.paseo, plan.token, id, f.before)).toEqual({
      ok: true,
      message: "会话已删除",
    });
    expect(f.deps.cli).toHaveBeenCalledWith("/usr/bin/paseo", [
      "agent",
      "delete",
      id,
      "--home",
      "/tmp/isolated home",
      "--json",
    ]);
    expect(f.before.mock.invocationCallOrder[0]).toBeLessThan(
      f.deps.cli.mock.invocationCallOrder[0]!,
    );
    expect(f.refresh).toHaveBeenCalledTimes(3);
  });
  it("rejects changed IDs, expired confirmations and replays", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id], true);
    await expect(
      f.service.remove(f.paseo, plan.token, other, f.before),
    ).rejects.toThrow("确认");
    f.expire();
    await expect(
      f.service.remove(f.paseo, plan.token, id, f.before),
    ).rejects.toThrow("确认");
    const fresh = await f.service.prepare(f.paseo, [id], true);
    await f.service.remove(f.paseo, fresh.token, id, f.before);
    await expect(
      f.service.remove(f.paseo, fresh.token, id, f.before),
    ).rejects.toThrow("确认");
    expect(f.deps.cli).toHaveBeenCalledOnce();
  });
  it("skips a formerly archived session that was restored after confirmation", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id], true);
    f.setAgent({ id, archivedAt: null });
    expect(
      await f.service.remove(f.paseo, plan.token, id, f.before),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("取消归档"),
    });
    expect(f.before).not.toHaveBeenCalled();
    expect(f.deps.cli).not.toHaveBeenCalled();
  });
  it("does not delete when state lookup fails", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id], false);
    f.refresh.mockRejectedValueOnce(new Error("读取失败"));
    expect(
      await f.service.remove(f.paseo, plan.token, id, f.before),
    ).toMatchObject({ ok: false });
    expect(f.deps.cli).not.toHaveBeenCalled();
  });
  it("does not report success for an acknowledgement with a still-existing record", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id], false);
    f.deps.cli.mockResolvedValueOnce({ deletedCount: 1, agentIds: [id] });
    expect(
      await f.service.remove(f.paseo, plan.token, id, f.before),
    ).toMatchObject({ ok: false, message: expect.stringContaining("仍存在") });
  });
  it("handles missing records without issuing a delete command", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id], false);
    f.setAgent(null);
    expect(
      await f.service.remove(f.paseo, plan.token, id, f.before),
    ).toMatchObject({ ok: true });
    expect(f.deps.cli).not.toHaveBeenCalled();
  });
  it("does not replay uncertain CLI failures or expose command output", async () => {
    const f = fixture();
    const plan = await f.service.prepare(f.paseo, [id], false);
    f.deps.cli.mockRejectedValueOnce(
      Object.assign(new Error("private output"), { stdout: "secret" }),
    );
    const result = await f.service.remove(f.paseo, plan.token, id, f.before);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("无法确认"),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    await expect(
      f.service.remove(f.paseo, plan.token, id, f.before),
    ).rejects.toThrow();
    expect(f.deps.cli).toHaveBeenCalledOnce();
  });
  it("rejects prefixes and bulk flags at the RPC boundary", () => {
    for (const value of ["aaaa", "--all", "/tmp", "x;rm -rf x"]) {
      expect(
        prepareDeleteSessionsRpc.input.safeParse({ ids: [value] }).success,
      ).toBe(false);
      expect(
        deleteSessionRpc.input.safeParse({ id: value, token: id }).success,
      ).toBe(false);
    }
    expect(prepareDeleteSessionsRpc.input.safeParse({ ids: [] }).success).toBe(
      false,
    );
    expect(
      prepareDeleteSessionsRpc.input.safeParse({ ids: Array(21).fill(id) })
        .success,
    ).toBe(false);
  });
  it("offers read-only listing when no CLI is available", async () => {
    const f = fixture();
    f.deps.findCli.mockResolvedValue(null);
    expect((await f.service.list(f.paseo)).canDelete).toBe(false);
    await expect(f.service.prepare(f.paseo, [id], true)).rejects.toThrow("CLI");
    expect(f.deps.cli).not.toHaveBeenCalled();
  });
});
