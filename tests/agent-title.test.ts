import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationTitle } from "../server/agent-title";
import { agent } from "./fixtures";

afterEach(() => vi.useRealTimers());
describe("notification session titles", () => {
  it("uses a supplied readable title without another host request", async () => {
    const lookup = vi.fn();
    expect(await notificationTitle(agent, lookup)).toBe(agent.title);
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each([null, "", "  ", agent.id])(
    "refreshes an absent or ID-only title: %s",
    async (title) => {
      const lookup = vi.fn(async () => "LSQ 验证");
      expect(await notificationTitle({ ...agent, title }, lookup)).toBe(
        "LSQ 验证",
      );
      expect(lookup).toHaveBeenCalledExactlyOnceWith(agent.id);
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
