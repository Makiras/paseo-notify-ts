import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  pluginId,
  pluginRepository,
  pluginVersion,
  newerVersion,
  stableVersion,
} from "../shared/version";
import type { Release, UpdateStatus } from "../shared/updates";
import type { PaseoApi } from "./types";
import { updateRunner } from "./update-runner";

const exec = promisify(execFile);
const successTtl = 6 * 60 * 60 * 1000;
const failureTtl = 5 * 60 * 1000;
const minInterval = 60 * 1000;
const api = `https://api.github.com/repos/${pluginRepository}/releases/latest`;
type UpdateFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<Response>;
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const identitySchema = z.object({
  kind: z.literal("git"),
  remote: z.string(),
  pluginPath: z.string(),
  registry: z.unknown().optional(),
});
const installationSchema = z.object({
  identity: identitySchema,
  currentRevision: sha,
});
type Installation = z.infer<typeof installationSchema>;

export function officialInstallation(value: unknown): Installation | null {
  const parsed = installationSchema.safeParse(value);
  if (!parsed.success) return null;
  const { identity } = parsed.data;
  if (
    identity.registry !== undefined ||
    !["", "."].includes(identity.pluginPath)
  )
    return null;
  const remote = identity.remote.replace(/\.git$/, "").toLowerCase();
  if (
    ![
      `https://github.com/${pluginRepository.toLowerCase()}`,
      `git@github.com:${pluginRepository.toLowerCase()}`,
      `ssh://git@github.com/${pluginRepository.toLowerCase()}`,
    ].includes(remote)
  )
    return null;
  return parsed.data;
}

export async function findPaseoCli(): Promise<string | null> {
  // .cmd launchers require a shell; do not interpret their content here.
  if (process.platform === "win32") return null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "paseo");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}

export async function runCli(cli: string, args: string[]): Promise<unknown> {
  const result = await exec(cli, args, {
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    shell: false,
  });
  return JSON.parse(result.stdout);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 128 * 1024) throw new Error("response too large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class Updates {
  private release: Release | null = null;
  private checkedAt: number | null = null;
  private attemptedAt: number | null = null;
  private nextCheck = 0;
  private etag: string | null = null;
  private error: string | null = null;
  private flight: Promise<void> | null = null;
  private controller = new AbortController();
  private installing = false;
  private job: { terminalId: string; workspaceId: string } | null = null;
  private source: {
    cli: string | null;
    installation: Installation | null;
    hint: string;
  } | null = null;
  private sourceReadAt = 0;
  constructor(
    private home: string,
    private deps = {
      fetch: globalThis.fetch as UpdateFetch,
      now: Date.now,
      findCli: findPaseoCli,
      cli: runCli,
    },
  ) {}
  close() {
    this.controller.abort();
  }
  private async checkRelease(force: boolean) {
    if (this.flight) return this.flight;
    const now = this.deps.now();
    if (
      this.attemptedAt !== null &&
      (now < this.attemptedAt + minInterval || (!force && now < this.nextCheck))
    )
      return;
    this.attemptedAt = now;
    this.flight = (async () => {
      try {
        const response = await this.deps.fetch(api, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `paseo-notify-ts/${pluginVersion}`,
            ...(this.etag ? { "If-None-Match": this.etag } : {}),
          },
          redirect: "error",
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          this.release = null;
          this.etag = null;
        } else if (response.status !== 304) {
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("GitHub request failed");
          }
          const data = z
            .object({
              id: z.number().int().positive(),
              tag_name: z.string(),
              draft: z.literal(false),
              prerelease: z.literal(false),
              published_at: z.string().datetime(),
            })
            .parse(await boundedJson(response));
          const version = stableVersion(data.tag_name);
          if (!version || data.tag_name !== `v${version}`)
            throw new Error("not a stable release");
          this.release = {
            id: data.id,
            tag: data.tag_name,
            version,
            url: `https://github.com/${pluginRepository}/releases/tag/${data.tag_name}`,
            publishedAt: data.published_at,
          };
          this.etag = response.headers.get("etag");
        } else if (this.checkedAt === null)
          throw new Error("unexpected cache response");
        this.error = null;
        this.checkedAt = this.deps.now();
        this.nextCheck = this.checkedAt + successTtl;
      } catch {
        this.error =
          "无法检查正式 Release（网络、GitHub 限流或发布格式异常）；通知与恢复不受影响。";
        this.nextCheck = this.deps.now() + failureTtl;
      }
    })().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }
  private async readSource(force = false) {
    if (
      !force &&
      this.source &&
      this.deps.now() - this.sourceReadAt < minInterval
    )
      return this.source;
    const cli = await this.deps.findCli();
    let installation: Installation | null = null;
    if (cli) {
      try {
        const items = await this.deps.cli(cli, [
          "plugin",
          "status",
          pluginId,
          "--home",
          this.home,
          "--json",
        ]);
        if (
          Array.isArray(items) &&
          items.length === 1 &&
          items[0]?.id === pluginId
        )
          installation = officialInstallation(items[0].installation);
      } catch {
        /* Missing/incompatible CLI or daemon: keep checking releases. */
      }
    }
    this.sourceReadAt = this.deps.now();
    return (this.source = {
      cli,
      installation,
      hint: installation
        ? "在所选工作区的终端中运行官方 CLI；只更新当前 Host 的本插件。"
        : cli
          ? "页面安装仅支持以默认 ID 从本仓库直接 Git 安装的插件。目录、npm、Registry 或无法确认来源时，请按安装说明更新。"
          : "Host 未找到可直接执行的 Paseo CLI；请在 Host 终端按安装说明更新。",
    });
  }
  async check(force: boolean, automatic: boolean): Promise<UpdateStatus> {
    const [source] = await Promise.all([
      this.readSource(force),
      force || automatic ? this.checkRelease(force) : Promise.resolve(),
    ]);
    const available =
      !!this.release && newerVersion(this.release.version, pluginVersion);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      currentVersion: pluginVersion,
      currentRevision: source.installation?.currentRevision ?? null,
      release: this.release,
      checkedAt: this.checkedAt,
      error: this.error,
      available,
      canInstall: !!source.installation && available && !this.error,
      installHint: source.hint,
      command:
        this.release && source.installation
          ? `paseo plugin update ${pluginId} --ref ${this.release.tag} --home ${quote(this.home)}`
          : null,
    };
  }
  async install(
    paseo: PaseoApi,
    input: { releaseId: number; tag: string; workspaceId: string },
  ) {
    if (this.controller.signal.aborted) throw new Error("插件已停止");
    if (this.installing) throw new Error("更新安装正在准备，请勿重复提交");
    this.installing = true;
    try {
      if (this.job) {
        const output = await paseo.terminals
          .ref(this.job.terminalId)
          .capture({ start: -30, stripAnsi: true });
        if (
          !output.lines.some((line) =>
            line.includes("PASEO_NOTIFIER_UPDATE_DONE"),
          )
        )
          throw new Error("更新终端仍在运行或回执不确定，请先检查该工作区终端");
        this.job = null;
      }
      // A terminal outlives a plugin reload. Check host-owned terminals as well
      // as the in-memory guard before starting another installer.
      const terminals = await paseo.terminals.list();
      const installers = terminals.entries.filter((entry) =>
        /^Notifier update v\d+\.\d+\.\d+$/.test(entry.name),
      );
      if (installers.length > 20) throw new Error("请先清理已结束的更新终端");
      for (const terminal of installers) {
        const output = await paseo.terminals
          .ref(terminal.id)
          .capture({ start: -30, stripAnsi: true });
        if (
          !output.lines.some((line) =>
            line.includes("PASEO_NOTIFIER_UPDATE_DONE"),
          )
        )
          throw new Error("已有更新终端尚未确认结束，请先检查终端输出");
      }
      const status = await this.check(true, false);
      const release = status.release;
      if (
        !status.canInstall ||
        !release ||
        release.id !== input.releaseId ||
        release.tag !== input.tag
      )
        throw new Error("发布信息或安装来源已变化，请重新检查更新");
      const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
      if (!workspace || workspace.archivingAt)
        throw new Error("请先选择当前 Host 中可用的工作区");
      const source = this.source!;
      const items = await this.deps.cli(source.cli!, [
        "plugin",
        "update",
        pluginId,
        "--home",
        this.home,
        "--ref",
        release.tag,
        "--check",
        "--json",
      ]);
      const preview = z
        .array(
          z.object({
            id: z.literal(pluginId),
            outcome: z.literal("update"),
            current: installationSchema,
            target: z.object({ kind: z.literal("git"), commit: sha }),
          }),
        )
        .length(1)
        .parse(items)[0]!;
      if (
        !officialInstallation(preview.current) ||
        JSON.stringify(preview.current) !== JSON.stringify(source.installation)
      )
        throw new Error("安装来源已变化，请重新检查更新");
      if (this.controller.signal.aborted) throw new Error("插件已停止");
      const terminal = await paseo.terminals.create({
        workspaceId: workspace.id,
        name: `Notifier update ${release.tag}`,
        command: process.execPath,
        args: [
          "-e",
          updateRunner,
          JSON.stringify({
            cli: source.cli,
            home: this.home,
            path: process.env.PATH ?? "",
            tag: release.tag,
            commit: preview.target.commit,
            expectedRevision: preview.current.currentRevision,
            identity: preview.current.identity,
          }),
        ],
      });
      return (this.job = {
        terminalId: terminal.id,
        workspaceId: workspace.id,
      });
    } finally {
      this.installing = false;
    }
  }
}
