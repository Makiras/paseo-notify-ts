import { describe, expect, it, vi } from "vitest";
import plugin, {
  isCyberRejection,
  type RetryEvent,
} from "../server/opencode/cyber-retry-guard";

const message = "This content was flagged for possible cybersecurity risk.";
describe("OpenCode cyber retry guard", () => {
  it.each([
    { code: "cyber_policy" },
    { code: "CYBER_SAFETY" },
    {
      type: "provider.unknown",
      message: `cyber_policy: ${message}`,
      status: 200,
    },
    { type: "provider.unknown", message, status: 200 },
    {
      type: "provider.internal",
      message: "network error: cyber_policy",
      status: 503,
    },
    {
      type: "provider.unknown",
      message: "Request failed",
      status: 200,
      response: {
        body: JSON.stringify({
          type: "response.failed",
          response: {
            error: { type: "invalid_request", code: "cyber_policy", message },
          },
        }),
      },
    },
    { response: { body: JSON.stringify({ error: { code: "cyber_policy" } }) } },
  ])("recognizes explicit cyber refusal: %j", (error) => {
    expect(isCyberRejection(error)).toBe(true);
  });

  it.each([
    null,
    "cyber_policy",
    {},
    { message: "ECONNRESET" },
    { message: "Rate limit exceeded", status: 429 },
    { message: "At capacity", status: 503 },
    { message: "Unknown upstream error" },
    { message: "cybersecurity proxy connection reset" },
    { message: "content_policy_violation" },
    { response: { body: "not JSON" } },
    { response: { body: JSON.stringify({ input: "cyber_policy" }) } },
  ])("leaves other errors alone: %j", (error) => {
    expect(isCyberRejection(error)).toBe(false);
  });

  it("vetoes cyber retries, preserves every other decision and unregisters on unload", async () => {
    let callback!: (event: RetryEvent) => void;
    const dispose = vi.fn(async () => {});
    const cleanup = await plugin.setup({
      session: {
        hook: async (name, handler) => {
          expect(name).toBe("retry");
          callback = handler;
          return { dispose };
        },
      },
    });
    const blocked: RetryEvent = {
      error: { message: "cyber_policy" },
      decision: { retry: true, delay: 2000 },
    };
    callback(blocked);
    expect(blocked.decision).toEqual({ retry: false });
    for (const decision of [
      { retry: false } as const,
      { retry: true, delay: 4321 } as const,
    ]) {
      const other: RetryEvent = { error: { message: "ECONNRESET" }, decision };
      callback(other);
      expect(other.decision).toBe(decision);
    }
    await cleanup();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
