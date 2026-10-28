import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/types";
import { boundedPreview, readTurnPreview } from "../server/preview";

afterEach(() => vi.useRealTimers());
const entry = (turnId: string | undefined, text: string) => ({
  turnId,
  item: { type: "assistant_message", text },
});
const page = (entries = [entry("target", "本轮回复")]) => ({
  agentId: "a",
  epoch: "epoch-a",
  entries,
  error: null,
  gap: false,
  staleCursor: false,
  reset: false,
  hasOlder: false,
  startCursor: { epoch: "epoch-a", seq: 100 },
});
function fixture() {
  const refetch = vi.fn(async () => page());
  const ref = vi.fn(() => ({ timeline: { refetch } }));
  const paseo = { agents: { ref } } as unknown as PaseoApi;
  const controller = new AbortController();
  return {
    refetch,
    ref,
    controller,
    read: (id: string = "target") =>
      readTurnPreview(paseo, "a", id, controller.signal),
  };
}

describe("per-turn notification preview", () => {
  it("selects the final reply of the requested turn despite older, newer and unidentified replies", async () => {
    const s = fixture();
    s.refetch.mockResolvedValue(
      page([
        entry("old", "previous"),
        entry("target", "progress"),
        entry("target", "本轮最终回复"),
        entry("new", "next"),
        entry(undefined, "unknown"),
      ]),
    );
    expect(await s.read()).toBe("本轮最终回复");
    expect(s.ref).toHaveBeenCalledWith("a");
    expect(s.refetch).toHaveBeenCalledExactlyOnceWith({
      direction: "tail",
      limit: 100,
      projection: "projected",
    });
  });
  it("does not substitute another turn when this turn has no reply", async () => {
    const s = fixture();
    s.refetch.mockResolvedValue(
      page([entry("old", "old reply"), entry(undefined, "unknown")]),
    );
    expect(await s.read()).toBeNull();
    expect(await s.read("")).toBeNull();
    expect(s.refetch).toHaveBeenCalledOnce();
  });
  it("looks back through at most three pages and respects timeline epoch", async () => {
    const s = fixture();
    s.refetch
      .mockResolvedValueOnce({ ...page([]), hasOlder: true })
      .mockResolvedValueOnce({
        ...page(),
        startCursor: { epoch: "epoch-a", seq: 50 },
      });
    expect(await s.read()).toBe("本轮回复");
    expect(s.refetch).toHaveBeenLastCalledWith({
      direction: "before",
      cursor: { epoch: "epoch-a", seq: 100 },
      limit: 100,
      projection: "projected",
    });
    s.refetch
      .mockReset()
      .mockResolvedValueOnce({ ...page([]), hasOlder: true })
      .mockResolvedValueOnce({ ...page(), epoch: "replacement" });
    expect(await s.read()).toBeNull();
    s.refetch
      .mockReset()
      .mockImplementation(async () => ({
        ...page([]),
        hasOlder: true,
        startCursor: {
          epoch: "epoch-a",
          seq: 1000 - s.refetch.mock.calls.length * 100,
        },
      }));
    expect(await s.read()).toBeNull();
    expect(s.refetch).toHaveBeenCalledTimes(3);
  });
  it.each([
    { error: "unavailable" },
    { gap: true },
    { staleCursor: true },
    { reset: true },
    { agentId: "other" },
  ])("does not trust an incomplete or mismatched page: %j", async (failure) => {
    const s = fixture();
    s.refetch.mockResolvedValue({ ...page(), ...failure } as ReturnType<
      typeof page
    >);
    expect(await s.read()).toBeNull();
  });
  it("stops on cancellation and repeated cursors and caps Unicode output", async () => {
    const s = fixture();
    s.refetch.mockResolvedValue(page([entry("target", "🌍".repeat(2100))]));
    expect(Array.from((await s.read())!).length).toBe(2000);
    s.refetch.mockReset().mockResolvedValue({ ...page([]), hasOlder: true });
    expect(await s.read()).toBeNull();
    expect(s.refetch).toHaveBeenCalledTimes(2);
    s.controller.abort();
    expect(await s.read()).toBeNull();
    expect(s.refetch).toHaveBeenCalledTimes(2);
  });
  it("bounds stalled lookups and consumes late rejections", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const reader = vi.fn(
      () =>
        new Promise<string>((_resolve, failure) => {
          reject = failure;
        }),
    );
    const result = boundedPreview(
      reader,
      "a",
      "target",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("");
    reject(new Error("late"));
    await Promise.resolve();
  });
  it("returns immediately when shutdown happens while a request is starting", async () => {
    const controller = new AbortController();
    const reader = vi.fn(() => {
      controller.abort();
      return new Promise<string>(() => {});
    });
    expect(await boundedPreview(reader, "a", "target", controller.signal)).toBe(
      "",
    );
  });
});
