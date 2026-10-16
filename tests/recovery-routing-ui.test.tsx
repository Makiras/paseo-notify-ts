import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginAgentPanelProps,
  PluginWorkspacePanelProps,
  SettingsState,
} from "@getpaseo/plugin/client";
import { configSchema } from "../shared/config";
import { RecoveryPanel, createRecoveryPanel } from "../client/recovery-routing";
import { config } from "./fixtures";
const host = vi.hoisted(() => ({ settings: undefined as unknown }));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => host.settings,
}));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("@getpaseo/plugin/client/ui", () =>
  Object.fromEntries(
    [
      "SettingsAction",
      "SettingsCard",
      "SettingsRow",
      "SettingsSwitch",
      "SettingsInput",
    ].map((k) => [k, k]),
  ),
);
let renderer: ReactTestRenderer;
let state: Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
const props = {
  host: { id: "host" },
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
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render(
  p: PluginAgentPanelProps | PluginWorkspacePanelProps = props,
) {
  await act(async () => {
    renderer = create(createElement(RecoveryPanel, p));
  });
}
const control = (label: string) => renderer.root.findByProps({ label });
const save = () => renderer.root.findByProps({ actionLabel: "保存" });
describe("session and workspace recovery editor", () => {
  it("starts inherited, copies the effective workspace policy and saves session off without changing notifications", async () => {
    state.values.recoveryOverrides.workspaces.w = {
      ...state.values.recovery,
      maxAttempts: 9,
    };
    await render();
    expect(control("会话自动继续").props.hint).toBe(
      "当前生效：开启 · Workspace",
    );
    expect(
      renderer.root.findAllByProps({ label: "最大重试次数" }),
    ).toHaveLength(0);
    await act(async () => control("跟随上级").props.onValueChange(false));
    await act(async () => control("自动继续").props.onValueChange(false));
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => save().props.onPress());
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: state.values.routing,
        recovery: state.values.recovery,
        recoveryOverrides: {
          workspaces: state.values.recoveryOverrides.workspaces,
          sessions: {
            s: expect.objectContaining({ enabled: false, maxAttempts: 9 }),
          },
        },
      }),
      "r1",
    );
  });
  it("removes a session override to restore live inheritance", async () => {
    state.values.recoveryOverrides.sessions.s = {
      ...state.values.recovery,
      enabled: false,
    };
    await render();
    await act(async () => control("跟随上级").props.onValueChange(true));
    await act(async () => save().props.onPress());
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryOverrides: { workspaces: {}, sessions: {} },
      }),
      "r1",
    );
  });
  it("expands full settings, validates values and retains edits on failed save", async () => {
    await render();
    await act(async () => control("跟随上级").props.onValueChange(false));
    await act(async () => control("重试参数与 AI 复核").props.onPress());
    await act(async () => control("最大重试次数").props.onChangeText("0"));
    expect(save().props.disabled).toBe(true);
    await act(async () => save().props.onPress());
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => control("最大重试次数").props.onChangeText("7"));
    vi.mocked(state.save).mockResolvedValue(false);
    await act(async () => save().props.onPress());
    expect(control("最大重试次数").props.initialValue).toBe("7");
    expect(save().props.disabled).toBe(false);
  });
  it("keeps dirty edits on another client's revision, blocks overwrite, and reloads explicitly", async () => {
    await render();
    await act(async () => control("跟随上级").props.onValueChange(false));
    state = { ...state, revision: "r2", values: config() };
    host.settings = state;
    await act(async () => renderer.update(createElement(RecoveryPanel, props)));
    expect(control("跟随上级").props.value).toBe(false);
    expect(save().props.disabled).toBe(true);
    await act(async () => save().props.onPress());
    expect(state.save).not.toHaveBeenCalled();
    await act(async () =>
      control("放弃本页修改并读取最新设置").props.onPress(),
    );
    expect(control("跟随上级").props.value).toBe(true);
    expect(state.reload).toHaveBeenCalledOnce();
  });
  it("saves only the workspace override and preserves existing session policies", async () => {
    state.values.recoveryOverrides.sessions.s = {
      ...state.values.recovery,
      enabled: false,
    };
    await render({
      ...props,
      context: "workspace",
    } as PluginWorkspacePanelProps);
    await act(async () => control("跟随上级").props.onValueChange(false));
    await act(async () => save().props.onPress());
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryOverrides: {
          workspaces: { w: state.values.recovery },
          sessions: state.values.recoveryOverrides.sessions,
        },
      }),
      "r1",
    );
  });
  it("opens workspace recovery from its own session popover", async () => {
    const openPanel = vi.fn(),
      close = vi.fn();
    const Panel = createRecoveryPanel({ openPanel });
    await act(async () => {
      renderer = create(createElement(Panel, { ...props, close }));
    });
    await act(async () => control("工作区自动继续设置").props.onPress());
    expect(openPanel).toHaveBeenCalledWith("workspace-recovery", {
      workspaceId: "w",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
