import { basename } from "node:path";
import { hostname } from "node:os";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { NotificationNames } from "../shared/contracts";

export type NamesLookup = (
  id: string,
  workspaceId: string | null,
) => Promise<Omit<NotificationNames, "hostname">>;

// Explicit fields keep their own layer; only the legacy title has fallbacks.
export async function notificationNames(
  agent: PluginHookAgent,
  lookup?: NamesLookup,
): Promise<NotificationNames & { title: string }> {
  const readable = (value: string | null | undefined) => {
    const title = value?.trim();
    return title && title !== agent.id && title !== agent.workspaceId
      ? Array.from(title).slice(0, 200).join("")
      : undefined;
  };
  let names: NotificationNames = {};
  if (lookup) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      names = await Promise.race([
        lookup(agent.id, agent.workspaceId),
        new Promise<NotificationNames>((resolve) => {
          timer = setTimeout(() => resolve({}), 1500);
        }),
      ]);
    } catch {
      // Name lookup must not suppress notifications or affect recovery policy.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const workspaceName = readable(names.workspaceName);
  const sessionTitle = readable(names.sessionTitle) ?? readable(agent.title);
  const folder = basename(agent.cwd.replace(/\\/g, "/"));
  return {
    hostname: hostname(),
    projectName: readable(names.projectName),
    workspaceName,
    sessionTitle,
    title:
      workspaceName ??
      sessionTitle ??
      Array.from(folder ? `未命名会话 · ${folder}` : "未命名会话")
        .slice(0, 200)
        .join(""),
  };
}
