import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../server/runtime";
import type { PaseoPort, AgentView } from "../server/paseo";
import { buildRequest, deliver, DeliveryError } from "../server/channels";
import { config, event, memory, agent } from "./fixtures";
import { channelSchema } from "../shared/config";
import type { ReviewDecision, ReviewRequest } from "../server/reviewer";

const runtimes: Runtime[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  vi.useRealTimers();
});
async function setup(reviewEnabled = false) {
  const store = memory();
  const sent = vi.fn<typeof deliver>(async () => {});
  const c = config();
  c.recovery.review.enabled = reviewEnabled;
  const r = new Runtime(
    store,
    sent,
    () => Date.now(),
    () => 0,
  );
  runtimes.push(r);
  let view: AgentView & { items: ReturnType<typeof event>["timeline"] } = {
    available: true,
    idle: true,
    status: "error",
    pendingPermissions: 0,
    items: event().timeline,
  };
  const send = vi.fn(
    async (_agentId: string, _text: string, messageId: string) => {
      view = {
        ...view,
        idle: false,
        items: [
          ...view.items,
          {
            type: "user_message",
            text: "continue",
            clientMessageId: messageId,
          },
        ],
      };
    },
  );
  const inspect = vi.fn(async (): Promise<AgentView> => {
    const { items: _, ...snapshot } = view;
    return structuredClone(snapshot);
  });
  const history = vi.fn(async () => structuredClone(view.items));
  const review = vi.fn(
    async (
      _request: ReviewRequest,
      _signal: AbortSignal,
    ): Promise<ReviewDecision> => ({
      decision: "continue",
      reason: "临时故障，可以继续",
    }),
  );
  const archiveReviewer = vi.fn(async (_id: string) => {});
  const port: PaseoPort = {
    inspect,
    history,
    send,
    publish: vi.fn(async () => {}),
    review,
    archiveReviewer,
  };
  await r.start(c);
  r.connect(port);
  return {
    r,
    c,
    store,
    sent,
    send,
    inspect,
    history,
    port,
    review,
    archiveReviewer,
    setView: (next: Partial<typeof view>) => {
      view = { ...view, ...next };
    },
  };
}
describe("callback recovery and durable notification flow", () => {
  it("enforces the session attempt budget across continuation failures", async () => {
    const s = await setup();
    s.c.recoveryOverrides.sessions[agent.id] = {
      ...s.c.recovery,
      maxAttempts: 1,
    };
    await s.r.configure(s.c);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    const messageId = s.send.mock.calls[0]![2];
    await s.r.turnStarted(agent.id, "retry");
    s.setView({ idle: true, status: "error" });
    await s.r.turnEnded({ ...event(undefined, messageId), turnId: "retry" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.store.state.read().recoveries[0]!.reason).toContain(
      "重试次数上限",
    );
  });

  it("uses workspace delay, session prompt and review even when Host recovery is off", async () => {
    const s = await setup();
    const local = structuredClone(s.c.recovery);
    s.c.recovery.enabled = false;
    s.c.recoveryOverrides.workspaces[agent.workspaceId] = {
      ...local,
      baseDelaySeconds: 2,
    };
    await s.r.configure(s.c);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(s.send).toHaveBeenCalledOnce();
    await s.r.turnStarted(agent.id, "session-override");
    s.setView({
      idle: true,
      status: "error",
      items: event(undefined, "new-user").timeline,
    });
    s.c.recoveryOverrides.sessions[agent.id] = {
      ...local,
      prompt: "继续本会话",
      review: {
        ...local.review,
        enabled: true,
        provider: "claude",
        maxReviews: 1,
      },
    };
    await s.r.configure(s.c);
    await s.r.turnEnded({
      ...event(undefined, "new-user"),
      turnId: "session-override",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.review).toHaveBeenCalledOnce();
    expect(s.review.mock.calls[0]![0].config.provider).toBe("claude");
    expect(s.send.mock.calls.at(-1)![1]).toBe("继续本会话");
  });

  it("session off suppresses recovery and restoring inheritance applies to a new failed turn", async () => {
    const s = await setup();
    s.c.recoveryOverrides.sessions[agent.id] = {
      ...s.c.recovery,
      enabled: false,
    };
    await s.r.configure(s.c);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.send).not.toHaveBeenCalled();
    delete s.c.recoveryOverrides.sessions[agent.id];
    await s.r.configure(s.c);
    await s.r.turnStarted(agent.id, "next");
    await s.r.turnEnded({ ...event(undefined, "next-user"), turnId: "next" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledOnce();
  });

  it("changing another scope or shadowed Host policy does not cancel an in-flight preflight", async () => {
    const s = await setup();
    s.c.recoveryOverrides.sessions[agent.id] = structuredClone(s.c.recovery);
    await s.r.configure(s.c);
    let resolve!: (value: AgentView) => void;
    s.inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(800);
    s.c.recovery.enabled = false;
    s.c.recoveryOverrides.sessions.other = { ...s.c.recovery, enabled: false };
    await s.r.configure(s.c);
    resolve({
      available: true,
      idle: true,
      status: "error",
      pendingPermissions: 0,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(s.send).toHaveBeenCalledOnce();
  });

  it("turning off the effective workspace policy cancels waiting recovery", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    s.c.recoveryOverrides.workspaces[agent.workspaceId] = {
      ...s.c.recovery,
      enabled: false,
    };
    await s.r.configure(s.c);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]!.phase).toBe("canceled");
  });

  it("applies a session failure filter before scheduling and retains the global plugin switch", async () => {
    const s = await setup();
    s.c.recoveryOverrides.sessions[agent.id] = {
      ...s.c.recovery,
      network: false,
    };
    await s.r.configure(s.c);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
    s.c.enabled = false;
    s.c.recoveryOverrides.sessions[agent.id]!.network = true;
    await s.r.configure(s.c);
    await s.r.turnStarted(agent.id, "off");
    await s.r.turnEnded({ ...event(undefined, "off-user"), turnId: "off" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
  });

  it.each([
    "insufficient_quota",
    "content_policy_violation",
    "context length exceeded",
  ])("respects a newer hard failure in the snapshot: %s", async (error) => {
    const s = await setup();
    await s.r.turnEnded(event());
    s.setView({ error });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "paused",
      attempts: 0,
    });
    expect(s.store.state.read().recoveries[0]!.reason).toContain(
      "需要人工处理",
    );
  });

  it("honors manual cancellation after a continuation starts with its own turn ID", async () => {
    const s = await setup();
    await s.r.turnEnded({ ...event(), turnId: "initial" });
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.turnStarted(agent.id, "automatic");
    await s.r.turnStarted(agent.id, "automatic");
    await s.r.cancelRecovery(s.store.state.read().recoveries[0]!.id);
    s.setView({ idle: true, status: "error" });
    await s.r.turnEnded({
      ...event(undefined, s.send.mock.calls[0]![2]),
      turnId: "automatic",
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries).toHaveLength(1);
    await s.r.turnStarted(agent.id, "manual-new");
    await s.r.turnEnded({ ...event(), turnId: "manual-new" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(2);
  });
  it("classifies the current failure instead of an unrelated older timeline error", async () => {
    const s = await setup();
    await s.r.turnEnded({
      ...event({
        kind: "failed",
        error: { message: "Selected model is at capacity" },
      }),
      timeline: [{ type: "error", message: "insufficient_quota" }],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries[0]!.failure).toBe("overloaded");
  });

  it("recovers capacity failure with no user boundary and unavailable history", async () => {
    const s = await setup();
    s.history.mockRejectedValue(new Error("history is too long"));
    await s.r.turnEnded({
      ...event({
        kind: "failed",
        error: {
          message:
            "Selected model is at capacity. Please try a different model.",
        },
      }),
      timeline: [{ type: "assistant_message", text: "late tool output" }],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.history).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "running",
      attempts: 1,
    });
    expect(s.store.state.read().recoveries[0]).not.toHaveProperty(
      "fingerprint",
    );
  });
  it("ignores missing or changed history while the latest execution is still failed", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    s.setView({ items: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.history).not.toHaveBeenCalled();
  });
  it("allows a new failure after manual execution replaces a waiting plan", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.r.turnStarted(agent.id);
    // Even identical contents and null turn IDs belong to a new execution.
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries.map((r) => r.phase)).toEqual([
      "canceled",
      "running",
    ]);
  });
  it("keeps retry budgets for long automatic executions with null turn IDs and no user messages", async () => {
    const s = await setup();
    const failure = { ...event(), timeline: [] };
    await s.r.turnEnded(failure);
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.turnStarted(agent.id);
    s.setView({ idle: true, status: "error" });
    await s.r.turnEnded(failure);
    await s.r.turnEnded(failure);
    await vi.advanceTimersByTimeAsync(2000);
    await s.r.turnStarted(agent.id);
    s.setView({ idle: true, status: "error" });
    await s.r.turnEnded(failure);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(s.store.state.read().recoveries).toHaveLength(1);
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "exhausted",
      attempts: 2,
    });
  });
  it("allows a later failure with a different turn ID when the start callback was missed", async () => {
    const s = await setup();
    await s.r.turnEnded({ ...event(), turnId: "old" });
    s.setView({ idle: false, status: "running" });
    await vi.advanceTimersByTimeAsync(1000);
    s.setView({ idle: true, status: "error" });
    await s.r.turnEnded({ ...event(), turnId: "new" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("invalidates an in-flight check when a newer successful end callback arrives", async () => {
    const s = await setup();
    let resolve!: (view: AgentView) => void;
    s.inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    const completed = s.r.turnEnded(event({ kind: "completed" }));
    resolve({
      available: true,
      idle: true,
      status: "error",
      pendingPermissions: 0,
    });
    await completed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ idle: false, status: "running" }, "canceled", "正在执行"],
    [{ idle: false, pendingPermissions: 1 }, "paused", "等待权限"],
    [{ available: false }, "paused", "不可用"],
  ] as const)(
    "blocks explicit incompatible runtime state %j with a concrete reason",
    async (view, phase, reason) => {
      const s = await setup();
      await s.r.turnEnded(event());
      s.setView(view);
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.send).not.toHaveBeenCalled();
      expect(s.store.state.read().recoveries[0]).toMatchObject({
        phase,
        attempts: 0,
      });
      expect(s.store.state.read().recoveries[0]!.reason).toContain(reason);
    },
  );
  it("pauses on a failed status request without claiming content changed", async () => {
    const s = await setup();
    s.inspect.mockRejectedValue(new Error("offline"));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "paused",
      attempts: 0,
    });
    expect(s.store.state.read().recoveries[0]!.reason).toContain(
      "无法核对会话状态",
    );
  });
  it("pauses only enabled review when its bounded excerpt cannot be read", async () => {
    const s = await setup(true);
    s.history.mockRejectedValue(new Error("offline"));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.review).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]!.reason).toContain(
      "复核所需的会话摘录",
    );
  });
  it("reviews a partial tail without a user boundary or comparison against an older excerpt", async () => {
    const s = await setup(true);
    s.setView({
      items: [{ type: "assistant_message", text: "partial latest progress" }],
    });
    s.review.mockImplementation(async () => {
      s.setView({ items: [] });
      return { decision: "continue", reason: "temporary failure" };
    });
    await s.r.turnEnded({ ...event(), timeline: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.history).toHaveBeenCalledTimes(1);
    expect(s.review).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("uses the saved Feishu type for queued notices and immediate tests without replacing credentials", async () => {
    const s = await setup();
    s.c.channels[0] = channelSchema.parse({
      id: "hook-a",
      name: "Team",
      kind: "feishu",
    });
    await s.store.secrets.update((secrets) => {
      secrets["hook-a"] = {
        kind: "feishu",
        values: {
          url: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
          signingSecret: "saved",
          bearerToken: "",
          headers: {},
        },
      };
    });
    await s.r.configure(s.c);
    await s.r.turnEnded(event({ kind: "completed" }));
    s.c.channels[0]!.feishu = { messageType: "card" };
    await s.r.configure(s.c);
    await vi.advanceTimersByTimeAsync(1000);
    const first = s.sent.mock.calls[0]!;
    expect(
      JSON.parse(
        buildRequest(first[0], first[1], first[2], Date.now(), first[4]?.format)
          .body,
      ).msg_type,
    ).toBe("interactive");
    expect(await s.r.testChannel("hook-a")).toMatchObject({ ok: true });
    const last = s.sent.mock.calls.at(-1)!;
    const payload = JSON.parse(
      buildRequest(last[0], last[1], last[2], Date.now(), last[4]?.format).body,
    );
    expect(payload.card.header.title.content).toBe("Paseo · 测试通知");
    expect(payload.card.header.template).toBe("blue");
    expect(last[1].signingSecret).toBe("saved");
    s.c.channels[0]!.feishu = { messageType: "text" };
    await s.r.configure(s.c);
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.testChannel("hook-a");
    expect(s.sent.mock.calls.at(-1)![0].feishu?.messageType).toBe("text");
  });
  it("uses current saved templates for queued deliveries and immediate channel tests", async () => {
    const s = await setup();
    await s.r.turnEnded(event({ kind: "completed" }));
    s.c.notifications.template.title = "更新模板 · {{event}}";
    s.c.notifications.template.body = "任务：{{title}} / {{summary}}";
    await s.r.configure(s.c);
    await vi.advanceTimersByTimeAsync(1000);
    const first = s.sent.mock.calls[0]!;
    const normal = JSON.parse(
      buildRequest(first[0], first[1], first[2], Date.now(), first[4]?.format)
        .body,
    );
    expect(normal.message).toEqual({
      title: "更新模板 · 任务完成",
      body: "任务：检查项目 / 请在 Paseo 查看任务结果。",
    });
    expect(await s.r.testChannel("hook-a")).toMatchObject({ ok: true });
    const last = s.sent.mock.calls.at(-1)!;
    const test = JSON.parse(
      buildRequest(last[0], last[1], last[2], Date.now(), last[4]?.format).body,
    );
    expect(test.message).toEqual({
      title: "更新模板 · 测试通知",
      body: "任务：Paseo 通知连接测试 / 通知渠道已连通。",
    });
    expect(s.store.state.read().deliveries[0]!.notice).not.toHaveProperty(
      "message",
    );
  });
  it("sends multiple scheduled runs and permission requests to the bound channel", async () => {
    const s = await setup();
    s.c.channels.push(
      channelSchema.parse({ id: "hook-b", name: "Scheduled", kind: "webhook" }),
    );
    s.c.routing.schedules.daily = ["hook-b"];
    await s.r.configure(s.c);
    for (const id of ["run-one", "run-two"]) {
      await s.r.turnEnded(
        {
          ...event({ kind: "completed" }),
          agent: { ...agent, id, workspaceId: id },
        },
        "daily",
      );
    }
    await s.r.permission(agent, "permission-one", "daily");
    const deliveries = s.store.state.read().deliveries;
    expect(deliveries).toHaveLength(3);
    expect(
      deliveries.every(
        (d) => d.channelId === "hook-b" && d.notice.scheduleId === "daily",
      ),
    ).toBe(true);
  });
  it("retains the schedule source for recovery notifications after restart", async () => {
    const s = await setup();
    s.c.routing.host = [];
    s.c.routing.schedules.daily = ["hook-a"];
    await s.r.configure(s.c);
    await s.r.turnEnded(event(), "daily");
    await s.r.close();
    await s.store.state.update((state) => {
      state.recoveries[0]!.startedAt -= 60 * 60_000;
    });
    const resumed = new Runtime(s.store, s.sent);
    runtimes.push(resumed);
    await resumed.start(s.c);
    expect(s.store.state.read().deliveries[0]).toMatchObject({
      channelId: "hook-a",
      notice: { scheduleId: "daily", kind: "failed" },
    });
  });
  it("keeps duplicate failure callbacks from aborting an in-flight review", async () => {
    const s = await setup(true);
    s.review.mockImplementation(() => new Promise(() => {}));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.turnEnded(event());
    expect(s.review.mock.calls[0]![1].aborted).toBe(false);
    const id = s.store.state.read().recoveries[0]!.id;
    expect(await s.r.cancelRecovery(id)).toBe(true);
    expect(s.send).not.toHaveBeenCalled();
  });
  it("cancels an active review when its configuration changes", async () => {
    const s = await setup(true);
    s.review.mockImplementation(() => new Promise(() => {}));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    s.c.recovery.review.provider = "claude";
    await s.r.configure(s.c);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.review.mock.calls[0]![1].aborted).toBe(true);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]!.phase).toBe("canceled");
  });
  it("allows at most two concurrent reviewers across different source agents", async () => {
    const s = await setup(true);
    s.review.mockImplementation(() => new Promise(() => {}));
    for (const id of ["a", "b", "c"])
      await s.r.turnEnded({ ...event(), agent: { ...agent, id } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.review).toHaveBeenCalledTimes(2);
    expect(
      s.store.state.read().recoveries.filter((r) => r.phase === "waiting"),
    ).toHaveLength(1);
  });
  it("archives a late creation callback after the review was already canceled", async () => {
    const s = await setup(true);
    s.review.mockImplementation(() => new Promise(() => {}));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.cancelRecovery(s.store.state.read().recoveries[0]!.id);
    const id = s.review.mock.calls[0]![0].agentId;
    s.r.agentCreated(id);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.archiveReviewer).toHaveBeenCalledTimes(2);
    expect(s.archiveReviewer).toHaveBeenLastCalledWith(id);
  });
  it("does not use a review decision when execution resumes", async () => {
    const s = await setup(true);
    s.review.mockImplementation(async () => {
      s.setView({ idle: false, status: "running" });
      return { decision: "continue", reason: "old snapshot" };
    });
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
  });
  it("does not let AI review override policy and quota exclusions", async () => {
    const s = await setup(true);
    await s.r.turnEnded(
      event({ kind: "failed", error: { message: "insufficient_quota" } }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.review).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });
  it("reviews each retry and archives the reviewer before submitting continuation", async () => {
    const s = await setup(true);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.review).toHaveBeenCalledTimes(1);
    expect(s.archiveReviewer).toHaveBeenCalledWith(
      s.review.mock.calls[0]![0].agentId,
    );
    expect(s.archiveReviewer.mock.invocationCallOrder[0]).toBeLessThan(
      s.send.mock.invocationCallOrder[0]!,
    );
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "running",
      attempts: 1,
      reviews: [{ status: "continue", cleanupPending: false }],
    });
  });
  it.each(["stop", "needs_user"] as const)(
    "pauses on %s without leaking the review excerpt through notifications",
    async (decision) => {
      const s = await setup(true);
      s.review.mockResolvedValue({ decision, reason: "private task context" });
      await s.r.turnEnded(event());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.send).not.toHaveBeenCalled();
      expect(s.store.state.read().recoveries[0]).toMatchObject({
        phase: "paused",
        attempts: 0,
        reviews: [{ status: decision }],
      });
      expect(JSON.stringify(s.store.state.read().deliveries)).not.toContain(
        "private task context",
      );
      expect(s.sent).toHaveBeenCalledTimes(1);
    },
  );
  it("times out a hung reviewer, archives it, and never retries the reviewer", async () => {
    const s = await setup(true);
    s.review.mockImplementation(() => new Promise(() => {}));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.store.state.read().recoveries[0]!.phase).toBe("reviewing");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.review).toHaveBeenCalledTimes(1);
    expect(s.archiveReviewer).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries[0]!.phase).toBe("paused");
  });
  it("interrupts review promptly when the user takes over", async () => {
    const s = await setup(true);
    s.review.mockImplementation(() => new Promise(() => {}));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.turnStarted(agent.id);
    expect(s.review.mock.calls[0]![1].aborted).toBe(true);
    expect(s.archiveReviewer).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries[0]!.phase).toBe("canceled");
    expect(s.send).not.toHaveBeenCalled();
  });
  it("invalidates an approval when the source completed without a callback", async () => {
    const s = await setup(true);
    s.review.mockImplementation(async () => {
      s.setView({ status: "idle", idle: true });
      return { decision: "continue", reason: "old snapshot" };
    });
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]!.phase).toBe("canceled");
  });
  it("ignores reviewer callbacks even when child-agent notifications are enabled", async () => {
    const s = await setup(true);
    s.c.includeSubagents = true;
    await s.r.configure(s.c);
    s.review.mockImplementation(async (request) => {
      const child = { ...agent, id: request.agentId, parentAgentId: agent.id };
      await s.r.permission(child, "permission-a");
      await s.r.turnEnded({ ...event({ kind: "completed" }), agent: child });
      return { decision: "continue", reason: "fine" };
    });
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.store.state.read().recoveries).toHaveLength(1);
    expect(s.sent).not.toHaveBeenCalled();
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("keeps a distinct review budget across automatic turns", async () => {
    const s = await setup(true);
    s.c.recovery.review.maxReviews = 1;
    await s.r.configure(s.c);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    const next = event(undefined, s.send.mock.calls[0]![2]);
    s.setView({ idle: true, items: next.timeline });
    await s.r.turnEnded(next);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.review).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries[0]!.reason).toContain(
      "复核次数已用尽",
    );
  });
  it("pauses after restart during review and cleans only the recorded reviewer", async () => {
    const s = await setup(true);
    await s.r.turnEnded(event());
    await s.r.close();
    await s.store.state.update((state) => {
      state.recoveries[0]!.phase = "reviewing";
      state.recoveries[0]!.reviews.push({
        agentId: "orphan-review",
        status: "pending",
        reason: "",
        createdAt: Date.now(),
        cleanupPending: true,
      });
    });
    const next = new Runtime(s.store, s.sent);
    runtimes.push(next);
    await next.start(s.c);
    next.connect(s.port);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.review).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.archiveReviewer).toHaveBeenCalledWith("orphan-review");
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "paused",
      reviews: [{ status: "error", cleanupPending: false }],
    });
  });
  it("does not allow an approved review to bypass a cleanup failure", async () => {
    const s = await setup(true);
    s.archiveReviewer.mockRejectedValue(new Error("network"));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "paused",
      reviews: [{ cleanupPending: true }],
    });
  });
  it("keeps one budget across automatic turns, including null provider turn IDs", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.r.turnEnded(event());
    expect(s.store.state.read().recoveries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
    const firstId = s.send.mock.calls[0]![2];
    const next = event(undefined, firstId);
    s.setView({ idle: true, items: next.timeline });
    await s.r.turnEnded(next);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.send).toHaveBeenCalledTimes(2);
    const third = event(undefined, s.send.mock.calls[1]![2]);
    s.setView({ idle: true, items: third.timeline });
    await s.r.turnEnded(third);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      attempts: 2,
      phase: "exhausted",
    });
    expect(s.sent).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().deliveries[0]?.notice.kind).toBe("failed");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.send).toHaveBeenCalledTimes(2);
  });
  it("coalesces recovery into a single recovered notification", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    const done = event({ kind: "completed" }, s.send.mock.calls[0]![2]);
    s.setView({ idle: true, items: done.timeline });
    await s.r.turnEnded(done);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.store.state.read().deliveries).toHaveLength(1);
    expect(s.store.state.read().deliveries[0]?.notice).toMatchObject({
      kind: "recovered",
      attempts: 1,
    });
    expect(s.store.state.read().recoveries[0]?.phase).toBe("done");
  });
  it("cancels delayed recovery when the user starts another turn", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.r.turnStarted(agent.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]?.phase).toBe("canceled");
  });
  it("rechecks user cancellation while the pre-send inspection is in flight", async () => {
    const s = await setup();
    let resolve!: (view: AgentView) => void;
    const pending = new Promise<AgentView>((r) => {
      resolve = r;
    });
    s.inspect.mockImplementationOnce(async () => ({
      available: true,
      idle: true,
      status: "error",
      pendingPermissions: 0,
    }));
    s.inspect.mockImplementationOnce(() => pending);
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    const id = s.store.state.read().recoveries[0]!.id;
    const cancel = s.r.cancelRecovery(id);
    resolve({
      available: true,
      idle: true,
      status: "error",
      pendingPermissions: 0,
    });
    await cancel;
    await vi.advanceTimersByTimeAsync(1);
    expect(s.send).not.toHaveBeenCalled();
  });
  it("does not send after normal completion even without a turn-start callback", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    s.setView({ status: "idle", idle: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).not.toHaveBeenCalled();
  });
  it("does not repeat a command after an ambiguous acknowledgement", async () => {
    const s = await setup();
    s.send.mockRejectedValueOnce(new Error("ack lost"));
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries[0]?.phase).toBe("paused");
  });
  it("does not restart a manually canceled recovery when its in-flight turn fails", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    await s.r.cancelRecovery(s.store.state.read().recoveries[0]!.id);
    const fail = event(undefined, s.send.mock.calls[0]![2]);
    s.setView({ idle: true, items: fail.timeline });
    await s.r.turnEnded(fail);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries).toHaveLength(1);
  });
  it("routes new events through inheritance while retaining queued destinations", async () => {
    const s = await setup();
    s.c.channels.push(
      channelSchema.parse({ id: "hook-b", name: "B", kind: "webhook" }),
    );
    s.c.routing.workspaces[agent.workspaceId] = ["hook-b"];
    await s.r.configure(s.c);
    await s.r.setCredentials("hook-b", "webhook", {
      url: "https://example.invalid/b",
      headers: {},
      bearerToken: "",
      signingSecret: "",
    });
    await s.r.turnEnded(event({ kind: "completed" }));
    expect(s.store.state.read().deliveries.map((d) => d.channelId)).toEqual([
      "hook-b",
    ]);
    s.c.routing.workspaces[agent.workspaceId] = [];
    await s.r.configure(s.c);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.sent).toHaveBeenCalledTimes(1);
    expect((s.sent.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe(
      "hook-b",
    );
    await s.r.turnEnded(event({ kind: "completed" }, "another-user"));
    expect(s.store.state.read().deliveries).toHaveLength(1);
  });
  it("never sends a queued notice to a target whose credentials changed", async () => {
    const s = await setup();
    await s.r.turnEnded(event({ kind: "completed" }));
    await s.r.setCredentials("hook-a", "webhook", {
      url: "https://example.invalid/new-group",
      headers: {},
      bearerToken: "",
      signingSecret: "",
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.sent).not.toHaveBeenCalled();
    expect(s.store.state.read().deliveries[0]).toMatchObject({
      phase: "canceled",
      error: "渠道凭据或目标已变更，旧通知已取消",
    });
  });
  it("stages imported credentials without modifying any registered channel", async () => {
    const s = await setup();
    const before = s.store.secrets.read();
    await expect(
      s.r.stageImportCredentials({ "hook-a": before["hook-a"]! }),
    ).rejects.toThrow("配置已变化");
    expect(s.store.secrets.read()).toEqual(before);
    await s.r.stageImportCredentials({ "import-new": before["hook-a"]! });
    await s.r.turnEnded(event({ kind: "completed" }));
    expect(s.store.state.read().deliveries.map((d) => d.channelId)).toEqual([
      "hook-a",
    ]);
  });
  it("pins legacy queued destinations when upgrading the journal", async () => {
    const s = await setup();
    await s.r.turnEnded(event({ kind: "completed" }));
    await s.store.state.update((state) => {
      delete state.deliveries[0]!.credentialsHash;
    });
    await s.r.close();
    const resumed = new Runtime(s.store, s.sent);
    runtimes.push(resumed);
    await resumed.start(s.c);
    expect(s.store.state.read().deliveries[0]!.credentialsHash).toBeDefined();
    await resumed.setCredentials("hook-a", "webhook", {
      url: "https://example.invalid/new-group",
      headers: {},
      bearerToken: "",
      signingSecret: "",
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.sent).not.toHaveBeenCalled();
    expect(s.store.state.read().deliveries[0]!.phase).toBe("canceled");
  });
  it("isolates channel failures and applies notification retry budgets", async () => {
    const s = await setup();
    s.c.recovery.enabled = false;
    s.c.notifications.maxAttempts = 2;
    s.c.channels.push(
      channelSchema.parse({ id: "hook-b", kind: "webhook", name: "Second" }),
    );
    s.c.routing.host.push("hook-b");
    await s.r.configure(s.c);
    await s.r.setCredentials("hook-b", "webhook", {
      url: "https://example.invalid/b",
      headers: {},
      signingSecret: "",
      bearerToken: "",
    });
    s.sent.mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as { id: string }).id === "hook-a")
        throw new DeliveryError("HTTP 503", true);
    });
    await s.r.turnEnded(event({ kind: "completed" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(
      s.store.state.read().deliveries.find((d) => d.channelId === "hook-b")
        ?.phase,
    ).toBe("sent");
    expect(
      s.store.state.read().deliveries.find((d) => d.channelId === "hook-a")
        ?.phase,
    ).toBe("pending");
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      s.store.state.read().deliveries.find((d) => d.channelId === "hook-a"),
    ).toMatchObject({ phase: "failed", attempts: 2 });
  });
  it("notifies policy blocks, quota, and permissions without auto-continuing", async () => {
    const s = await setup();
    await s.r.turnEnded(
      event({
        kind: "failed",
        error: { message: "content policy violation", code: "content_filter" },
      }),
    );
    await s.r.permission(agent, "permission-1");
    await s.r.permission(agent, "permission-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().deliveries.map((d) => d.notice.kind)).toEqual([
      "blocked",
      "permission",
    ]);
  });
  it("disables queued work immediately and redacts credentials from status", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.r.configure({ ...s.c, enabled: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.sent).not.toHaveBeenCalled();
    const status = JSON.stringify(s.r.status());
    expect(status).not.toContain("secret-token");
    expect(status).not.toContain("example.invalid");
  });
  it("preserves budgets across reload and pauses unconfirmed dispatches", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.store.state.update((state) => {
      state.recoveries[0]!.phase = "dispatching";
      state.recoveries[0]!.attempts = 1;
    });
    await s.r.close();
    const next = new Runtime(
      s.store,
      s.sent,
      () => Date.now(),
      () => 0,
    );
    runtimes.push(next);
    await next.start(s.c);
    next.connect(s.port);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.state.read().recoveries[0]).toMatchObject({
      phase: "paused",
      attempts: 1,
    });
  });
  it("resumes pending notices without needing a Paseo client connection", async () => {
    const s = await setup();
    await s.r.turnEnded(event({ kind: "completed" }));
    await s.r.close();
    const next = new Runtime(
      s.store,
      s.sent,
      () => Date.now(),
      () => 0,
    );
    runtimes.push(next);
    await next.start(s.c);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.sent).toHaveBeenCalledTimes(1);
    expect(next.status().connected).toBe(false);
  });
  it("cleans up timers on unload", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.r.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.send).not.toHaveBeenCalled();
  });
  it("removes queued previews without erasing failure explanations on a settings change", async () => {
    const s = await setup();
    s.c.notifications.includePreview = true;
    await s.r.configure(s.c);
    await s.r.turnEnded(event({ kind: "completed" }));
    await s.r.turnEnded(
      event(
        { kind: "failed", error: { message: "insufficient_quota" } },
        "second-user",
      ),
    );
    const before = s.store.state.read().deliveries;
    expect(before[0]!.notice.preview).toBe("工作已完成");
    const explanation = before[1]!.notice.summary;
    await s.r.configure({
      ...s.c,
      notifications: { ...s.c.notifications, includePreview: false },
    });
    const after = s.store.state.read().deliveries;
    expect(after[0]!.notice.preview).toBeUndefined();
    expect(after[1]!.notice.summary).toBe(explanation);
  });
  it("keeps the remaining recovery budget when a waiting plan is reloaded", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await s.store.state.update((state) => {
      state.recoveries[0]!.attempts = 1;
    });
    await s.r.close();
    const next = new Runtime(
      s.store,
      s.sent,
      () => Date.now(),
      () => 0,
    );
    runtimes.push(next);
    await next.start(s.c);
    next.connect(s.port);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.state.read().recoveries[0]!.attempts).toBe(2);
  });
  it("reports a missing terminal event after restart without inventing completion", async () => {
    const s = await setup();
    await s.r.turnEnded(event());
    await vi.advanceTimersByTimeAsync(1000);
    s.setView({ idle: true });
    await s.r.close();
    const next = new Runtime(
      s.store,
      s.sent,
      () => Date.now(),
      () => 0,
    );
    runtimes.push(next);
    await next.start(s.c);
    next.connect(s.port);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.store.state.read().recoveries[0]!.phase).toBe("paused");
    expect(
      s.store.state
        .read()
        .deliveries.some(
          (d) => d.notice.kind === "completed" || d.notice.kind === "recovered",
        ),
    ).toBe(false);
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("does not exceed a persisted notification budget after restart", async () => {
    const s = await setup();
    await s.r.turnEnded(event({ kind: "completed" }));
    await s.store.state.update((state) => {
      state.deliveries[0]!.attempts = s.c.notifications.maxAttempts;
    });
    await s.r.close();
    const next = new Runtime(
      s.store,
      s.sent,
      () => Date.now(),
      () => 0,
    );
    runtimes.push(next);
    await next.start(s.c);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.sent).not.toHaveBeenCalled();
    expect(s.store.state.read().deliveries[0]!.phase).toBe("failed");
  });
});
