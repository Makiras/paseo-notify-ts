import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sessionInfo, type SessionInfo } from "../shared/sessions";
import type { PaseoApi } from "./types";
import { readSessionDirectory } from "./session-directory";
import { findPaseoCli, runCli } from "./updates";

type Agent = NonNullable<
  Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>
>["agent"];
function metadata(agent: Agent): SessionInfo {
  return sessionInfo.parse({
    id: agent.id,
    title: agent.title || "未命名会话",
    provider: agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId ?? null,
    status: agent.status,
    archivedAt: agent.archivedAt ?? null,
    updatedAt: agent.updatedAt,
  });
}
const deleted = z.object({
  deletedCount: z.literal(1),
  agentIds: z.array(z.string()).length(1),
});

export class Sessions {
  private plans = new Map<
    string,
    { expires: number; ids: Set<string>; archivedOnly: boolean }
  >();
  private deleting = new Set<string>();
  constructor(
    private home: string,
    private deps: {
      findCli: typeof findPaseoCli;
      cli: typeof runCli;
      now(): number;
      readSessions?: typeof readSessionDirectory;
    } = { findCli: findPaseoCli, cli: runCli, now: Date.now },
  ) {}
  async list(_paseo: PaseoApi, cursor?: string) {
    const [directory, cli] = await Promise.all([
      (this.deps.readSessions ?? readSessionDirectory)(this.home),
      this.deps.findCli(),
    ]);
    const compare = (a: SessionInfo, b: SessionInfo) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      a.id.localeCompare(b.id);
    let sessions = directory.sessions.sort(compare);
    if (cursor) {
      let after: { id: string; updatedAt: string };
      try {
        after = z
          .object({ id: z.string().uuid(), updatedAt: z.string().datetime() })
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      } catch {
        throw new Error("列表位置已失效，请刷新会话");
      }
      sessions = sessions.filter(
        (s) =>
          Date.parse(s.updatedAt) < Date.parse(after.updatedAt) ||
          (s.updatedAt === after.updatedAt && s.id.localeCompare(after.id) > 0),
      );
    }
    const page = sessions.slice(0, 100),
      last = page.at(-1);
    return {
      sessions: page,
      nextCursor:
        sessions.length > 100 && last
          ? Buffer.from(
              JSON.stringify({ id: last.id, updatedAt: last.updatedAt }),
            ).toString("base64url")
          : null,
      canDelete: Boolean(cli),
      unreadable: directory.unreadable,
    };
  }
  async prepare(paseo: PaseoApi, ids: string[], archivedOnly: boolean) {
    if (!(await this.deps.findCli()))
      throw new Error("Host 未找到可用的 Paseo CLI，暂时无法删除会话");
    const sessions = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (!agent || agent.id !== id)
          throw new Error("会话已不存在或无法读取，请刷新列表后重试");
        if (archivedOnly && !agent.archivedAt)
          throw new Error("所选会话已取消归档，请刷新列表后重新选择");
        return metadata(agent);
      }),
    );
    for (const [token, plan] of this.plans)
      if (plan.expires <= this.deps.now()) this.plans.delete(token);
    if (this.plans.size >= 32)
      this.plans.delete(this.plans.keys().next().value!);
    const token = randomUUID();
    this.plans.set(token, {
      expires: this.deps.now() + 5 * 60_000,
      ids: new Set(sessions.map((s) => s.id)),
      archivedOnly,
    });
    return { token, sessions };
  }
  async remove(
    paseo: PaseoApi,
    token: string,
    id: string,
    beforeDelete: () => Promise<void>,
  ) {
    const plan = this.plans.get(token);
    if (!plan || plan.expires <= this.deps.now() || !plan.ids.has(id))
      throw new Error("删除确认已过期或已使用，请刷新后重新确认");
    if (this.deleting.has(id))
      throw new Error("此会话正在删除，请等待结果后刷新");
    // Consume before any await: reconnects/double clicks never replay a deletion.
    plan.ids.delete(id);
    if (!plan.ids.size) this.plans.delete(token);
    this.deleting.add(id);
    try {
      const cli = await this.deps.findCli();
      if (!cli) throw new Error("Host 未找到可用的 Paseo CLI");
      const current = (await paseo.agents.ref(id).refresh())?.agent;
      if (!current) return { ok: true, message: "会话已不存在" };
      if (current.id !== id) throw new Error("会话 ID 不匹配，未执行删除");
      if (plan.archivedOnly && !current.archivedAt)
        throw new Error("会话已取消归档，未执行删除，请重新选择");
      await beforeDelete();
      const result = deleted.parse(
        await this.deps.cli(cli, [
          "agent",
          "delete",
          id,
          "--home",
          this.home,
          "--json",
        ]),
      );
      if (result.agentIds[0] !== id)
        throw new Error("删除返回的会话 ID 不匹配");
      // Paseo can acknowledge deletion even when persistence removal failed.
      if ((await paseo.agents.ref(id).refresh())?.agent)
        throw new Error("会话仍存在，请刷新后检查 Host 日志");
      return { ok: true, message: "会话已删除" };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error && !("stdout" in error) && !("stderr" in error)
            ? error.message
            : "无法确认删除结果，请刷新列表后检查，勿重复提交",
      };
    } finally {
      this.deleting.delete(id);
    }
  }
}
