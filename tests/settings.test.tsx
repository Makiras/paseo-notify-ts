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
  ScrollView: "ScrollView",
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
async function pressAction(actionLabel: string) {
  await act(async () =>
    renderer.root.findByProps({ actionLabel }).props.onPress(),
  );
}
describe("native settings drafts", () => {
  it("explains all four name layers and previews each editable name separately", async () => {
    await render();
    await selectSection("notifications");
    await pressAction("展开填写帮助");
    for (const name of [
      "hostname",
      "project_name",
      "workspace_name",
      "session_title",
    ]) {
      expect(
        renderer.root.findByProps({ label: `{{${name}}}` }).props.hint,
      ).toContain("层");
    }
    await pressAction("编辑示例数据");
    const edit = async (label: string, value: string) =>
      act(async () =>
        renderer.root
          .findByProps({ accessibilityLabel: label })
          .props.onChangeText(value),
      );
    await edit(
      "正文模板",
      "{{hostname}} / {{project_name}} / {{workspace_name}} / {{session_title}} | {{title}}",
    );
    await edit("示例主机名", "local-host");
    await edit("示例项目分组名称", "香山验证");
    await edit("示例侧栏工作区名称", "LSQ验证");
    await edit("示例聊天标签页标题", "检查加载队列");
    const body = () =>
      renderer.root.findByProps({ accessibilityLabel: "预览正文内容" }).props
        .children;
    expect(body()).toBe(
      "local-host / 香山验证 / LSQ验证 / 检查加载队列 | LSQ验证",
    );
    await edit("示例侧栏工作区名称", "");
    expect(body()).toBe(
      "local-host / 香山验证 /  / 检查加载队列 | 检查加载队列",
    );
    await pressAction("保存设置");
    const saved = JSON.stringify(vi.mocked(state.save).mock.calls);
    expect(saved).toContain("{{workspace_name}}");
    expect(saved).not.toContain("local-host");
    expect(saved).not.toContain("检查加载队列");
  });

  it("keeps template editing and preview visible while help and rules open on demand", async () => {
    await render();
    await selectSection("notifications");
    expect(
      isVisible(renderer.root.findByProps({ accessibilityLabel: "正文模板" })),
    ).toBe(true);
    expect(
      isVisible(
        renderer.root.findByProps({ accessibilityLabel: "预览正文内容" }),
      ),
    ).toBe(true);
    expect(
      renderer.root.findAllByProps({ label: "Pattern 如何填写" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ actionLabel: "添加工单号示例" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "示例回复" }),
    ).toHaveLength(0);
    await pressAction("展开规则说明");
    expect(
      renderer.root.findByProps({ label: "Pattern 如何填写" }).props.hint,
    ).toContain("组 1");
    expect(
      renderer.root.findAllByProps({ actionLabel: "添加工单号示例" }),
    ).toHaveLength(0);
    await pressAction("收起规则说明");
    await pressAction("展开填写帮助");
    expect(
      renderer.root.findByProps({ label: "{{summary}}" }).props.hint,
    ).toContain("不是 AI 回复");
    await pressAction("收起填写帮助");
    await act(async () =>
      renderer.root
        .findByProps({ label: "附带最终回复摘要" })
        .props.onValueChange(true),
    );
    await pressAction("展开提取规则");
    await pressAction("添加工单号示例");
    expect(
      renderer.root.findByProps({ label: "{{custom.ticket}} · 已匹配" }).props
        .hint,
    ).toBe("PROJ-123");
    await pressAction("添加结果链接示例");
    expect(
      renderer.root.findByProps({ label: "{{custom.link}} · 已匹配" }).props
        .hint,
    ).toBe("https://example.com/result/123");
    const input = () =>
      renderer.root.findByProps({ accessibilityLabel: "正文模板" });
    const before = input().props.value;
    await pressAction("收起提取规则");
    await selectSection("channels");
    await selectSection("notifications");
    expect(input().props.value).toBe(before);
    await pressAction("展开提取规则");
    expect(
      renderer.root.findByProps({ label: "编辑提取规则" }).props.value,
    ).toBe("1");
    expect(
      renderer.root.findByProps({ accessibilityLabel: "变量名" }).props.value,
    ).toBe("link");
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.onPress(),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        notifications: expect.objectContaining({
          template: expect.objectContaining({
            body: before,
            rules: [
              expect.objectContaining({ name: "ticket" }),
              expect.objectContaining({ name: "link", group: 1 }),
            ],
          }),
        }),
      }),
      "r1",
    );
  });
  it("blocks malformed patterns and routes the error action back to notification management", async () => {
    await render();
    await selectSection("notifications");
    await pressAction("展开提取规则");
    await act(async () =>
      renderer.root
        .findByProps({ actionLabel: "添加工单号示例" })
        .props.onPress(),
    );
    await act(async () =>
      renderer.root
        .findByProps({ accessibilityLabel: "匹配规则（Pattern）" })
        .props.onChangeText("("),
    );
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(true);
    expect(
      renderer.root.findByProps({ label: "模板需要修改" }).props.error,
    ).toContain("Pattern 无效");
    await pressAction("添加结果链接示例");
    await pressAction("收起提取规则");
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "匹配规则（Pattern）",
      }),
    ).toHaveLength(0);
    await selectSection("channels");
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "前往修改" }).props.onPress(),
    );
    expect(renderer.root.findByProps({ label: "设置栏目" }).props.value).toBe(
      "notifications",
    );
    expect(
      isVisible(renderer.root.findByProps({ label: "模板需要修改" })),
    ).toBe(true);
    await pressAction("展开错误规则");
    expect(
      renderer.root.findByProps({ label: "编辑提取规则" }).props.value,
    ).toBe("0");
    expect(
      renderer.root.findByProps({ accessibilityLabel: "匹配规则（Pattern）" })
        .props.value,
    ).toBe("(");
  });
  it("keeps reply samples local and respects the preview privacy switch", async () => {
    await render();
    await selectSection("notifications");
    await pressAction("展开提取规则");
    await act(async () =>
      renderer.root
        .findByProps({ actionLabel: "添加工单号示例" })
        .props.onPress(),
    );
    expect(
      renderer.root.findByProps({ label: "{{custom.ticket}} · 使用默认值" })
        .props.hint,
    ).toBe("未提供工单号");
    await pressAction("编辑示例数据");
    await act(async () =>
      renderer.root
        .findByProps({ accessibilityLabel: "示例回复" })
        .props.onChangeText("LOCAL-999"),
    );
    await pressAction("收起示例数据");
    await pressAction("收起提取规则");
    await selectSection("channels");
    await selectSection("notifications");
    await pressAction("编辑示例数据");
    expect(
      renderer.root.findByProps({ accessibilityLabel: "示例回复" }).props.value,
    ).toBe("LOCAL-999");
    await pressAction("展开提取规则");
    await act(async () =>
      renderer.root
        .findByProps({ label: "附带最终回复摘要" })
        .props.onValueChange(true),
    );
    expect(
      renderer.root.findByProps({ label: "{{custom.ticket}} · 已匹配" }).props
        .hint,
    ).toBe("LOCAL-999");
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.onPress(),
    );
    expect(JSON.stringify(vi.mocked(state.save).mock.calls)).not.toContain(
      "LOCAL-999",
    );
    await act(async () =>
      renderer.root
        .findByProps({ actionLabel: "使用默认模板" })
        .props.onPress(),
    );
    expect(
      renderer.root.findByProps({ accessibilityLabel: "正文模板" }).props.value,
    ).not.toContain("custom.ticket");
    expect(
      renderer.root.findByProps({ label: "编辑提取规则" }).props.options,
    ).toHaveLength(1);
  });
  it("shows one section at a time on compact layouts and keeps save available", async () => {
    await render();
    expect(isVisible(renderer.root.findByProps({ title: "添加渠道" }))).toBe(
      true,
    );
    expect(isVisible(renderer.root.findByProps({ label: "自动继续" }))).toBe(
      false,
    );
    await selectSection("recovery");
    expect(isVisible(renderer.root.findByProps({ title: "添加渠道" }))).toBe(
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
  it("opens the separate recovery entry with only recovery and activity navigation", async () => {
    const screen = createSettingsScreen("recovery", ["recovery", "activity"]);
    await act(async () => {
      renderer = create(createElement(screen.Component, props));
    });
    const selector = renderer.root.findByProps({ label: "设置栏目" });
    expect(selector.props.value).toBe("recovery");
    expect(
      selector.props.options.map((option: { value: string }) => option.value),
    ).toEqual(["recovery", "activity"]);
    expect(isVisible(renderer.root.findByProps({ label: "自动继续" }))).toBe(
      true,
    );
    expect(isVisible(renderer.root.findByProps({ title: "添加渠道" }))).toBe(
      false,
    );
  });
  it("uses tabs on wide layouts and preserves the selected section when narrowing", async () => {
    await render({ ...props, layout: { compact: false, platform: "web" } });
    expect(
      renderer.root.findAllByProps({ accessibilityRole: "tab" }),
    ).toHaveLength(8);
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
    expect(renderer.root.findByProps({ label: "请检查设置" }).props.error).toBe(
      "自动恢复 · 最大重试次数：请填写有效数字",
    );
    for (const [input, message] of [
      ["0", "至少1"],
      ["21", "最多20"],
      ["1.5", "请填写整数"],
    ]) {
      await act(async () =>
        renderer.root
          .findByProps({ label: "最大重试次数" })
          .props.onChangeText(input),
      );
      expect(
        renderer.root.findByProps({ label: "请检查设置" }).props.error,
      ).toBe(`自动恢复 · 最大重试次数：${message}`);
      expect(
        renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
      ).toBe(true);
    }
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
