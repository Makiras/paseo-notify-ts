import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../server/storage";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "paseo-notifier-test-"));
  dirs.push(dir);
  return dir;
}
describe("private operation storage", () => {
  it("loads existing records without review fields and preserves their retry budgets", async () => {
    const dir = await directory();
    await writeFile(
      join(dir, "operations.json"),
      JSON.stringify({
        version: 1,
        seen: [],
        deliveries: [],
        recoveries: [
          {
            id: "plan",
            agentId: "a",
            title: "task",
            phase: "waiting",
            reason: "network",
            attempts: 2,
            dueAt: 100,
            updatedAt: 0,
            provider: "codex",
            workspaceId: null,
            failure: "network",
            startedAt: 0,
            fingerprint: "fp",
            userKey: "user",
            messageId: null,
            sessionId: null,
            lastUserMessageAt: null,
          },
        ],
      }),
    );
    const store = await Storage.open(dir);
    expect(store.state.read().recoveries[0]).toMatchObject({
      attempts: 2,
      phase: "waiting",
      reviews: [],
      superseded: false,
      awaitingStart: false,
      turnId: null,
    });
    expect(store.state.read().recoveries[0]).not.toHaveProperty("fingerprint");
    await store.close();
  });
  it("serializes concurrent writes and survives a reopen", async () => {
    const dir = await directory();
    const store = await Storage.open(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.state.update((s) => {
          s.seen.push({ key: String(i), at: i });
        }),
      ),
    );
    await store.close();
    const next = await Storage.open(dir);
    expect(next.state.read().seen).toHaveLength(20);
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "operations.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    await next.close();
  });
  it("does not reset a corrupt journal and releases its owner lock", async () => {
    const dir = await directory();
    await writeFile(join(dir, "operations.json"), "broken");
    await expect(Storage.open(dir)).rejects.toThrow("原文件已保留");
    expect(await readFile(join(dir, "operations.json"), "utf8")).toBe("broken");
    await expect(stat(join(dir, "owner.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses concurrent instances using the same journal", async () => {
    const dir = await directory();
    const store = await Storage.open(dir);
    await expect(Storage.open(dir)).rejects.toThrow("已有 Notifier");
    await store.close();
  });
  it("does not commit a partially mutated transaction that throws", async () => {
    const store = await Storage.open(await directory());
    await expect(
      store.state.update((s) => {
        s.seen.push({ key: "partial", at: 1 });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(store.state.read().seen).toEqual([]);
    await store.close();
  });
  it("allows only one contender to reclaim a stale owner lock", async () => {
    const dir = await directory();
    await writeFile(
      join(dir, "owner.lock"),
      JSON.stringify({ pid: 2147483647, token: "stale" }),
    );
    const results = await Promise.allSettled([
      Storage.open(dir),
      Storage.open(dir),
    ]);
    const acquired = results.filter(
      (r): r is PromiseFulfilledResult<Storage> => r.status === "fulfilled",
    );
    try {
      expect(acquired).toHaveLength(1);
    } finally {
      await Promise.all(acquired.map((r) => r.value.close()));
    }
  });
});
