import { describe, expect, it } from "vitest";
import {
  channelSchema,
  configSchema,
  defaultConfig,
  migrateSettings,
} from "../shared/config";
import {
  notificationChannels,
  resolveRoute,
  withoutChannel,
} from "../shared/routing";
import { config } from "./fixtures";
import type { Notification } from "../shared/contracts";

const notice: Notification = {
  id: "n",
  kind: "completed",
  agentId: "s",
  workspaceId: "w",
  provider: "codex",
  title: "done",
  summary: "done",
  createdAt: 1,
  attempts: 0,
};
function settings() {
  const c = config();
  c.channels.push(
    channelSchema.parse({ id: "hook-b", kind: "webhook", name: "B" }),
  );
  return c;
}
describe("host/workspace/session inheritance", () => {
  it("routes successive runs by schedule ID while preserving workspace and session overrides", () => {
    const c = settings();
    c.routing.schedules.daily = ["hook-b"];
    for (const run of ["first", "next"])
      expect(
        resolveRoute(c, {
          agentId: run,
          workspaceId: run,
          scheduleId: "daily",
        }),
      ).toEqual({ source: "schedule", channelIds: ["hook-b"] });
    c.routing.workspaces.w = [];
    expect(
      resolveRoute(c, { ...notice, scheduleId: "daily" }).channelIds,
    ).toEqual([]);
    c.routing.sessions.s = ["hook-a"];
    expect(resolveRoute(c, { ...notice, scheduleId: "daily" }).source).toBe(
      "session",
    );
  });
  it("keeps muted tasks muted, restores inheritance, and removes deleted channel references", () => {
    const c = settings();
    c.routing.schedules.daily = [];
    expect(notificationChannels(c, { ...notice, scheduleId: "daily" })).toEqual(
      [],
    );
    delete c.routing.schedules.daily;
    expect(resolveRoute(c, { ...notice, scheduleId: "daily" }).source).toBe(
      "host",
    );
    c.routing.schedules.daily = ["hook-b"];
    expect(withoutChannel(c, "hook-b").routing.schedules.daily).toEqual([]);
    c.channels[1]!.enabled = false;
    expect(notificationChannels(c, { ...notice, scheduleId: "daily" })).toEqual(
      [],
    );
  });
  it("adds schedule bindings to existing settings without changing their defaults", () => {
    const c = settings();
    c.routing.host = [];
    c.routing.workspaces.w = ["hook-b"];
    const { schedules: _unused, ...routing } = c.routing;
    expect(migrateSettings({ ...c, routing }, 2).routing).toEqual({
      ...routing,
      schedules: {},
    });
    c.routing.schedules.daily = ["missing"];
    expect(configSchema.safeParse(c).success).toBe(false);
  });
  it("follows later parent changes until a child makes an explicit selection", () => {
    const c = settings();
    expect(resolveRoute(c, notice)).toEqual({
      source: "host",
      channelIds: ["hook-a"],
    });
    c.routing.host = ["hook-b"];
    expect(resolveRoute(c, notice).channelIds).toEqual(["hook-b"]);
    c.routing.workspaces.w = ["hook-a"];
    expect(resolveRoute(c, notice)).toEqual({
      source: "workspace",
      channelIds: ["hook-a"],
    });
    c.routing.sessions.s = ["hook-b"];
    c.routing.workspaces.w = [];
    expect(resolveRoute(c, notice)).toEqual({
      source: "session",
      channelIds: ["hook-b"],
    });
  });
  it("keeps explicit mute and resumes inheritance only when the override is removed", () => {
    const c = settings();
    c.routing.sessions.s = [];
    expect(notificationChannels(c, notice)).toEqual([]);
    delete c.routing.sessions.s;
    expect(notificationChannels(c, notice).map((v) => v.id)).toEqual([
      "hook-a",
    ]);
    c.routing.workspaces.w = [];
    expect(notificationChannels(c, notice)).toEqual([]);
  });
  it("does not fall back when the selected channel is disabled or filtered out", () => {
    const c = settings();
    c.routing.sessions.s = ["hook-b"];
    c.channels[1]!.enabled = false;
    expect(notificationChannels(c, notice)).toEqual([]);
    c.channels[1]!.enabled = true;
    c.channels[1]!.providers = ["claude"];
    expect(notificationChannels(c, notice)).toEqual([]);
  });
  it("does not automatically select newly registered channels", () => {
    const c = settings();
    expect(notificationChannels(c, notice).map((v) => v.id)).toEqual([
      "hook-a",
    ]);
    expect(resolveRoute(defaultConfig(), notice).channelIds).toEqual([]);
  });
  it("removes dangling references while preserving explicit mute", () => {
    const c = settings();
    c.routing.sessions.s = ["hook-b"];
    const next = withoutChannel(c, "hook-b");
    expect(configSchema.parse(next).routing.sessions.s).toEqual([]);
    expect(resolveRoute(next, notice).source).toBe("session");
    expect(notificationChannels(next, notice)).toEqual([]);
  });
  it("migrates previous fan-out to host defaults only for existing settings", () => {
    const { routing: _old, ...old } = settings();
    expect(migrateSettings(old, 1).routing).toEqual({
      host: ["hook-a", "hook-b"],
      schedules: {},
      workspaces: {},
      sessions: {},
    });
    expect(defaultConfig().routing.host).toEqual([]);
    expect(() => migrateSettings(old, 99)).toThrow();
  });
  it("rejects unknown targets and prototype-shaped scope identifiers", () => {
    const c = settings();
    c.routing.host = ["missing"];
    expect(configSchema.safeParse(c).success).toBe(false);
    c.routing.host = [];
    c.routing.sessions = JSON.parse('{"__proto__":["hook-a"]}');
    expect(configSchema.safeParse(c).success).toBe(false);
  });
});
