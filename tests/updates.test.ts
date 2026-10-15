import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Updates, officialInstallation } from "../server/updates";
import { updateRunner } from "../server/update-runner";
import { newerVersion, stableVersion, pluginVersion } from "../shared/version";
import { defaultConfig, migrateSettings } from "../shared/config";
import type { PaseoApi } from "../server/types";

const installation = {
  identity: {
    kind: "git",
    remote: "https://github.com/Makiras/paseo-notify-ts.git",
    pluginPath: ".",
  },
  currentRevision: "a".repeat(40),
};
const preview = {
  id: "paseo-notifier",
  outcome: "update",
  current: installation,
  target: { kind: "git", commit: "b".repeat(40) },
};
const futureTag = `v${Number(pluginVersion.split(".")[0]) + 1}.0.0`;
const release = {
  id: 42,
  tag_name: futureTag,
  draft: false,
  prerelease: false,
  published_at: "2026-10-15T00:00:00Z",
};
const services: Updates[] = [];
function fixture() {
  let now = 1000000;
  const deps = {
    fetch: vi.fn(
      async (_url: string, _init: unknown) =>
        new Response(JSON.stringify(release), {
          headers: { etag: '"release-42"' },
        }),
    ),
    now: () => now,
    findCli: vi.fn(async () => "/usr/bin/paseo"),
    cli: vi.fn(
      async (_cli: string, args: string[]): Promise<unknown> =>
        args[1] === "status"
          ? [{ id: "paseo-notifier", installation }]
          : [preview],
    ),
  };
  const service = new Updates("/home/test/.paseo", deps);
  services.push(service);
  const create = vi.fn(async () => ({ id: "terminal-update" }));
  const paseo = {
    workspaces: {
      ref: vi.fn(() => ({
        refresh: vi.fn(async () => ({
          id: "workspace-a",
          name: "A",
          archivingAt: null,
        })),
      })),
    },
    terminals: {
      create,
      list: vi.fn(async () => ({ entries: [], requestId: "list" })),
      ref: vi.fn(() => ({
        capture: vi.fn(async () => ({ lines: ["Working..."] })),
      })),
    },
  } as unknown as PaseoApi;
  return {
    service,
    deps,
    paseo,
    create,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("release checks", () => {
  it("compares stable numeric versions without treating prereleases or older releases as updates", () => {
    expect(newerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(newerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(newerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(newerVersion("0.1.9", "0.2.0")).toBe(false);
    expect(stableVersion("v01.2.3")).toBeNull();
    expect(stableVersion("v1.2.3-rc.1")).toBeNull();
    expect(stableVersion("v1.2.3; echo x")).toBeNull();
  });
  it("migrates existing Host defaults and gives old documents the update preference", () => {
    const { updates: _updates, ...old } = defaultConfig();
    expect(migrateSettings(old, 3).updates.checkAutomatically).toBe(true);
    expect(migrateSettings(old, 3).routing).toEqual(old.routing);
  });
  it("shares concurrent requests, caches successful results, and revalidates with ETag", async () => {
    const { service, deps, advance } = fixture();
    const statuses = await Promise.all([
      service.check(false, true),
      service.check(false, true),
    ]);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(statuses[0]).toMatchObject({
      available: true,
      canInstall: true,
      release: { tag: futureTag },
    });
    advance(100000);
    await service.check(false, true);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    deps.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const next = await service.check(true, false);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.fetch.mock.calls[1]?.[1]).toMatchObject({
      headers: { "If-None-Match": '"release-42"' },
    });
    expect(next.release?.id).toBe(42);
  });
  it("does not contact GitHub when automatic checks are disabled; manual check still works", async () => {
    const { service, deps } = fixture();
    expect((await service.check(false, false)).checkedAt).toBeNull();
    expect(deps.fetch).not.toHaveBeenCalled();
    await service.check(true, false);
    await service.check(true, false);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
  it("handles an unpublished repository and caches failures without enabling stale installation", async () => {
    const { service, deps, advance } = fixture();
    deps.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await service.check(true, true)).toMatchObject({
      release: null,
      available: false,
      error: null,
    });
    advance(60000);
    await service.check(true, false);
    advance(60000);
    deps.fetch.mockRejectedValueOnce(new Error("sensitive proxy detail"));
    const failed = await service.check(true, false);
    expect(failed.release?.id).toBe(42);
    expect(failed.canInstall).toBe(false);
    expect(failed.error).not.toContain("sensitive");
    advance(60000);
    await service.check(false, true);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });
  it.each([
    { ...release, prerelease: true },
    { ...release, draft: true },
    { ...release, tag_name: "v0.3.0-rc.1" },
    { ...release, tag_name: "v0.3.0;rm" },
  ])("rejects malformed or non-stable releases", async (data) => {
    const { service, deps } = fixture();
    deps.fetch.mockResolvedValueOnce(new Response(JSON.stringify(data)));
    expect(await service.check(true, true)).toMatchObject({
      available: false,
      canInstall: false,
      release: null,
    });
  });
  it("limits response bodies and keeps release checks usable when CLI is absent", async () => {
    const { service, deps } = fixture();
    deps.findCli.mockResolvedValueOnce(null as unknown as string);
    deps.fetch.mockResolvedValueOnce(new Response("x".repeat(128 * 1024 + 1)));
    expect((await service.check(true, true)).error).toBeTruthy();
  });
});

describe("manual installation", () => {
  it("rejects directories, other repositories, credentialed URLs, registry pins and nested plugins", () => {
    expect(officialInstallation(installation)).toEqual(installation);
    for (const identity of [
      { kind: "directory", path: "/tmp" },
      {
        ...installation.identity,
        remote: "https://github.com/someone/other.git",
      },
      {
        ...installation.identity,
        remote: "https://token@github.com/Makiras/paseo-notify-ts.git",
      },
      { ...installation.identity, registry: {} },
      { ...installation.identity, pluginPath: "other" },
    ])
      expect(officialInstallation({ ...installation, identity })).toBeNull();
  });
  it("pins the reviewed commit and starts a Host-owned terminal without a shell", async () => {
    const { service, deps, paseo, create } = fixture();
    await service.check(true, true);
    await service.install(paseo, {
      releaseId: 42,
      tag: futureTag,
      workspaceId: "workspace-a",
    });
    expect(deps.cli).toHaveBeenCalledWith("/usr/bin/paseo", [
      "plugin",
      "update",
      "paseo-notifier",
      "--home",
      "/home/test/.paseo",
      "--ref",
      futureTag,
      "--check",
      "--json",
    ]);
    const options = (
      create.mock.calls[0] as unknown as [
        Parameters<PaseoApi["terminals"]["create"]>[0],
      ]
    )[0];
    expect(options.command).toBe(process.execPath);
    expect(options.args?.[0]).toBe("-e");
    expect(JSON.parse(options.args![2]!)).toMatchObject({
      commit: "b".repeat(40),
      expectedRevision: "a".repeat(40),
      home: "/home/test/.paseo",
    });
    await expect(
      service.install(paseo, {
        releaseId: 42,
        tag: futureTag,
        workspaceId: "workspace-a",
      }),
    ).rejects.toThrow("终端");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("rejects stale releases and an installation changed since reading source status", async () => {
    const { service, deps, paseo, create } = fixture();
    await service.check(true, true);
    await expect(
      service.install(paseo, {
        releaseId: 41,
        tag: futureTag,
        workspaceId: "workspace-a",
      }),
    ).rejects.toThrow();
    deps.cli.mockImplementation(async (_cli, args) =>
      args[1] === "status"
        ? [{ id: "paseo-notifier", installation }]
        : [
            {
              ...preview,
              current: { ...installation, currentRevision: "c".repeat(40) },
            },
          ],
    );
    await expect(
      service.install(paseo, {
        releaseId: 42,
        tag: futureTag,
        workspaceId: "workspace-a",
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("never starts a second installer while the first terminal request is pending", async () => {
    const { service, paseo, create } = fixture();
    let finish!: (value: { id: string }) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = { releaseId: 42, tag: futureTag, workspaceId: "workspace-a" };
    const first = service.install(paseo, input);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await expect(service.install(paseo, input)).rejects.toThrow("正在准备");
    finish({ id: "terminal-update" });
    await first;
  });
  it("detects an installer left running across plugin reload and stops work after unload", async () => {
    const { service, paseo, create } = fixture();
    vi.mocked(paseo.terminals.list).mockResolvedValueOnce({
      entries: [
        {
          id: "previous",
          name: `Notifier update ${futureTag}`,
          workspaceId: "workspace-a",
          cwd: "/tmp",
        },
      ],
      requestId: "list",
    });
    const input = { releaseId: 42, tag: futureTag, workspaceId: "workspace-a" };
    await expect(service.install(paseo, input)).rejects.toThrow("已有更新终端");
    service.close();
    await expect(service.install(paseo, input)).rejects.toThrow("插件已停止");
    expect(create).not.toHaveBeenCalled();
  });
  it("runs the standalone installer with argv inputs and checks semantic success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "notifier-update-test-"));
    try {
      const cli = join(directory, "fake-paseo");
      const log = join(directory, "calls.jsonl");
      await writeFile(
        cli,
        `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(JSON.stringify(process.argv.includes('--check') ? [${JSON.stringify(preview)}] : [{id:'paseo-notifier',outcome:'updated'}]));\n`,
        { mode: 0o700 },
      );
      const input = {
        cli,
        path: process.env.PATH,
        home: "/tmp/a 'quoted' home $(nothing)",
        tag: futureTag,
        commit: "b".repeat(40),
        expectedRevision: "a".repeat(40),
        identity: installation.identity,
      };
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", updateRunner, JSON.stringify(input)],
        { timeout: 15000 },
      );
      expect(result.stdout).toContain("UPDATE SUCCEEDED");
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain(input.home);
      expect(calls[1]).toContain("b".repeat(40));
      expect(calls[1]).not.toContain(futureTag);
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            "-e",
            updateRunner,
            JSON.stringify({ ...input, expectedRevision: "c".repeat(40) }),
          ],
          { timeout: 15000 },
        ),
      ).rejects.toThrow();
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
