import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationNames } from "../server/agent-title";
import { agent } from "./fixtures";

afterEach(() => vi.useRealTimers());
describe("notification session titles", () => {
  it("prefers the current sidebar name over an existing auto-generated chat title", async () => {
    const lookup = vi.fn(async () => ({
      workspaceName: "LSQ验证",
      sessionTitle: "聊天标题",
    }));
    expect(await notificationNames(agent, lookup)).toMatchObject({
      title: "LSQ验证",
      workspaceName: "LSQ验证",
      sessionTitle: "聊天标题",
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(agent.id, agent.workspaceId);
  });
  it("uses the supplied chat title when the host lookup fails", async () => {
    expect(
      await notificationNames(agent, async () => {
        throw new Error("offline");
      }),
    ).toMatchObject({
      title: agent.title,
      sessionTitle: agent.title,
      workspaceName: undefined,
    });
  });
  it.each([null, "", "  ", agent.id])(
    "refreshes an absent or ID-only title: %s",
    async (title) => {
      const lookup = vi.fn(async () => ({ workspaceName: "LSQ 验证" }));
      expect(
        await notificationNames({ ...agent, title }, lookup),
      ).toMatchObject({ title: "LSQ 验证" });
      expect(lookup).toHaveBeenCalledExactlyOnceWith(
        agent.id,
        agent.workspaceId,
      );
    },
  );
  it("falls back to a readable workspace name on missing metadata or request failure", async () => {
    const unnamed = { ...agent, title: null };
    for (const lookup of [
      undefined,
      async () => ({}),
      async () => ({ workspaceName: agent.id }),
      async () => {
        throw new Error("offline");
      },
    ]) {
      expect(await notificationNames(unnamed, lookup)).toMatchObject({
        title: "未命名会话 · project",
        workspaceName: undefined,
        sessionTitle: undefined,
      });
    }
  });
  it("bounds lookup time and ignores a late lookup failure", async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const title = notificationNames(
      { ...agent, title: null },
      () =>
        new Promise((_resolve, failure) => {
          reject = failure;
        }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await title).toMatchObject({
      title: "未命名会话 · project",
      workspaceName: undefined,
    });
    reject(new Error("late failure"));
    await Promise.resolve();
  });
});
