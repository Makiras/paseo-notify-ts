import type { Channel, Config } from "./config";
import type { Notification } from "./contracts";

export type RouteContext = {
  workspaceId?: string | null;
  agentId?: string | null;
};
export type ResolvedRoute = {
  source: "host" | "workspace" | "session";
  channelIds: string[];
};

export function resolveRoute(
  config: Config,
  context: RouteContext,
): ResolvedRoute {
  const { routing } = config;
  if (context.agentId && Object.hasOwn(routing.sessions, context.agentId))
    return {
      source: "session",
      channelIds: [...routing.sessions[context.agentId]!],
    };
  if (
    context.workspaceId &&
    Object.hasOwn(routing.workspaces, context.workspaceId)
  )
    return {
      source: "workspace",
      channelIds: [...routing.workspaces[context.workspaceId]!],
    };
  return { source: "host", channelIds: [...routing.host] };
}

export function channelAllows(channel: Channel, notice: Notification): boolean {
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

export function notificationChannels(
  config: Config,
  notice: Notification,
): Channel[] {
  const selected = new Set(resolveRoute(config, notice).channelIds);
  return config.channels.filter(
    (c) => selected.has(c.id) && channelAllows(c, notice),
  );
}

export function withoutChannel(config: Config, id: string): Config {
  const next = structuredClone(config);
  next.channels = next.channels.filter((c) => c.id !== id);
  const remove = (ids: string[]) => ids.filter((value) => value !== id);
  next.routing.host = remove(next.routing.host);
  for (const selections of [next.routing.workspaces, next.routing.sessions])
    for (const key of Object.keys(selections))
      selections[key] = remove(selections[key]!);
  return next;
}

export function routeLabel(config: Config, context: RouteContext): string {
  const route = resolveRoute(config, context);
  const source = { host: "Host", workspace: "Workspace", session: "Session" }[
    route.source
  ];
  const names = route.channelIds.map(
    (id) => config.channels.find((c) => c.id === id)?.name ?? id,
  );
  return `${names.join("、") || "关闭通知"} · ${source}`;
}
