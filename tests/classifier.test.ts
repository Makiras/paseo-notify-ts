import { describe, expect, it } from "vitest";
import { classify } from "../server/classifier";
import { nextRetry } from "../server/policy";
import { config } from "./fixtures";
import { finalText, currentError } from "../server/timeline";

describe("failure classification", () => {
  it.each([
    ["ECONNRESET", "connection reset", "network"],
    ["overloaded_error", "busy", "overloaded"],
    ["429", "insufficient_quota", "quota_exhausted"],
    ["503", "content_policy_violation", "policy_blocked"],
    [undefined, "context window full", "context_exhausted"],
    [undefined, "Rate limit exceeded. retry after 20 seconds", "rate_limited"],
    [undefined, "未知错误", "unknown"],
    ["content_filter", "blocked", "policy_blocked"],
    ["cyber_policy", "blocked", "policy_blocked"],
    ["503", "cyber_policy: network error", "policy_blocked"],
    [
      "provider.unknown",
      "This content was flagged for possible cybersecurity risk.",
      "policy_blocked",
    ],
  ])("%s %s -> %s", (code, message, kind) => {
    expect(
      classify({
        kind: "failed",
        error: { message, ...(code ? { code } : {}) },
      })?.kind,
    ).toBe(kind);
  });
  it("does not mistake successful technical discussion or quoted errors for interruptions", () => {
    expect(
      classify(
        { kind: "completed" },
        "The security policy and rate limit handling are implemented. ECONNRESET is covered.",
      ),
    ).toBeNull();
    expect(
      classify({ kind: "canceled", reason: "user stopped" }, "network error"),
    ).toBeNull();
    expect(
      classify(
        { kind: "completed" },
        "I cannot help with this because of the safety policy.",
      )?.kind,
    ).toBe("policy_blocked");
  });
  it("respects service retry hints and hard time/attempt budgets", () => {
    const c = config();
    const failure = classify({
      kind: "failed",
      error: { message: "Rate limit: retry after 2 minutes" },
    })!;
    expect(failure.retryAfterMs).toBe(120_000);
    expect(
      nextRetry({
        failure,
        attempts: 0,
        startedAt: 0,
        now: 0,
        config: c,
        random: 0,
      }),
    ).toEqual({ dueAt: 120_000 });
    c.recovery.maxElapsedMinutes = 1;
    expect(
      nextRetry({
        failure,
        attempts: 0,
        startedAt: 0,
        now: 0,
        config: c,
        random: 0,
      }),
    ).toHaveProperty("stopped");
    expect(
      nextRetry({
        failure: { kind: "network", evidence: "code" },
        attempts: 2,
        startedAt: 0,
        now: 0,
        config: c,
        random: 0,
      }),
    ).toHaveProperty("stopped");
  });
  it("never automatically retries policy, context, quota, or unknown errors", () => {
    for (const kind of [
      "policy_blocked",
      "context_exhausted",
      "quota_exhausted",
      "unknown",
    ] as const) {
      expect(
        nextRetry({
          failure: { kind, evidence: "code" },
          attempts: 0,
          startedAt: 0,
          now: 0,
          config: config(),
          random: 0,
        }),
      ).toHaveProperty("stopped");
    }
  });
  it("ignores old-turn errors when classifying the latest result", () => {
    const current = [
      { type: "user_message" as const, text: "new", clientMessageId: "u2" },
      { type: "assistant_message" as const, text: "done" },
    ];
    const old = [
      { type: "user_message" as const, text: "old" },
      { type: "error" as const, message: "ECONNRESET" },
      ...current,
    ];
    expect(finalText(old)).toBe(finalText(current));
    expect(currentError(old)).toBe("");
  });
});
