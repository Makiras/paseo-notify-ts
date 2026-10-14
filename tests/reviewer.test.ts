import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/types";
import {
  parseReview,
  reviewPrompt,
  reviewerConfig,
  reviewWithPaseo,
  archiveReviewer,
} from "../server/reviewer";
import { defaultConfig } from "../shared/config";
import { event } from "./fixtures";

function fakePaseo() {
  const archive = vi.fn(async () => ({ archivedAt: "now" }));
  const reviewer = {
    id: "review-id",
    archive,
    waitForFinish: vi.fn(async () => ({
      status: "idle",
      lastMessage: '{"decision":"continue","reason":"临时网络故障"}',
    })),
  };
  const create = vi.fn(async (_options: unknown) => reviewer);
  const paseo = {
    agents: {
      ref: () => ({
        refresh: vi.fn(async () => ({
          agent: {
            provider: "codex",
            model: "a-model",
            workspaceId: "workspace-a",
          },
        })),
        archive,
      }),
    },
    workspaces: { ref: vi.fn(() => ({ agents: { create } })) },
  } as unknown as PaseoApi;
  return { paseo, reviewer, create, archive };
}
const request = () => ({
  agentId: "review-id",
  parentAgentId: "parent-id",
  config: defaultConfig().recovery.review,
  prompt: "Review this snapshot",
});

describe("independent AI review adapter", () => {
  it.each([
    '{"decision":"yes","reason":"fine"}',
    '{"decision":"continue","reason":"fine","command":"run"}',
    "```json\n{}\n```",
    "null",
    "{}",
  ])("rejects ambiguous or executable output: %s", (text) => {
    expect(() => parseReview(text)).toThrow();
  });
  it("bounds excerpts and excludes plugin cards", () => {
    const items = [...event().timeline];
    items.push({ type: "assistant_message", text: "x".repeat(10000) });
    const prompt = JSON.parse(
      reviewPrompt({
        title: "task",
        failure: "network",
        attempts: 2,
        continuation: "continue",
        items,
        limit: 1000,
      }),
    );
    expect(
      prompt.excerpt.reduce(
        (n: number, item: { text: string }) => n + item.text.length,
        0,
      ),
    ).toBeLessThanOrEqual(1000);
    expect(prompt.incompleteHistory).toBe(true);
    expect(prompt.priorAttempts).toBe(2);
  });
  it("starts a distinct child in the existing workspace with a stable ID and a schema", async () => {
    const s = fakePaseo();
    await expect(
      reviewWithPaseo(s.paseo, request(), new AbortController().signal),
    ).resolves.toEqual({ decision: "continue", reason: "临时网络故障" });
    expect(s.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "review-id",
        idempotencyKey: "review-id",
        parent: "parent-id",
        config: expect.objectContaining({
          provider: "codex/a-model",
          modeId: "auto",
          options: expect.objectContaining({ sandbox_mode: "read-only" }),
        }),
        outputSchema: expect.objectContaining({
          required: ["decision", "reason"],
        }),
      }),
    );
    expect(s.paseo.workspaces.ref).toHaveBeenCalledWith("workspace-a");
    await archiveReviewer(s.paseo, "review-id");
    expect(s.archive).toHaveBeenCalledTimes(1);
  });
  it("does not turn a permission request or provider error into approval", async () => {
    const s = fakePaseo();
    s.reviewer.waitForFinish.mockResolvedValueOnce({
      status: "permission",
      lastMessage: '{"decision":"continue","reason":"fine"}',
    });
    await expect(
      reviewWithPaseo(s.paseo, request(), new AbortController().signal),
    ).rejects.toThrow("复核未完成");
  });
  it("archives an agent whose creation completes after local cancellation", async () => {
    const s = fakePaseo();
    let created!: (agent: typeof s.reviewer) => void;
    s.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          created = resolve;
        }),
    );
    const controller = new AbortController();
    const task = reviewWithPaseo(s.paseo, request(), controller.signal);
    const rejected = expect(task).rejects.toThrow("取消或超时");
    await vi.waitFor(() => expect(s.create).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    created(s.reviewer);
    await vi.waitFor(() => expect(s.archive).toHaveBeenCalledTimes(1));
    expect(s.reviewer.waitForFinish).not.toHaveBeenCalled();
  });
  it("uses provider-specific restrictions and fails for unknown providers", () => {
    expect(reviewerConfig("opencode/example/model").options).toEqual({
      permission: "deny",
    });
    expect(reviewerConfig("claude/model").options).toMatchObject({
      disallowedTools: ["*"],
    });
    expect(() => reviewerConfig("unknown-provider")).toThrow("受限复核配置");
  });
});
