import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSchedules, resolveAgentSchedule } from "../server/schedules";
import type { PaseoApi } from "../server/types";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "notifier-schedules-"));
  directories.push(value);
  return value;
}
describe("read-only schedule metadata", () => {
  it("lists new-agent tasks without prompts, run output, secrets, or heartbeat targets", async () => {
    const root = await directory();
    await mkdir(join(root, "schedules"));
    const schedule = {
      id: "daily",
      name: "Daily",
      status: "active",
      cadence: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      target: {
        type: "new-agent",
        config: { cwd: "/project", mcpServers: { private: "secret" } },
      },
      prompt: "private prompt",
      runs: [{ output: "private output" }],
    };
    const original = JSON.stringify(schedule);
    await writeFile(join(root, "schedules", "daily.json"), original);
    await writeFile(
      join(root, "schedules", "heartbeat.json"),
      JSON.stringify({
        ...schedule,
        id: "heartbeat",
        target: { type: "agent", agentId: "one" },
      }),
    );
    await writeFile(
      join(root, "schedules", "broken.json"),
      "invalid private text",
    );
    await symlink(
      join(root, "schedules", "daily.json"),
      join(root, "schedules", "link.json"),
    );
    const result = await listSchedules(root);
    expect(result).toEqual({
      unreadable: 1,
      schedules: [
        {
          id: "daily",
          name: "Daily",
          status: "active",
          cadence: "0 9 * * 1-5",
          timezone: "Asia/Shanghai",
          cwd: "/project",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("handles an empty host without creating a schedule store", async () => {
    expect(await listSchedules(await directory())).toEqual({
      schedules: [],
      unreadable: 0,
    });
  });
  it("resolves task identity through the public agent API and rejects unavailable snapshots", async () => {
    const refresh = vi.fn(
      async (): Promise<unknown> => ({
        agent: { labels: { "paseo.schedule-id": "daily" } },
      }),
    );
    const paseo = {
      agents: { ref: vi.fn(() => ({ refresh })) },
    } as unknown as PaseoApi;
    expect(await resolveAgentSchedule(paseo, "agent-a")).toBe("daily");
    refresh.mockResolvedValue({ agent: { labels: {} } });
    expect(await resolveAgentSchedule(paseo, "ordinary")).toBeNull();
    refresh.mockResolvedValue(null);
    await expect(resolveAgentSchedule(paseo, "missing")).rejects.toThrow(
      "无法核对",
    );
  });
});
