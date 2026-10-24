import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  localHost,
  processIdentity,
  ownerSchema,
  ownerStatus,
} from "./process-owner";
import { channelKindSchema, failureKindSchema } from "../shared/config";
import {
  credentialsSchema,
  notificationSchema,
  notificationNamesSchema,
  recoveryCardSchema,
} from "../shared/contracts";

export const recoverySchema = recoveryCardSchema.extend({
  ...notificationNamesSchema.shape,
  provider: z.string(),
  workspaceId: z.string().nullable(),
  scheduleId: z.string().nullable().optional(),
  failure: failureKindSchema,
  startedAt: z.number(),
  userKey: z.string().nullable(),
  turnId: z.string().nullable().default(null),
  messageId: z.string().nullable(),
  // Legacy journals omit these execution flags; old content fingerprints are discarded.
  superseded: z.boolean().default(false),
  awaitingStart: z.boolean().default(false),
});
export type Recovery = z.infer<typeof recoverySchema>;
export const deliverySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelKind: channelKindSchema,
  credentialsHash: z.string().optional(),
  notice: notificationSchema,
  phase: z.enum(["pending", "sent", "failed", "canceled"]),
  attempts: z.number(),
  dueAt: z.number(),
  updatedAt: z.number(),
  error: z.string().nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;
const stateSchema = z.object({
  version: z.literal(1),
  recoveries: z.array(recoverySchema),
  deliveries: z.array(deliverySchema),
  seen: z.array(z.object({ key: z.string(), at: z.number() })),
});
export type State = z.infer<typeof stateSchema>;
const secretsSchema = z.record(
  z.string(),
  z.object({ kind: channelKindSchema, values: credentialsSchema }),
);
export type Secrets = z.infer<typeof secretsSchema>;

export async function atomicWrite(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    // Persist the rename on filesystems supporting directory fsync.
    if (process.platform !== "win32") {
      const dir = await open(dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export class JsonFile<T> {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly file: string,
    private data: T,
  ) {}
  static async load<T>(
    file: string,
    schema: z.ZodType<T>,
    initial: T,
  ): Promise<JsonFile<T>> {
    let data = initial;
    try {
      if ((await stat(file)).size > 16 * 1024 * 1024)
        throw new Error("运行记录过大，已停止自动操作");
      data = schema.parse(JSON.parse(await readFile(file, "utf8")));
      await chmod(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "无法读取插件运行记录；原文件已保留，请检查文件权限或内容",
        );
    }
    return new JsonFile(file, data);
  }
  read(): T {
    return structuredClone(this.data);
  }
  update<R>(fn: (draft: T) => R): Promise<R> {
    const next = this.chain.then(async () => {
      const draft = structuredClone(this.data);
      const result = fn(draft);
      try {
        await atomicWrite(this.file, draft);
      } catch {
        throw new Error("无法保存插件运行记录，已暂停相关自动操作");
      }
      this.data = draft;
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
  async flush(): Promise<void> {
    await this.chain;
  }
}

export class Storage {
  private constructor(
    readonly state: JsonFile<State>,
    readonly secrets: JsonFile<Secrets>,
    private release: () => Promise<void>,
  ) {}
  static async open(directory: string): Promise<Storage> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lockFile = join(directory, "owner.lock");
    const token = randomUUID();
    const host = await localHost();
    const identity = await processIdentity(process.pid);
    const acquire = async () => {
      const lock = await open(lockFile, "wx", 0o600);
      try {
        await lock.writeFile(
          JSON.stringify({
            pid: process.pid,
            token,
            host,
            ...(identity ? { identity } : {}),
          }),
        );
      } finally {
        await lock.close();
      }
    };
    try {
      await acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Only one process may reap a stale owner. Without this lock, two restarts
      // could both remove the old lock, with the second deleting a newly acquired one.
      const reapFile = join(directory, "reap.lock");
      const reaper = await open(reapFile, "wx", 0o600);
      try {
        const owner = ownerSchema.parse(
          JSON.parse(await readFile(lockFile, "utf8")),
        );
        const status = await ownerStatus(owner, host);
        if (status === "foreign")
          throw new Error(
            "Notifier 数据目录被另一台主机的锁占用；请为不同 Host 设置独立的 PASEO_NOTIFIER_STATE_DIR",
          );
        if (status === "unknown")
          throw new Error(
            "无法确认 Notifier 锁对应的进程身份，已保留锁；请检查进程读取权限后重新加载插件",
          );
        if (status === "active")
          throw new Error(
            "已有 Notifier 使用此数据目录，或旧锁对应的 PID 仍存活但无法核对身份；多个实例须分别设置 PASEO_NOTIFIER_STATE_DIR",
          );
        await rm(lockFile);
        await acquire();
      } finally {
        await reaper.close();
        await rm(reapFile);
      }
    }
    const release = async () => {
      try {
        const current = JSON.parse(await readFile(lockFile, "utf8"));
        if (current.token === token) await rm(lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    try {
      const state = await JsonFile.load(
        join(directory, "operations.json"),
        stateSchema,
        { version: 1, recoveries: [], deliveries: [], seen: [] },
      );
      const secrets = await JsonFile.load(
        join(directory, "credentials.json"),
        secretsSchema,
        {},
      );
      return new Storage(state, secrets, release);
    } catch (error) {
      await release();
      throw error;
    }
  }
  async close(): Promise<void> {
    await this.state.flush();
    await this.secrets.flush();
    await this.release();
  }
}

export function prune(state: State, now: number, retentionDays: number): void {
  const cutoff = now - retentionDays * 86_400_000;
  const active = new Set(["waiting", "reviewing", "dispatching", "running"]);
  const keep = (r: Recovery) =>
    active.has(r.phase) || r.reviews.some((v) => v.cleanupPending);
  const live = state.recoveries.filter(keep);
  if (live.length > 1000)
    throw new Error("活动恢复计划超过 1000 个，请先处理已有计划");
  const history = state.recoveries.filter(
    (r) => !keep(r) && r.updatedAt > cutoff,
  );
  state.recoveries = [
    ...(live.length === 1000 ? [] : history.slice(-(1000 - live.length))),
    ...live,
  ].sort((a, b) => a.startedAt - b.startedAt);
  state.deliveries = state.deliveries.filter(
    (d) => d.phase === "pending" || d.updatedAt > cutoff,
  );
  state.seen = state.seen.filter((e) => e.at > cutoff).slice(-5000);
  if (state.deliveries.length > 2000) {
    const pending = state.deliveries.filter((d) => d.phase === "pending");
    if (pending.length > 2000)
      throw new Error("待发送通知已达到 2000 条，请处理渠道故障");
    const completed = state.deliveries
      .filter((d) => d.phase !== "pending")
      .slice(-(2000 - pending.length));
    state.deliveries = [
      ...(pending.length === 2000 ? [] : completed),
      ...pending,
    ];
  }
}
