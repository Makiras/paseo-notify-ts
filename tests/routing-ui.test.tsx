import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginAgentPanelProps,
  PluginWorkspacePanelProps,
  SettingsState,
} from "@getpaseo/plugin/client";
import { configSchema } from "../shared/config";
import { createRoutingPanel, RoutingPanel } from "../client/routing";
import { config } from "./fixtures";

const host = vi.hoisted(() => ({
  settings: undefined as unknown,
  labels: {} as Record<string, string>,
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => host.settings,
  useAgent: (id: string, select: (agent: unknown) => unknown) =>
    id ? select({ labels: host.labels }) : null,
}));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () =>
  Object.fromEntries(
    [
      "SettingsAction",
      "SettingsCard",
      "SettingsRow",
      "SettingsSection",
      "SettingsSwitch",
    ].map((k) => [k, k]),
  ),
);
let renderer: ReactTestRenderer;
let state: Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
const props = {
  context: "agent",
  agentId: "s",
  workspaceId: "w",
} as PluginAgentPanelProps;
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  state = {
    status: "ready",
    values: config(),
    revision: "r1",
    saving: false,
    saveError: null,
    save: vi.fn(async () => true),
    reload: vi.fn(async () => {}),
    reset: vi.fn(async () => true),
  };
  host.settings = state;
  host.labels = {};
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render(
  panelProps: PluginAgentPanelProps | PluginWorkspacePanelProps = props,
) {
  await act(async () => {
    renderer = create(createElement(RoutingPanel, panelProps));
  });
}
describe("native notification selection", () => {
  it("opens the current workspace settings from the session popover and closes it without saving", async () => {
    const openPanel = vi.fn(),
      close = vi.fn();
    const Panel = createRoutingPanel({ openPanel });
    await act(async () => {
      renderer = create(createElement(Panel, { ...props, close }));
    });
    await act(async () =>
      renderer.root
        .findByProps({
          label: "工作区通知设置",
          actionLabel: "打开",
        })
        .props.onPress(),
    );
    expect(openPanel).toHaveBeenCalledWith("workspace-routing", {
      workspaceId: "w",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(state.save).not.toHaveBeenCalled();
  });
  it("shows the schedule binding in a new run and keeps it when changing the session", async () => {
    host.labels = { "paseo.schedule-id": "daily" };
    state.values.routing.host = [];
    state.values.routing.schedules.daily = ["hook-a"];
    await render();
    expect(
      renderer.root.findByProps({ label: "当前通知去向" }).props.hint,
    ).toBe("Webhook · 定时任务");
    await act(async () =>
      renderer.root
        .findByProps({ label: "跟随上级" })
        .props.onValueChange(false),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: {
          host: [],
          schedules: { daily: ["hook-a"] },
          workspaces: {},
          sessions: { s: [] },
        },
      }),
      "r1",
    );
  });
  it("shows inherited source and saves explicit mute only for the selected session", async () => {
    await render();
    expect(
      renderer.root.findByProps({ label: "当前通知去向" }).props.hint,
    ).toContain("Host");
    expect(
      renderer.root.findAllByProps({ title: "工作区通知设置" }),
    ).toHaveLength(0);
    await act(async () =>
      renderer.root
        .findByProps({ title: "会话通知设置" })
        .findByProps({ label: "跟随上级" })
        .props.onValueChange(false),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: {
          host: ["hook-a"],
          schedules: {},
          workspaces: {},
          sessions: { s: [] },
        },
      }),
      "r1",
    );
  });
  it("restores inheritance by removing the session selection rather than copying its parent", async () => {
    state.values.routing.sessions.s = [];
    state.values.routing.workspaces.w = ["hook-a"];
    await render();
    expect(
      renderer.root.findByProps({ label: "当前通知去向" }).props.hint,
    ).toContain("关闭通知 · Session");
    await act(async () =>
      renderer.root
        .findByProps({ title: "会话通知设置" })
        .findByProps({ label: "跟随上级" })
        .props.onValueChange(true),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: {
          host: ["hook-a"],
          schedules: {},
          workspaces: { w: ["hook-a"] },
          sessions: {},
        },
      }),
      "r1",
    );
  });
  it("edits only the workspace from its settings panel and preserves session overrides", async () => {
    state.values.routing.sessions.s = ["hook-a"];
    await render({
      context: "workspace",
      workspaceId: "w",
    } as PluginWorkspacePanelProps);
    expect(
      renderer.root.findAllByProps({ title: "会话通知设置" }),
    ).toHaveLength(0);
    await act(async () =>
      renderer.root
        .findByProps({ title: "工作区通知设置" })
        .findByProps({ label: "跟随上级" })
        .props.onValueChange(false),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: {
          host: ["hook-a"],
          schedules: {},
          workspaces: { w: [] },
          sessions: { s: ["hook-a"] },
        },
      }),
      "r1",
    );
  });
});
