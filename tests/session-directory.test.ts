import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionDirectory } from "../server/session-directory";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
const record = (id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") => ({
  id,
  provider: "removed-provider",
  cwd: "/test",
  title: "旧归档",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  lastActivityAt: "2026-10-03T00:00:00Z",
  lastStatus: "closed",
  archivedAt: "2026-10-03T00:00:00Z",
  config: { systemPrompt: "private prompt" },
  persistence: { nativeHandle: "private handle" },
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "notifier-directory-test-"));
  homes.push(home);
  await mkdir(join(home, "agents", "project"), { recursive: true });
  return home;
}
describe("host session registry metadata", () => {
  it("reads root and project records, excludes internal records and secrets, and counts corrupt records", async () => {
    const home = await fixture();
    await writeFile(
      join(home, "agents", "legacy.json"),
      JSON.stringify(record()),
    );
    await writeFile(
      join(home, "agents", "project", "newer.json"),
      JSON.stringify({
        ...record(),
        title: "新名称",
        updatedAt: "2026-10-04T00:00:00Z",
      }),
    );
    await writeFile(
      join(home, "agents", "project", "internal.json"),
      JSON.stringify({
        ...record("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        internal: true,
      }),
    );
    await writeFile(join(home, "agents", "bad.json"), "{");
    const result = await readSessionDirectory(home);
    expect(result.unreadable).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      title: "新名称",
      provider: "removed-provider",
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not follow symlinks or recurse into unrelated directories", async () => {
    const home = await fixture();
    await writeFile(join(home, "outside.json"), JSON.stringify(record()));
    await symlink(
      join(home, "outside.json"),
      join(home, "agents", "linked.json"),
    );
    await mkdir(join(home, "agents", "project", "nested"));
    await writeFile(
      join(home, "agents", "project", "nested", "ignored.json"),
      JSON.stringify(record()),
    );
    expect(await readSessionDirectory(home)).toEqual({
      sessions: [],
      unreadable: 0,
    });
  });
  it("allows an empty new Host", async () => {
    const home = await fixture();
    await rm(join(home, "agents"), { recursive: true });
    expect(await readSessionDirectory(home)).toEqual({
      sessions: [],
      unreadable: 0,
    });
  });
});
