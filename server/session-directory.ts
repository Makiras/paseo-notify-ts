import { open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sessionId, type SessionInfo } from "../shared/sessions";

// The public plugin directory omits unregistered providers; the native history
// API is not exposed. Read only metadata from the host's existing registry,
// including legacy root files. Never write records or return provider secrets.
const stored = z.object({
  id: sessionId,
  provider: z.string(),
  cwd: z.string(),
  title: z.string().nullable().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastStatus: z.string().default("closed"),
  archivedAt: z.string().nullable().optional(),
  internal: z.boolean().optional(),
});
export async function readSessionDirectory(
  home: string,
): Promise<{ sessions: SessionInfo[]; unreadable: number }> {
  const directory = join(home, "agents");
  let roots;
  try {
    roots = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { sessions: [], unreadable: 0 };
    throw new Error("无法读取 Host 会话目录，请检查目录权限");
  }
  const files: string[] = [],
    sessions = new Map<string, SessionInfo>();
  let unreadable = 0;
  for (const entry of roots) {
    if (entry.isFile() && entry.name.endsWith(".json"))
      files.push(join(directory, entry.name));
    else if (entry.isDirectory()) {
      try {
        for (const file of await readdir(join(directory, entry.name), {
          withFileTypes: true,
        }))
          if (file.isFile() && file.name.endsWith(".json"))
            files.push(join(directory, entry.name, file.name));
      } catch {
        unreadable++;
      }
    }
  }
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, async () => {
      while (index < files.length) {
        const path = files[index++]!;
        try {
          const file = await open(
            path,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
          );
          let value;
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
              throw new Error("Invalid record");
            value = stored.parse(JSON.parse(await file.readFile("utf8")));
          } finally {
            await file.close();
          }
          if (value.internal) continue;
          const times = [
            value.updatedAt,
            value.lastActivityAt,
            value.createdAt,
          ].filter(
            (s): s is string => Boolean(s) && Number.isFinite(Date.parse(s!)),
          );
          if (!times.length) throw new Error("Invalid time");
          const updatedAt = new Date(
            Math.max(...times.map(Date.parse)),
          ).toISOString();
          const previous = sessions.get(value.id);
          if (previous && previous.updatedAt >= updatedAt) continue;
          sessions.set(value.id, {
            id: value.id,
            title: value.title || "未命名会话",
            provider: value.provider,
            cwd: value.cwd,
            workspaceId: value.workspaceId ?? null,
            status: value.lastStatus,
            archivedAt: value.archivedAt ?? null,
            updatedAt,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable++;
        }
      }
    }),
  );
  return { sessions: [...sessions.values()], unreadable };
}
