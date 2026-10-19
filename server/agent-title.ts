import { basename } from "node:path";
import type { PluginHookAgent } from "@getpaseo/plugin/server";

// Lifecycle events can have an empty/stale title even when the stored agent is named.
// Never substitute an internal ID into the user-facing {{title}} placeholder.
export async function notificationTitle(
  agent: PluginHookAgent,
  lookup?: (id: string) => Promise<string | null>,
): Promise<string> {
  const readable = (value: string | null | undefined) => {
    const title = value?.trim();
    return title && title !== agent.id
      ? Array.from(title).slice(0, 200).join("")
      : null;
  };
  const supplied = readable(agent.title);
  if (supplied) return supplied;
  if (lookup) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const title = readable(
        await Promise.race([
          lookup(agent.id),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 1500);
          }),
        ]),
      );
      if (title) return title;
    } catch {
      // A title lookup failure must not suppress the notification or change recovery policy.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const folder = basename(agent.cwd.replace(/\\/g, "/"));
  return Array.from(folder ? `未命名会话 · ${folder}` : "未命名会话")
    .slice(0, 200)
    .join("");
}
