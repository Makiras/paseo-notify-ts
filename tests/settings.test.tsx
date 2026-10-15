import { createElement } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginSurfaceProps,
  SettingsState,
} from "@getpaseo/plugin/client";
import { configSchema, defaultConfig } from "../shared/config";

const host = vi.hoisted(() => ({
  settings: undefined as unknown,
  schedules: vi.fn(async () => ({ schedules: [], unreadable: 0 })),
  rpc: vi.fn(async () => ({
    connected: true,
    settingsError: null,
    storageError: null,
    credentials: [],
    recoveries: [],
    deliveries: [],
  })),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => host.settings,
  useRpc: (rpc: { name: string }) =>
    rpc.name === "notifier.schedules.list" ? host.schedules : host.rpc,
}));
vi.mock("@getpaseo/plugin/client/ui", () =>
  Object.fromEntries(
    [
      "SettingsAction",
      "SettingsCard",
      "SettingsInput",
      "SettingsRow",
      "SettingsSection",
      "SettingsSwitch",
      "SettingsSelect",
    ].map((key) => [key, key]),
  ),
);
vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: "TextInput",
  copyText: vi.fn(async () => {}),
}));
import { Settings, createSettingsScreen } from "../client/settings";

let renderer: ReactTestRenderer;
let state: SettingsState<typeof configSchema>;
const props = {
  host: { id: "host-a", label: "Host A" },
  theme: { colors: { foreground: "black", foregroundMuted: "gray" } },
  layout: { compact: true, platform: "ios" },
} as unknown as PluginSurfaceProps;
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  state = {
    status: "ready",
    values: defaultConfig(),
    revision: "r1",
    saving: false,
    saveError: null,
    save: vi.fn(async () => false),
    reset: vi.fn(async () => true),
    reload: vi.fn(async () => {}),
  };
  host.settings = state;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render(surface = props) {
  await act(async () => {
    renderer = create(createElement(Settings, surface));
  });
}
function isVisible(node: ReactTestInstance): boolean {
  for (
    let current: ReactTestInstance | null = node;
    current;
    current = current.parent
  )
    if (current.props.style?.display === "none") return false;
  return true;
}
async function selectSection(section: string) {
  await act(async () =>
    renderer.root
      .findByProps({ label: "设置栏目" })
      .props.onValueChange(section),
  );
}
describe("native settings drafts", () => {
  it("shows one section at a time on compact layouts and keeps save available", async () => {
    await render();
    expect(isVisible(renderer.root.findByProps({ title: "渠道管理" }))).toBe(
      true,
    );
    expect(isVisible(renderer.root.findByProps({ label: "自动继续" }))).toBe(
      false,
    );
    await selectSection("recovery");
    expect(isVisible(renderer.root.findByProps({ title: "渠道管理" }))).toBe(
      false,
    );
    expect(isVisible(renderer.root.findByProps({ label: "自动继续" }))).toBe(
      true,
    );
    expect(
      isVisible(renderer.root.findByProps({ label: "重试前由 AI 复核" })),
    ).toBe(true);
    expect(
      isVisible(renderer.root.findByProps({ actionLabel: "保存设置" })),
    ).toBe(true);
    await selectSection("transfer");
    expect(
      isVisible(renderer.root.findByProps({ actionLabel: "复制配置" })),
    ).toBe(true);
    expect(isVisible(renderer.root.findByProps({ label: "自动继续" }))).toBe(
      false,
    );
  });
  it("uses tabs on wide layouts and preserves the selected section when narrowing", async () => {
    await render({ ...props, layout: { compact: false, platform: "web" } });
    expect(
      renderer.root.findAllByProps({ accessibilityRole: "tab" }),
    ).toHaveLength(7);
    const tab = renderer.root.findByProps({
      accessibilityRole: "tab",
      accessibilityLabel: "自动恢复",
    });
    await act(async () => tab.props.onPress());
    expect(tab.props.accessibilityState.selected).toBe(true);
    await act(async () => renderer.update(createElement(Settings, props)));
    expect(renderer.root.findByProps({ label: "设置栏目" }).props.value).toBe(
      "recovery",
    );
    expect(isVisible(renderer.root.findByProps({ label: "自动继续" }))).toBe(
      true,
    );
  });
  it("opens command-selected sections before and after mount without discarding edits", async () => {
    const screen = createSettingsScreen();
    const anotherHost = createSettingsScreen();
    screen.select("schedules");
    await act(async () => {
      renderer = create(createElement(screen.Component, props));
    });
    expect(renderer.root.findByProps({ label: "设置栏目" }).props.value).toBe(
      "schedules",
    );
    await act(async () => screen.select("recovery"));
    await act(async () =>
      renderer.root
        .findByProps({ label: "自动继续" })
        .props.onValueChange(true),
    );
    await act(async () => screen.select("schedules"));
    expect(renderer.root.findByProps({ label: "自动继续" }).props.value).toBe(
      true,
    );
    await act(async () =>
      renderer.update(createElement(anotherHost.Component, props)),
    );
    expect(renderer.root.findByProps({ label: "设置栏目" }).props.value).toBe(
      "channels",
    );
    expect(renderer.root.findByProps({ label: "自动继续" }).props.value).toBe(
      false,
    );
  });
  it("saves review controls with the existing recovery settings", async () => {
    await render();
    await act(async () =>
      renderer.root
        .findByProps({ label: "自动继续" })
        .props.onValueChange(true),
    );
    await act(async () =>
      renderer.root
        .findByProps({ label: "重试前由 AI 复核" })
        .props.onValueChange(true),
    );
    await act(async () =>
      renderer.root
        .findByProps({ label: "复核提供方 / 模型" })
        .props.onChangeText("claude/a-model"),
    );
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.onPress(),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          review: expect.objectContaining({
            enabled: true,
            provider: "claude/a-model",
          }),
        }),
      }),
      "r1",
    );
  });
  it("offers all sending channels in the native configuration page", async () => {
    await render();
    const options = renderer.root.findByProps({ label: "新渠道平台" }).props
      .options;
    expect(options).toHaveLength(9);
    for (const label of [
      "Telegram Bot",
      "钉钉群机器人",
      "Bark",
      "ntfy",
      "Slack",
      "Discord",
    ])
      expect(options).toContainEqual(expect.objectContaining({ label }));
  });
  it("saves a complete validated document against its captured revision", async () => {
    await render();
    await act(async () =>
      renderer.root
        .findByProps({ label: "自动继续" })
        .props.onValueChange(true),
    );
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.onPress(),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({ enabled: true }),
      }),
      "r1",
    );
  });
  it("keeps an unsaved draft and rejects overwriting another client's revision", async () => {
    await render();
    await act(async () =>
      renderer.root
        .findByProps({ label: "自动继续" })
        .props.onValueChange(true),
    );
    host.settings = {
      ...state,
      revision: "r2",
      values: { ...defaultConfig(), includeSubagents: true },
    };
    await act(async () => renderer.update(createElement(Settings, props)));
    expect(renderer.root.findByProps({ label: "自动继续" }).props.value).toBe(
      true,
    );
    expect(
      renderer.root.findByProps({ label: "其他客户端已修改配置" }),
    ).toBeTruthy();
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.onPress(),
    );
    expect(state.save).toHaveBeenLastCalledWith(expect.anything(), "r1");
  });
  it("blocks invalid numeric values before saving", async () => {
    await render();
    await selectSection("recovery");
    await act(async () =>
      renderer.root
        .findByProps({ label: "最大重试次数" })
        .props.onChangeText(""),
    );
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(true);
    expect(
      renderer.root.findByProps({ label: "请检查设置" }).props.error,
    ).toContain("maxAttempts");
    await selectSection("updates");
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "前往修改" }).props.onPress(),
    );
    expect(renderer.root.findByProps({ label: "设置栏目" }).props.value).toBe(
      "recovery",
    );
  });
  it("renders loading state without editable defaults", async () => {
    host.settings = { ...state, status: "loading" };
    await render();
    expect(renderer.root.findByProps({ label: "正在读取设置…" })).toBeTruthy();
    expect(renderer.root.findAllByProps({ label: "自动继续" })).toHaveLength(0);
  });
  it("does not carry a dirty configuration draft into another host", async () => {
    await render();
    await act(async () =>
      renderer.root
        .findByProps({ label: "自动继续" })
        .props.onValueChange(true),
    );
    host.settings = { ...state, values: defaultConfig() };
    await act(async () =>
      renderer.update(
        createElement(Settings, {
          ...props,
          host: { id: "host-b", label: "Host B" },
        }),
      ),
    );
    expect(renderer.root.findByProps({ label: "自动继续" }).props.value).toBe(
      false,
    );
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(true);
  });
});
