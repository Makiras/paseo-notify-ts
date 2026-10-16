import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { createRecoveryPanel } from "./recovery-routing";
import { createRoutingPanel } from "./routing";

type Target = { id: string; workspaceId: string; agentId: string };
type Page = { pageInfo: { nextCursor: string | null; hasMore: boolean } };
type AgentPage = Awaited<
  ReturnType<PluginClientContext["paseo"]["agents"]["list"]>
>;
type HostSubscription = NonNullable<AgentPage["subscription"]>;
type DirectoryMessage = Parameters<
  Parameters<HostSubscription["subscribe"]>[0]["update"]
>[0];
interface DirectorySubscription<T> {
  subscribe(observer: {
    snapshot(value: T): void;
    update(message: DirectoryMessage): void;
    error?(error: unknown): void;
  }): () => void;
  release(): Promise<void>;
}

// Own one live directory stream and fetch the remaining initial pages. Changes
// received during pagination win over the older bootstrap pages.
export function watchDirectory<T extends Page>(options: {
  load(
    cursor?: string,
    subscribe?: boolean,
    signal?: AbortSignal,
  ): Promise<T & { subscription?: DirectorySubscription<T> }>;
  entries(page: T): Target[];
  change(
    message: DirectoryMessage,
  ): { id: string; value: Target | null } | null;
  apply(targets: Map<string, Target>): void;
}) {
  let disposed = false,
    generation = 0;
  const controller = new AbortController();
  let targets = new Map<string, Target>();
  let changes: Map<string, Target | null> | null = null;
  let subscription: DirectorySubscription<T> | undefined;
  let unsubscribe: (() => void) | undefined;
  async function snapshot(first: T) {
    const epoch = ++generation;
    const delta = new Map<string, Target | null>();
    changes = delta;
    const next = new Map(options.entries(first).map((v) => [v.id, v]));
    let page = first;
    const cursors = new Set<string>();
    try {
      while (
        !disposed &&
        epoch === generation &&
        page.pageInfo.hasMore &&
        page.pageInfo.nextCursor
      ) {
        const cursor = page.pageInfo.nextCursor;
        if (cursors.has(cursor)) throw new Error("Repeated directory cursor");
        cursors.add(cursor);
        page = await options.load(cursor, false, controller.signal);
        for (const value of options.entries(page)) next.set(value.id, value);
      }
      if (disposed || epoch !== generation) return;
      for (const [id, value] of delta)
        value ? next.set(id, value) : next.delete(id);
      changes = null;
      targets = next;
      options.apply(targets);
    } catch {
      if (!disposed && epoch === generation) {
        changes = null;
        // Existing controls remain usable; Command Center also works without a list.
        console.error(
          "[paseo-notifier] Could not refresh notification button directory.",
        );
      }
    }
  }
  void options
    .load(undefined, true, controller.signal)
    .then(async (first) => {
      subscription = first.subscription;
      if (disposed) {
        await subscription?.release();
        return;
      }
      if (!subscription) throw new Error("Directory subscription missing");
      unsubscribe = subscription.subscribe({
        snapshot: (page) => {
          void snapshot(page);
        },
        update: (message) => {
          if (disposed) return;
          const change = options.change(message);
          if (!change) return;
          changes?.set(change.id, change.value);
          change.value
            ? targets.set(change.id, change.value)
            : targets.delete(change.id);
          options.apply(targets);
        },
        error: () => {
          if (!disposed)
            console.error(
              "[paseo-notifier] Notification button subscription interrupted.",
            );
        },
      });
    })
    .catch(() => {
      if (!disposed)
        console.error(
          "[paseo-notifier] Notification button directory unavailable; use Command Center.",
        );
    });
  return async () => {
    disposed = true;
    controller.abort();
    generation++;
    unsubscribe?.();
    await subscription?.release();
  };
}

export function installRoutingButtons(client: PluginClientContext) {
  const RoutingPanel = createRoutingPanel(client);
  const RecoveryPanel = createRecoveryPanel(client);
  const registrations = new Map<
    string,
    { target: Target; buttons: PluginButtonRegistration[] }
  >();
  function render(targets: Map<string, Target>) {
    for (const [key, item] of registrations) {
      const next = targets.get(item.target.id);
      if (!next || next.workspaceId !== item.target.workspaceId) {
        for (const button of item.buttons) button.remove();
        registrations.delete(key);
      }
    }
    for (const target of targets.values()) {
      const key = target.id;
      if (registrations.has(key)) continue;
      const registration = client.addComposerPill({
        id: "notification-routing",
        workspaceId: target.workspaceId,
        agentId: target.agentId,
        button: {
          title: "会话通知设置",
          // Paseo currently requires a text label on composer pills. Keep it
          // constant and short; channel names and inheritance belong inside.
          label: "通知",
          icon: "BellRing",
          behavior: { kind: "popover", Content: RoutingPanel },
        },
      });
      const recovery = client.addComposerPill({
        id: "automatic-recovery",
        workspaceId: target.workspaceId,
        agentId: target.agentId,
        button: {
          title: "会话自动继续设置",
          label: "自动继续",
          icon: "RefreshCw",
          behavior: { kind: "popover", Content: RecoveryPanel },
        },
      });
      registrations.set(key, { target, buttons: [registration, recovery] });
    }
  }
  const agentTarget = (agent: {
    id: string;
    workspaceId?: string | null;
    archivedAt?: string | null;
    labels?: Record<string, string> | null;
  }): Target | null =>
    agent.workspaceId &&
    !agent.archivedAt &&
    agent.labels?.["paseo-notifier"] !== "reviewer"
      ? { id: agent.id, agentId: agent.id, workspaceId: agent.workspaceId }
      : null;
  const stopAgents = watchDirectory<AgentPage>({
    load: (cursor, subscribe, signal) =>
      client.paseo.agents.list({
        scope: "active",
        page: { limit: 200, cursor },
        signal,
        ...(subscribe ? { subscribe: {} } : {}),
      }),
    entries: (page) =>
      page.entries.flatMap(({ agent }) => {
        const target = agentTarget(agent);
        return target ? [target] : [];
      }),
    change: (message) =>
      message.type === "agent_update"
        ? message.payload.kind === "remove"
          ? { id: message.payload.agentId, value: null }
          : {
              id: message.payload.agent.id,
              value: agentTarget(message.payload.agent),
            }
        : null,
    apply: render,
  });
  return async () => {
    for (const { buttons } of registrations.values())
      for (const button of buttons) button.remove();
    registrations.clear();
    await stopAgents();
  };
}
