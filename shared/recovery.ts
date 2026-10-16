import type { Config, RecoveryConfig } from "./config";

export type RecoveryContext = {
  agentId?: string | null;
  workspaceId?: string | null;
};
export function resolveRecovery(
  config: Config,
  context: RecoveryContext,
): {
  source: "host" | "workspace" | "session";
  value: RecoveryConfig;
} {
  const scopes = config.recoveryOverrides;
  if (context.agentId && Object.hasOwn(scopes.sessions, context.agentId))
    return { source: "session", value: scopes.sessions[context.agentId]! };
  if (
    context.workspaceId &&
    Object.hasOwn(scopes.workspaces, context.workspaceId)
  )
    return {
      source: "workspace",
      value: scopes.workspaces[context.workspaceId]!,
    };
  return { source: "host", value: config.recovery };
}
