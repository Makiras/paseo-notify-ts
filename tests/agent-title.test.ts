import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationTitle } from "../server/agent-title";
import { agent } from "./fixtures";

afterEach(() => vi.useRealTimers());
describe("notification session titles", () => {
  it("prefers the current sidebar name over an existing auto-generated chat title", async () => {
    const lookup = vi.fn(async () => "LSQ验证");
    expect(await notificationTitle(agent, lookup)).toBe("LSQ验证");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(agent.id, agent.workspaceId);
  });
  it("uses the supplied chat title when the host lookup fails", async () => {
    expect(
      await notificationTitle(agent, async () => {
        throw new Error("offline");
      }),
    ).toBe(agent.title);
  });
  it.each([null, "", "  ", agent.id])(
    "refreshes an absent or ID-only title: %s",
    async (title) => {
      const lookup = vi.fn(async () => "LSQ 验证");
      expect(await notificationTitle({ ...agent, title }, lookup)).toBe(
        "LSQ 验证",
      );
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
      async () => null,
      async () => agent.id,
      async () => {
        throw new Error("offline");
      },
    ]) {
      expect(await notificationTitle(unnamed, lookup)).toBe(
        "未命名会话 · project",
      );
    }
  });
  it("bounds lookup time and ignores a late lookup failure", async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const title = notificationTitle(
      { ...agent, title: null },
      () =>
        new Promise((_resolve, failure) => {
          reject = failure;
        }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await title).toBe("未命名会话 · project");
    reject(new Error("late failure"));
    await Promise.resolve();
  });
});
