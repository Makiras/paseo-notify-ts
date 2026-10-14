import { randomUUID } from "node:crypto";
import type {
  PluginHookAgent,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";
import {
  defaultConfig,
  failureLabels,
  type Channel,
  type Config,
} from "../shared/config";
import type {
  Credentials,
  Notification,
  RecoveryCard,
  RuntimeStatus,
} from "../shared/contracts";
import { classify } from "./classifier";
import {
  deliver,
  DeliveryError,
  validateCredentials,
  channelSpacing,
} from "./channels";
import { abortable, reviewPrompt, type ReviewDecision } from "./reviewer";
import { nextRetry } from "./policy";
import type { PaseoPort } from "./paseo";
import type { AgentTimelineItem } from "./types";
import { prune, type Recovery, type State, type Storage } from "./storage";
import {
  currentError,
  digest,
  finalText,
  fingerprint,
  userIdentity,
} from "./timeline";

type EndEvent = PluginLifecycleEvents["agent.turn_ended"];
type Sender = typeof deliver;
export type RuntimeStorage = {
  state: Pick<Storage["state"], "read" | "update">;
  secrets: Pick<Storage["secrets"], "read" | "update">;
  close(): Promise<void>;
};
const active = (r: Recovery) =>
  ["waiting", "reviewing", "dispatching", "running"].includes(r.phase);
function routes(channel: Channel, notice: Notification): boolean {
  return (
    channel.enabled &&
    channel.events.includes(notice.kind) &&
    (!channel.providers.length ||
      channel.providers.includes(notice.provider)) &&
    (!channel.workspaceIds.length ||
      (notice.workspaceId !== null &&
        channel.workspaceIds.includes(notice.workspaceId)))
  );
}
const cardOf = (r: Recovery): RecoveryCard => ({
  id: r.id,
  agentId: r.agentId,
  title: r.title,
  phase: r.phase,
  reason: r.reason,
  attempts: r.attempts,
  dueAt: r.dueAt,
  updatedAt: r.updatedAt,
  reviews: r.reviews,
});

export class Runtime {
  private config = defaultConfig();
  private port?: PaseoPort;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  private readonly recoveryBusy = new Set<string>();
  private readonly deliveryBusy = new Map<string, AbortController>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly reconcileOnConnect = new Set<string>();
  private readonly reviewControllers = new Map<string, AbortController>();
  private readonly ownedReviewers = new Set<string>();
  private readonly cleanupOnConnect = new Set<string>();
  settingsError: string | null = null;
  storageError: string | null = null;

  constructor(
    readonly storage: RuntimeStorage,
    private readonly sender: Sender = deliver,
    private readonly now = Date.now,
    private readonly random = Math.random,
  ) {}

  async start(config: Config): Promise<void> {
    this.config = structuredClone(config);
    await this.storage.state.update((state) => {
      for (const r of state.recoveries) {
        for (const review of r.reviews) {
          this.ownedReviewers.add(review.agentId);
          if (review.cleanupPending) this.cleanupOnConnect.add(review.agentId);
          if (review.status === "pending") {
            review.status = "error";
            review.reason = "复核被重启中断，未采纳结论";
          }
        }
        if (r.phase === "reviewing") {
          r.phase = "paused";
          r.dueAt = null;
          r.updatedAt = this.now();
          r.reason = "复核被重启中断，已暂停；不会重新调用 AI 或自动继续";
          this.enqueue(state, this.recoveryNotice(r, "failed", r.reason));
        }
        if (r.phase === "running") this.reconcileOnConnect.add(r.id);
        if (r.phase === "dispatching") {
          r.phase = "paused";
          r.dueAt = null;
          r.updatedAt = this.now();
          r.reason = "重启前的发送结果未确认，请检查会话；不会自动重复发送";
          this.enqueue(state, this.recoveryNotice(r, "failed", r.reason));
        }
        if (
          r.phase === "waiting" &&
          this.now() >= r.startedAt + config.recovery.maxElapsedMinutes * 60_000
        ) {
          r.phase = "exhausted";
          r.dueAt = null;
          r.updatedAt = this.now();
          r.reason = "重启时自动恢复的时间预算已用尽";
          this.enqueue(state, this.recoveryNotice(r, "failed", r.reason));
        }
      }
      prune(state, this.now(), config.notifications.retentionDays);
    });
    await this.configure(config);
  }
  connect(port: PaseoPort): void {
    if (this.closed) return;
    this.port = port;
    for (const id of this.cleanupOnConnect)
      this.background(this.cleanupReviewer(id));
    this.cleanupOnConnect.clear();
    for (const id of this.reconcileOnConnect) {
      const r = this.storage.state.read().recoveries.find((r) => r.id === id);
      if (r)
        this.background(
          this.lane(r.agentId, async () => {
            const current = this.storage.state
              .read()
              .recoveries.find((r) => r.id === id);
            if (current?.phase !== "running") return;
            try {
              const view = await port.inspect(current.agentId);
              const user = userIdentity(view.items);
              if (
                !view.available ||
                (user !== current.messageId && user !== current.userKey)
              )
                await this.stopRecovery(id, "重启后会话已发生变化");
              else if (view.idle)
                await this.stopRecovery(
                  id,
                  "离线期间执行已结束，未收到终止事件；请在 Paseo 检查结果",
                  "paused",
                );
            } catch {
              await this.stopRecovery(
                id,
                "重启后无法核对会话状态，请检查任务结果",
                "paused",
              );
            }
          }),
        );
    }
    this.reconcileOnConnect.clear();
    this.wake();
  }
  private bump(agentId: string): void {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    this.reviewControllers.get(agentId)?.abort();
  }
  private lane<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.lanes.set(agentId, next);
    void next
      .finally(() => {
        if (this.lanes.get(agentId) === next) this.lanes.delete(agentId);
      })
      .catch(() => undefined);
    return next;
  }
  private background(task: Promise<unknown>): void {
    this.jobs.add(task);
    void task
      .catch(() => {
        this.storageError =
          "无法完成运行记录操作，自动任务已暂停；请检查插件日志和数据目录后重新加载";
        console.error(
          "[paseo-notifier] Operational state update failed; automatic work paused.",
        );
      })
      .finally(() => {
        this.jobs.delete(task);
        this.wake();
      });
  }
  async configure(config: Config): Promise<void> {
    const recoveryChanged =
      JSON.stringify(this.config.recovery) !== JSON.stringify(config.recovery);
    if (recoveryChanged || !config.enabled)
      for (const id of new Set(
        this.storage.state
          .read()
          .recoveries.filter(active)
          .map((r) => r.agentId),
      ))
        this.bump(id);
    this.config = structuredClone(config);
    for (const [id, controller] of this.deliveryBusy) {
      if (
        !config.enabled ||
        !config.channels.some((c) => c.id === id && c.enabled)
      )
        controller.abort();
    }
    await this.storage.state.update((state) => {
      for (const r of state.recoveries) {
        const allowed =
          r.failure === "network"
            ? config.recovery.network
            : r.failure === "overloaded"
              ? config.recovery.overloaded
              : r.failure === "rate_limited"
                ? config.recovery.rateLimited
                : false;
        if (
          active(r) &&
          (!config.enabled || !config.recovery.enabled || !allowed)
        ) {
          this.bump(r.agentId);
          r.phase = "canceled";
          r.dueAt = null;
          r.reason = "配置变更，已取消等待中的恢复";
          r.updatedAt = this.now();
        }
      }
      for (const d of state.deliveries) {
        const channel = config.channels.find(
          (c) => c.id === d.channelId && c.kind === d.channelKind,
        );
        if (
          d.phase === "pending" &&
          (!config.enabled || !channel || !routes(channel, d.notice))
        ) {
          d.phase = "canceled";
          d.updatedAt = this.now();
          d.error = "配置已停用此通知";
        }
        if (!config.notifications.includePreview) delete d.notice.preview;
      }
      prune(state, this.now(), config.notifications.retentionDays);
    });
    this.wake();
  }
  async setCredentials(
    id: string,
    kind: Channel["kind"],
    values: Credentials,
  ): Promise<void> {
    if (!this.config.channels.some((c) => c.id === id && c.kind === kind))
      throw new Error("请先保存此渠道的设置");
    validateCredentials(kind, values);
    await this.storage.secrets.update((state) => {
      state[id] = { kind, values };
    });
  }
  async deleteCredentials(id: string): Promise<void> {
    this.deliveryBusy.get(id)?.abort();
    await this.storage.secrets.update((state) => {
      delete state[id];
    });
  }
  async testChannel(id: string): Promise<{ ok: boolean; message: string }> {
    const channel = this.config.channels.find((c) => c.id === id);
    const secret = this.storage.secrets.read()[id];
    if (!channel || !secret || secret.kind !== channel.kind)
      return { ok: false, message: "请先保存渠道和凭据" };
    if (this.deliveryBusy.has(id))
      return { ok: false, message: "该渠道正在发送通知，请稍后测试" };
    const controller = new AbortController();
    this.deliveryBusy.set(id, controller);
    try {
      await this.sender(
        channel,
        secret.values,
        {
          id: randomUUID(),
          kind: "test",
          agentId: "test",
          workspaceId: null,
          provider: "paseo-notifier",
          title: "Paseo 通知连接测试",
          summary: "通知渠道已连通。",
          createdAt: this.now(),
          attempts: 0,
        },
        AbortSignal.any([controller.signal, this.controller.signal]),
      );
      return { ok: true, message: "平台已接受测试通知" };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof DeliveryError ? error.message : "渠道配置无效",
      };
    } finally {
      this.deliveryBusy.delete(id);
      this.wake();
    }
  }
  status(): RuntimeStatus {
    const state = this.storage.state.read();
    const secrets = this.storage.secrets.read();
    return {
      connected: Boolean(this.port),
      settingsError: this.settingsError,
      storageError: this.storageError,
      credentials: Object.entries(secrets).map(([id, s]) => ({
        id,
        kind: s.kind,
        configured: true,
      })),
      recoveries: state.recoveries.slice(-100).reverse().map(cardOf),
      deliveries: state.deliveries
        .slice(-100)
        .reverse()
        .map((d) => ({
          id: d.id,
          channelId: d.channelId,
          title: d.notice.title,
          kind: d.notice.kind,
          phase: d.phase,
          attempts: d.attempts,
          dueAt: d.dueAt,
          error: d.error,
          updatedAt: d.updatedAt,
        })),
    };
  }
  private enqueue(state: State, notice: Notification): void {
    if (!this.config.enabled) return;
    for (const channel of this.config.channels.filter((c) =>
      routes(c, notice),
    )) {
      const id = `${notice.id}:${channel.id}`;
      if (!state.deliveries.some((d) => d.id === id))
        state.deliveries.push({
          id,
          channelId: channel.id,
          channelKind: channel.kind,
          notice,
          phase: "pending",
          attempts: 0,
          dueAt: this.now(),
          updatedAt: this.now(),
          error: null,
        });
    }
  }
  private recoveryNotice(
    r: Recovery,
    kind: Notification["kind"],
    summary: string,
  ): Notification {
    return {
      id: `${r.id}:${kind}`,
      agentId: r.agentId,
      workspaceId: r.workspaceId,
      provider: r.provider,
      title: r.title,
      summary,
      kind,
      failure: r.failure,
      attempts: r.attempts,
      createdAt: this.now(),
    };
  }
  private async publish(r: Recovery): Promise<void> {
    try {
      await this.port?.publish(cardOf(r));
    } catch {
      console.warn(
        "[paseo-notifier] Timeline card unavailable; status remains available in settings.",
      );
    }
  }
  async turnEnded(event: EndEvent): Promise<void> {
    if (
      this.ownedReviewers.has(event.agent.id) ||
      (event.agent.parentAgentId &&
        this.ownedReviewers.has(event.agent.parentAgentId))
    )
      return;
    const key = digest([
      event.agent.id,
      event.turnId,
      event.outcome,
      fingerprint(event.timeline),
    ]);
    if (this.storage.state.read().seen.some((e) => e.key === key)) return;
    if (this.reviewControllers.has(event.agent.id)) this.bump(event.agent.id);
    return this.lane(event.agent.id, async () => {
      if (
        this.closed ||
        !this.config.enabled ||
        (!this.config.includeSubagents && event.agent.parentAgentId)
      )
        return;
      const now = this.now();
      if (this.storage.state.read().seen.some((e) => e.key === key)) return;
      const failure = classify(
        event.outcome,
        finalText(event.timeline),
        currentError(event.timeline),
      );
      let changed: Recovery | undefined;
      await this.storage.state.update((state) => {
        try {
          if (state.seen.some((e) => e.key === key)) return;
          state.seen.push({ key, at: now });
          const previous = state.recoveries.findLast(
            (r) => r.agentId === event.agent.id,
          );
          const userKey = userIdentity(event.timeline);
          const sameUser =
            previous &&
            userKey !== null &&
            (userKey === previous.messageId || userKey === previous.userKey);
          const continuation =
            previous &&
            sameUser &&
            (["running", "dispatching"].includes(previous.phase) ||
              (previous.phase === "paused" && userKey === previous.messageId));
          const suppressed =
            previous &&
            sameUser &&
            !active(previous) &&
            !continuation &&
            previous.phase !== "done";
          if (previous && active(previous) && !continuation) {
            previous.phase = "canceled";
            previous.dueAt = null;
            previous.reason = "会话已发生变化";
            previous.updatedAt = now;
          }
          if (event.outcome.kind === "canceled") {
            if (previous && (active(previous) || sameUser)) {
              previous.phase = "canceled";
              previous.dueAt = null;
              previous.reason = "任务已被取消";
              previous.updatedAt = now;
              changed = previous;
            }
            return;
          }
          const base = {
            agentId: event.agent.id,
            workspaceId: event.agent.workspaceId,
            provider: event.agent.provider,
            title: (event.agent.title ?? event.agent.id).slice(0, 200),
            createdAt: now,
          };
          const preview = this.config.notifications.includePreview
            ? Array.from(finalText(event.timeline))
                .slice(0, this.config.notifications.previewCharacters)
                .join("")
            : "";
          if (!failure) {
            if (previous && continuation) {
              previous.phase = "done";
              previous.reason = "任务已恢复并完成";
              previous.dueAt = null;
              previous.updatedAt = now;
              changed = previous;
            }
            this.enqueue(state, {
              ...base,
              id: key,
              kind: continuation ? "recovered" : "completed",
              summary: "请在 Paseo 查看任务结果。",
              ...(preview ? { preview } : {}),
              attempts: continuation ? previous!.attempts : 0,
            });
            return;
          }
          if (suppressed) {
            this.enqueue(state, {
              ...base,
              id: key,
              kind: failure.kind === "policy_blocked" ? "blocked" : "failed",
              summary: `${failureLabels[failure.kind]}；此前的自动恢复已停止`,
              failure: failure.kind,
              attempts: previous!.attempts,
            });
            return;
          }
          const r: Recovery = continuation
            ? previous!
            : {
                id: randomUUID(),
                ...base,
                phase: "waiting",
                reason: "",
                failure: failure.kind,
                attempts: 0,
                dueAt: null,
                updatedAt: now,
                startedAt: now,
                fingerprint: "",
                userKey,
                messageId: null,
                sessionId: null,
                lastUserMessageAt: null,
                reviews: [],
              };
          if (!continuation) state.recoveries.push(r);
          r.failure = failure.kind;
          r.fingerprint = fingerprint(event.timeline);
          r.userKey = userKey;
          r.updatedAt = now;
          const next = nextRetry({
            failure,
            attempts: r.attempts,
            startedAt: r.startedAt,
            now,
            config: this.config,
            random: this.random(),
          });
          if ("dueAt" in next && userKey !== null) {
            r.phase = "waiting";
            r.dueAt = next.dueAt;
            r.reason = failureLabels[failure.kind];
          } else {
            r.phase = "exhausted";
            r.dueAt = null;
            r.reason = `${failureLabels[failure.kind]}：${"stopped" in next ? next.stopped : "无法确定当前用户消息"}`;
            this.enqueue(state, {
              ...base,
              id: key,
              kind: [
                "policy_blocked",
                "quota_exhausted",
                "context_exhausted",
              ].includes(failure.kind)
                ? "blocked"
                : "failed",
              summary: r.reason,
              failure: failure.kind,
              attempts: r.attempts,
            });
          }
          changed = r;
        } finally {
          prune(state, now, this.config.notifications.retentionDays);
        }
      });
      if (changed) await this.publish(changed);
      this.wake();
    });
  }
  async turnStarted(agentId: string): Promise<void> {
    if (this.ownedReviewers.has(agentId)) return;
    this.bump(agentId);
    return this.lane(agentId, async () => {
      const r = this.storage.state
        .read()
        .recoveries.findLast(
          (item) => item.agentId === agentId && active(item),
        );
      if (!r) return;
      if (["waiting", "reviewing"].includes(r.phase)) {
        await this.stopRecovery(r.id, "会话开始了新的执行，已取消旧恢复计划");
        return;
      }
      if (this.port) {
        try {
          const view = await this.port.inspect(agentId);
          const key = userIdentity(view.items);
          if (key !== r.messageId && key !== r.userKey)
            await this.stopRecovery(r.id, "用户已接手会话");
        } catch {
          await this.stopRecovery(r.id, "无法核对新一轮执行，已停止自动恢复");
        }
      }
    });
  }
  agentCreated(agentId: string): void {
    if (!this.ownedReviewers.has(agentId)) return;
    const r = this.storage.state
      .read()
      .recoveries.find((row) =>
        row.reviews.some((review) => review.agentId === agentId),
      );
    const review = r?.reviews.find((item) => item.agentId === agentId);
    if (
      r &&
      review?.status === "pending" &&
      this.reviewControllers.has(r.agentId) &&
      !this.reviewControllers.get(r.agentId)!.signal.aborted
    )
      return;
    // A daemon creation may finish after a local timeout or process restart.
    this.background(
      (async () => {
        await this.storage.state.update((state) => {
          for (const r of state.recoveries) {
            const review = r.reviews.find((item) => item.agentId === agentId);
            if (review) review.cleanupPending = true;
          }
        });
        await this.cleanupReviewer(agentId);
      })(),
    );
  }
  async cancelAgent(agentId: string, reason: string): Promise<void> {
    this.bump(agentId);
    return this.lane(agentId, async () => {
      for (const r of this.storage.state
        .read()
        .recoveries.filter((r) => r.agentId === agentId && active(r)))
        await this.stopRecovery(r.id, reason);
    });
  }
  async cancelWorkspace(workspaceId: string): Promise<void> {
    const ids = new Set(
      this.storage.state
        .read()
        .recoveries.filter((r) => r.workspaceId === workspaceId && active(r))
        .map((r) => r.agentId),
    );
    await Promise.all(
      [...ids].map((id) => this.cancelAgent(id, "工作区已归档")),
    );
  }
  async permission(agent: PluginHookAgent, requestId: string): Promise<void> {
    if (
      this.ownedReviewers.has(agent.id) ||
      (agent.parentAgentId && this.ownedReviewers.has(agent.parentAgentId))
    )
      return;
    await this.cancelAgent(agent.id, "等待权限确认");
    if (
      !this.config.enabled ||
      (!this.config.includeSubagents && agent.parentAgentId)
    )
      return;
    await this.storage.state.update((state) => {
      const key = `permission:${agent.id}:${requestId}`;
      if (state.seen.some((e) => e.key === key)) return;
      state.seen.push({ key, at: this.now() });
      this.enqueue(state, {
        id: key,
        kind: "permission",
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        provider: agent.provider,
        title: (agent.title ?? agent.id).slice(0, 200),
        summary: "任务正在等待权限确认，请在 Paseo 中处理。",
        createdAt: this.now(),
        attempts: 0,
      });
      prune(state, this.now(), this.config.notifications.retentionDays);
    });
    this.wake();
  }
  private async stopRecovery(
    id: string,
    reason: string,
    phase: Recovery["phase"] = "canceled",
  ): Promise<boolean> {
    let changed: Recovery | undefined;
    await this.storage.state.update((state) => {
      const r = state.recoveries.find((r) => r.id === id);
      if (!r || !active(r)) return;
      r.phase = phase;
      r.reason = reason;
      r.dueAt = null;
      r.updatedAt = this.now();
      changed = r;
      if (phase === "paused" || phase === "exhausted")
        this.enqueue(state, this.recoveryNotice(r, "failed", reason));
    });
    if (changed) await this.publish(changed);
    return Boolean(changed);
  }
  async cancelRecovery(id: string): Promise<boolean> {
    const r = this.storage.state.read().recoveries.find((r) => r.id === id);
    if (!r || !active(r)) return false;
    this.bump(r.agentId);
    return this.lane(r.agentId, async () => {
      const changed = await this.stopRecovery(id, "用户已取消后续自动恢复");
      return (
        changed ||
        this.storage.state.read().recoveries.find((item) => item.id === id)
          ?.phase === "canceled"
      );
    });
  }
  async retryDelivery(id: string): Promise<boolean> {
    const ok = await this.storage.state.update((state) => {
      const d = state.deliveries.find((d) => d.id === id);
      if (
        !d ||
        d.phase !== "failed" ||
        !this.config.enabled ||
        !this.config.channels.some(
          (c) =>
            c.id === d.channelId &&
            c.kind === d.channelKind &&
            routes(c, d.notice),
        )
      )
        return false;
      d.phase = "pending";
      d.attempts = 0;
      d.error = null;
      d.dueAt = this.now();
      d.updatedAt = this.now();
      return true;
    });
    this.wake();
    return ok;
  }
  private wake(): void {
    clearTimeout(this.timer);
    if (
      this.closed ||
      !this.config.enabled ||
      this.storageError ||
      this.settingsError
    )
      return;
    const state = this.storage.state.read();
    const times = [
      ...state.recoveries
        .filter(
          (r) =>
            this.port &&
            r.phase === "waiting" &&
            !this.recoveryBusy.has(r.agentId),
        )
        .map((r) => r.dueAt ?? this.now()),
      ...state.deliveries
        .filter(
          (d) => d.phase === "pending" && !this.deliveryBusy.has(d.channelId),
        )
        .map((d) => d.dueAt),
    ];
    if (!times.length) return;
    this.timer = setTimeout(
      () => this.tick(),
      Math.min(2_147_483_647, Math.max(1, Math.min(...times) - this.now())),
    );
  }
  private tick(): void {
    if (
      this.closed ||
      !this.config.enabled ||
      this.storageError ||
      this.settingsError
    )
      return;
    const state = this.storage.state.read();
    for (const r of state.recoveries) {
      if (
        this.port &&
        r.phase === "waiting" &&
        (r.dueAt ?? 0) <= this.now() &&
        !this.recoveryBusy.has(r.agentId)
      ) {
        this.recoveryBusy.add(r.agentId);
        this.background(
          this.lane(r.agentId, () => this.recover(r.id)).finally(() =>
            this.recoveryBusy.delete(r.agentId),
          ),
        );
      }
    }
    for (const d of state.deliveries) {
      if (
        d.phase === "pending" &&
        d.dueAt <= this.now() &&
        !this.deliveryBusy.has(d.channelId)
      ) {
        const controller = new AbortController();
        this.deliveryBusy.set(d.channelId, controller);
        this.background(
          this.sendDelivery(d.id, controller.signal).finally(() =>
            this.deliveryBusy.delete(d.channelId),
          ),
        );
      }
    }
    this.wake();
  }
  private async recover(id: string): Promise<void> {
    const r = this.storage.state.read().recoveries.find((r) => r.id === id);
    if (
      !r ||
      r.phase !== "waiting" ||
      !this.port ||
      !this.config.enabled ||
      !this.config.recovery.enabled ||
      this.closed
    )
      return;
    if (
      r.attempts >= this.config.recovery.maxAttempts ||
      this.now() >=
        r.startedAt + this.config.recovery.maxElapsedMinutes * 60_000
    ) {
      await this.stopRecovery(id, "自动恢复预算已用尽", "exhausted");
      return;
    }
    const generation = this.generations.get(r.agentId);
    let view;
    try {
      view = await this.port.inspect(r.agentId);
    } catch {
      await this.stopRecovery(id, "无法核对会话状态，已暂停自动恢复", "paused");
      return;
    }
    if (this.closed) return;
    if (
      !view.available ||
      !view.idle ||
      fingerprint(view.items) !== r.fingerprint ||
      this.generations.get(r.agentId) !== generation ||
      (r.sessionId && r.sessionId !== view.sessionId)
    ) {
      await this.stopRecovery(id, "会话内容或状态已改变，已取消旧恢复计划");
      return;
    }
    let reviewedTimeline: string | null = null;
    if (this.config.recovery.review.enabled) {
      if (this.reviewControllers.size >= 2) {
        await this.storage.state.update((state) => {
          const row = state.recoveries.find((item) => item.id === id)!;
          if (row.phase === "waiting") row.dueAt = this.now() + 1000;
        });
        return;
      }
      if (!(await this.reviewRecovery(r, view.items, generation))) return;
      reviewedTimeline = digest(
        view.items.filter((item) => item.type !== "plugin"),
      );
    }
    const messageId = randomUUID();
    await this.storage.state.update((state) => {
      const current = state.recoveries.find((item) => item.id === id)!;
      if (!["waiting", "reviewing"].includes(current.phase)) return;
      current.phase = "dispatching";
      current.attempts++;
      current.messageId = messageId;
      current.sessionId = view.sessionId;
      current.lastUserMessageAt = view.lastUserMessageAt;
      current.updatedAt = this.now();
      current.dueAt = null;
    });
    // Recheck after the durable intent write, which can yield to user activity.
    let check;
    try {
      check = await this.port.inspect(r.agentId);
    } catch {
      await this.stopRecovery(id, "发送前无法核对会话，已暂停", "paused");
      return;
    }
    const current = this.storage.state
      .read()
      .recoveries.find((item) => item.id === id);
    if (this.closed) return;
    if (
      !this.config.enabled ||
      !this.config.recovery.enabled ||
      current?.phase !== "dispatching" ||
      current.attempts > this.config.recovery.maxAttempts ||
      this.now() >=
        r.startedAt + this.config.recovery.maxElapsedMinutes * 60_000 ||
      this.generations.get(r.agentId) !== generation ||
      !check.available ||
      !check.idle ||
      check.sessionId !== view.sessionId ||
      check.lastUserMessageAt !== view.lastUserMessageAt ||
      fingerprint(check.items) !== r.fingerprint ||
      (reviewedTimeline !== null &&
        reviewedTimeline !==
          digest(check.items.filter((item) => item.type !== "plugin")))
    ) {
      await this.stopRecovery(id, "用户操作或配置变更，已取消发送");
      return;
    }
    try {
      await this.port.send(r.agentId, this.config.recovery.prompt, messageId);
    } catch {
      await this.stopRecovery(
        id,
        "继续指令的发送结果未确认，请检查会话；不会自动重复发送",
        "paused",
      );
      return;
    }
    let changed: Recovery | undefined;
    await this.storage.state.update((state) => {
      const latest = state.recoveries.find((item) => item.id === id)!;
      if (latest.phase === "dispatching") {
        latest.phase = "running";
        latest.reason = "已提交继续指令，等待执行结果";
        latest.updatedAt = this.now();
        changed = latest;
      }
    });
    if (changed) await this.publish(changed);
  }
  private async cleanupReviewer(agentId: string): Promise<boolean> {
    if (!this.port?.archiveReviewer) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await abortable(this.port.archiveReviewer(agentId), controller.signal);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
    await this.storage.state.update((state) => {
      for (const r of state.recoveries) {
        const review = r.reviews.find((item) => item.agentId === agentId);
        if (review) review.cleanupPending = false;
      }
    });
    return true;
  }
  private async reviewRecovery(
    r: Recovery,
    items: readonly AgentTimelineItem[],
    generation: number | undefined,
  ): Promise<boolean> {
    const config = structuredClone(this.config.recovery.review);
    if (r.reviews.length >= config.maxReviews) {
      await this.stopRecovery(
        r.id,
        "AI 复核次数已用尽，已暂停自动继续",
        "exhausted",
      );
      return false;
    }
    if (!this.port?.review || !this.port.archiveReviewer) {
      await this.stopRecovery(
        r.id,
        "宿主复核接口不可用，已暂停自动继续",
        "paused",
      );
      return false;
    }
    const controller = new AbortController();
    this.reviewControllers.set(r.agentId, controller);
    const agentId = randomUUID();
    const signal = AbortSignal.any([controller.signal, this.controller.signal]);
    const remaining =
      r.startedAt +
      this.config.recovery.maxElapsedMinutes * 60_000 -
      this.now();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(config.timeoutSeconds * 1000, remaining)),
    );
    try {
      await this.storage.state.update((state) => {
        const current = state.recoveries.find((item) => item.id === r.id)!;
        if (current.phase !== "waiting") return;
        current.phase = "reviewing";
        current.reason = "正在由独立 AI 判断是否继续";
        current.dueAt = null;
        current.updatedAt = this.now();
        current.reviews.push({
          agentId,
          status: "pending",
          reason: "等待结论",
          createdAt: this.now(),
          cleanupPending: true,
        });
      });
      this.ownedReviewers.add(agentId);
      const current = this.storage.state
        .read()
        .recoveries.find((item) => item.id === r.id)!;
      if (
        current.phase !== "reviewing" ||
        signal.aborted ||
        this.generations.get(r.agentId) !== generation
      ) {
        await this.storage.state.update((state) => {
          const review = state.recoveries
            .find((item) => item.id === r.id)
            ?.reviews.find((item) => item.agentId === agentId);
          if (review) {
            review.status = "error";
            review.reason = "复核启动前已取消";
            review.cleanupPending = false;
          }
        });
        await this.stopRecovery(r.id, "会话或配置已变更，已取消复核");
        return false;
      }
      await this.publish(current);
      let decision: ReviewDecision | undefined;
      try {
        signal.throwIfAborted();
        decision = await abortable(
          this.port.review(
            {
              agentId,
              parentAgentId: r.agentId,
              config,
              prompt: reviewPrompt({
                title: r.title,
                failure: r.failure,
                attempts: r.attempts,
                continuation: this.config.recovery.prompt,
                items,
                limit: config.contextCharacters,
              }),
            },
            signal,
          ),
          signal,
        );
      } catch {
        /* Untrusted provider errors may contain request content or credentials. */
      }
      // Cleanup precedes any continuation, including when the reviewer timed out.
      const cleaned = await this.cleanupReviewer(agentId);
      const invalidated =
        this.closed || this.generations.get(r.agentId) !== generation;
      await this.storage.state.update((state) => {
        const current = state.recoveries.find((item) => item.id === r.id)!;
        const review = current.reviews.find(
          (item) => item.agentId === agentId,
        )!;
        review.status =
          invalidated || signal.aborted
            ? "error"
            : (decision?.decision ?? "error");
        review.reason = invalidated
          ? "会话或配置已变更，结论作废"
          : signal.aborted
            ? "复核已取消或超时"
            : (decision?.reason ?? "复核未完成、超时或结论无效");
        current.updatedAt = this.now();
      });
      if (invalidated) {
        await this.stopRecovery(r.id, "会话或配置已变更，已取消复核");
        return false;
      }
      if (!cleaned || !decision || signal.aborted) {
        await this.stopRecovery(
          r.id,
          cleaned
            ? "AI 复核未完成、超时或结论无效，已暂停自动继续"
            : "无法确认审查会话已停止，请在 Paseo 检查",
          "paused",
        );
        return false;
      }
      if (decision.decision !== "continue") {
        await this.stopRecovery(
          r.id,
          decision.decision === "stop"
            ? "AI 复核建议停止自动继续"
            : "AI 复核认为需要人工处理",
          "paused",
        );
        return false;
      }
      return true;
    } finally {
      clearTimeout(timer);
      this.reviewControllers.delete(r.agentId);
    }
  }
  private async sendDelivery(id: string, signal: AbortSignal): Promise<void> {
    const d = this.storage.state.read().deliveries.find((d) => d.id === id);
    if (!d || d.phase !== "pending" || this.closed || !this.config.enabled)
      return;
    const channel = this.config.channels.find(
      (c) => c.id === d.channelId && c.kind === d.channelKind,
    );
    const secret = this.storage.secrets.read()[d.channelId];
    if (d.attempts >= this.config.notifications.maxAttempts) {
      await this.storage.state.update((state) => {
        const row = state.deliveries.find((item) => item.id === id)!;
        row.phase = "failed";
        row.error = "通知发送次数已用尽（包含重启前的尝试）";
        row.updatedAt = this.now();
      });
      return;
    }
    if (!channel || !routes(channel, d.notice)) {
      await this.storage.state.update((state) => {
        const row = state.deliveries.find((item) => item.id === id)!;
        row.phase = "canceled";
        row.updatedAt = this.now();
      });
      return;
    }
    let error: DeliveryError | undefined;
    await this.storage.state.update((state) => {
      const row = state.deliveries.find((item) => item.id === id)!;
      row.attempts++;
      row.updatedAt = this.now();
    });
    try {
      if (!secret || secret.kind !== channel.kind)
        throw new DeliveryError("此渠道尚未配置凭据", false);
      await this.sender(
        channel,
        secret.values,
        d.notice,
        AbortSignal.any([signal, this.controller.signal]),
      );
    } catch (e) {
      error =
        e instanceof DeliveryError
          ? e
          : new DeliveryError("渠道配置无效", false);
    }
    if (this.closed) return; // Leave uncertain requests pending for at-least-once notification delivery.
    await this.storage.state.update((state) => {
      const row = state.deliveries.find((item) => item.id === id)!;
      if (row.phase !== "pending") return;
      row.updatedAt = this.now();
      if (!error) {
        row.phase = "sent";
        row.error = null;
      } else {
        row.error = error.message;
        row.phase =
          error.retryable &&
          row.attempts < this.config.notifications.maxAttempts
            ? "pending"
            : "failed";
        row.dueAt =
          this.now() +
          Math.max(
            error.retryAfterMs,
            Math.min(300_000, 2000 * 2 ** (row.attempts - 1)) *
              (0.75 + this.random() * 0.25),
          );
      }
      const spacing = channelSpacing(channel.kind);
      const nextAt = this.now() + Math.max(spacing, error?.retryAfterMs ?? 0);
      for (const other of state.deliveries)
        if (other.channelId === d.channelId && other.phase === "pending")
          other.dueAt = Math.max(other.dueAt, nextAt);
      prune(state, this.now(), this.config.notifications.retentionDays);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    await Promise.allSettled([...this.jobs, ...this.lanes.values()]);
    await this.storage.close();
  }
}
