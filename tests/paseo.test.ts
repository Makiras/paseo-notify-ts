import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { paseoPort } from "../server/paseo";
import { event } from "./fixtures";

describe("Paseo adapter", () => {
  it("uses projected history and waits for the current user boundary", async () => {
    const refetch = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [{ item: event().timeline[1] }],
        epoch: "e1",
        hasOlder: true,
        startCursor: { epoch: "e1", seq: 10 },
      })
      .mockResolvedValueOnce({
        entries: [{ item: event().timeline[0] }],
        epoch: "e1",
        hasOlder: false,
      });
    const agent = {
      timeline: { refetch },
      refresh: vi.fn(async () => ({
        agent: {
          status: "error",
          pendingPermissions: [],
          persistence: { sessionId: "s1" },
          lastUserMessageAt: "now",
        },
      })),
    };
    const paseo = { agents: { ref: () => agent } } as unknown as PaseoApi;
    const view = await paseoPort(paseo).inspect("a");
    expect(view).toMatchObject({
      available: true,
      idle: true,
      sessionId: "s1",
    });
    expect(view.items).toHaveLength(2);
    expect(refetch.mock.calls[0]![0]).toMatchObject({
      projection: "projected",
      direction: "tail",
    });
    expect(refetch.mock.calls[1]![0]).toMatchObject({
      cursor: { epoch: "e1", seq: 10 },
      direction: "before",
    });
  });
  it("refuses a timeline replacement during pagination", async () => {
    const refetch = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [],
        epoch: "old",
        hasOlder: true,
        startCursor: { epoch: "old", seq: 9 },
      })
      .mockResolvedValueOnce({
        entries: [],
        epoch: "new",
        hasOlder: false,
        reset: true,
      });
    const paseo = {
      agents: { ref: () => ({ timeline: { refetch } }) },
    } as unknown as PaseoApi;
    await expect(paseoPort(paseo).inspect("a")).rejects.toThrow(
      "历史已发生变化",
    );
  });
  it("passes message identity and explicitly avoids the SDK's interrupt default", async () => {
    const send = vi.fn(async () => {});
    const paseo = { agents: { ref: () => ({ send }) } } as unknown as PaseoApi;
    await paseoPort(paseo).send("a", "continue", "stable-id");
    expect(send).toHaveBeenCalledWith("continue", {
      messageId: "stable-id",
      activeTurnBehavior: "steer",
    });
  });
});
