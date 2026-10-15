import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginSurfaceProps,
  SettingsState,
} from "@getpaseo/plugin/client";
import {
  channelNames,
  channelSchema,
  configSchema,
  defaultConfig,
} from "../shared/config";
import type { RuntimeStatus } from "../shared/contracts";

const host = vi.hoisted(() => ({
  settings: undefined as unknown,
  status: vi.fn(),
  write: vi.fn(),
  test: vi.fn(),
  unused: vi.fn(),
  schedules: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => host.settings,
  useRpc: (rpc: { name: string }) =>
    ({
      "notifier.status": host.status,
      "notifier.credentials.save": host.write,
      "notifier.channel.test": host.test,
      "notifier.schedules.list": host.schedules,
    })[rpc.name] ?? host.unused,
}));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return {
    ...Object.fromEntries(
      [
        "SettingsAction",
        "SettingsCard",
        "SettingsRow",
        "SettingsSection",
        "SettingsSwitch",
        "SettingsSelect",
      ].map((key) => [key, key]),
    ),
    // Match the SDK input's mount-only initialValue behavior. Plain string
    // mocks cannot detect lost visible text after a form remount.
    SettingsInput: function Input({
      initialValue = "",
      label,
      disabled,
      onChangeText,
    }: {
      initialValue?: string;
      label: string;
      disabled?: boolean;
      onChangeText(value: string): void;
    }) {
      const [value, setValue] = React.useState(initialValue);
      return React.createElement("Input", {
        name: label,
        value,
        disabled,
        onChangeText: (text: string) => {
          if (disabled) return;
          setValue(text);
          onChangeText(text);
        },
      });
    },
  };
});
vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: "TextInput",
  copyText: vi.fn(),
}));
import { Settings } from "../client/settings";

let renderer: ReactTestRenderer;
let state: Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
let status: RuntimeStatus;
const props = {
  host: { id: "host-a", label: "Host A" },
  theme: { colors: { foreground: "black", foregroundMuted: "gray" } },
  layout: { compact: true, platform: "ios" },
} as unknown as PluginSurfaceProps;
const fields = {
  "Webhook 地址": "https://notify.example.test/private-hook",
  "签名密钥（可选）": "draft-signing-secret",
  "Bearer Token（可选）": "draft-bearer-token",
  "自定义请求头 JSON（可选）": '{"X-Custom":"draft-header"}',
};

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
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
  status = {
    connected: true,
    settingsError: null,
    storageError: null,
    credentials: [],
    recoveries: [],
    deliveries: [],
  };
  host.settings = state;
  host.schedules.mockResolvedValue({ schedules: [], unreadable: 0 });
  host.status.mockImplementation(async () => structuredClone(status));
  host.write.mockImplementation(async ({ id, kind }) => {
    status.credentials = [
      ...status.credentials.filter((c) => c.id !== id),
      { id, kind, configured: true },
    ];
    return { ok: true };
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render() {
  await act(async () => {
    renderer = create(createElement(Settings, props));
  });
}
function input(label: string) {
  return renderer.root.findByProps({ name: label });
}
async function fill(values = fields) {
  for (const [label, value] of Object.entries(values)) {
    await act(async () => input(label).props.onChangeText(value));
  }
}
async function click(label: string) {
  await act(async () =>
    renderer.root.findByProps({ actionLabel: label }).props.onPress(),
  );
}
function savedChannel(kind: "webhook" | "telegram" = "webhook") {
  state.values.channels = [
    channelSchema.parse({ id: "channel-a", name: "My channel", kind }),
  ];
}
function expectDraft() {
  for (const [label, value] of Object.entries(fields))
    expect(input(label).props.value).toBe(value);
}
function acceptSettings() {
  state.save = vi.fn(async (values) => {
    state = { ...state, values, revision: `${state.revision}-next` };
    host.settings = state;
    renderer.update(createElement(Settings, props));
    return true;
  });
}

describe("credential drafts across settings refreshes", () => {
  it("saves a new channel before its credentials in one action, with duplicate clicks blocked", async () => {
    let acknowledge!: () => void;
    const acknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    state.save = vi.fn(async (values, revision) => {
      expect(revision).toBe("r1");
      await acknowledgment;
      state = { ...state, values, revision: "r2" };
      host.settings = state;
      renderer.update(createElement(Settings, props));
      return true;
    });
    await render();
    await act(async () =>
      renderer.root
        .findByProps({ label: channelNames.webhook, actionLabel: "添加" })
        .props.onPress(),
    );
    await fill();
    expect(
      renderer.root.findByProps({ actionLabel: "保存凭据" }).props.disabled,
    ).toBe(true);
    const press = renderer.root.findByProps({ actionLabel: "保存设置" }).props
      .onPress;
    let pending!: Promise<void>;
    await act(async () => {
      pending = press();
      void press();
    });
    expect(state.save).toHaveBeenCalledOnce();
    expect(host.write).not.toHaveBeenCalled();
    expectDraft();
    await act(async () => {
      acknowledge();
      await pending;
    });
    expect(host.write).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.values)).not.toContain(fields["Webhook 地址"]);
    expect(host.write).toHaveBeenCalledWith({
      id: state.values.channels[0]!.id,
      kind: "webhook",
      credentials: {
        url: fields["Webhook 地址"],
        signingSecret: fields["签名密钥（可选）"],
        bearerToken: fields["Bearer Token（可选）"],
        headers: { "X-Custom": "draft-header" },
        target: "",
        threadId: "",
      },
    });
    expect(renderer.root.findByProps({ label: "操作结果" }).props.hint).toBe(
      "凭据已保存",
    );
    await act(async () =>
      renderer.root
        .findByProps({ label: "更新凭据" })
        .props.onValueChange(true),
    );
    for (const label of Object.keys(fields))
      expect(input(label).props.value).toBe("");
  });

  it("keeps credential drafts and sends no credentials when the settings save conflicts", async () => {
    savedChannel();
    await render();
    await fill();
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(false);
    await click("保存设置");
    expect(state.save).toHaveBeenCalledWith(state.values, "r1");
    expect(host.write).not.toHaveBeenCalled();
    expectDraft();
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(false);
  });

  it("reports partial credential failures and retries only the remaining draft", async () => {
    savedChannel();
    state.values.channels.push(
      channelSchema.parse({ id: "channel-b", name: "Second", kind: "webhook" }),
    );
    acceptSettings();
    host.write.mockRejectedValueOnce(new Error("Temporary write failure"));
    await render();
    const inputs = renderer.root.findAllByProps({ name: "Webhook 地址" });
    await act(async () =>
      inputs[0]!.props.onChangeText(fields["Webhook 地址"]),
    );
    await act(async () =>
      inputs[1]!.props.onChangeText("https://notify.example.test/second"),
    );
    await click("保存设置");
    expect(host.write.mock.calls.map(([value]) => value.id)).toEqual([
      "channel-a",
      "channel-b",
    ]);
    expect(input("Webhook 地址").props.value).toBe(fields["Webhook 地址"]);
    const feedback = renderer.root.findByProps({ label: "保存结果" }).props
      .hint;
    expect(feedback).toContain("凭据未保存：My channel");
    expect(feedback).not.toContain("Second");
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(false);
    await click("保存设置");
    expect(host.write.mock.calls.map(([value]) => value.id)).toEqual([
      "channel-a",
      "channel-b",
      "channel-a",
    ]);
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(true);
    expect(renderer.root.findByProps({ label: "保存结果" }).props.hint).toBe(
      "设置和凭据已保存",
    );
  });

  it("does not overwrite existing credentials when only ordinary settings change", async () => {
    savedChannel("telegram");
    status.credentials = [
      { id: "channel-a", kind: "telegram", configured: true },
    ];
    acceptSettings();
    await render();
    await act(async () =>
      renderer.root
        .findByProps({ label: "包含子代理" })
        .props.onValueChange(true),
    );
    await click("保存设置");
    expect(state.save).toHaveBeenCalledOnce();
    expect(host.write).not.toHaveBeenCalled();
  });

  it("discards credential-only drafts without overwriting saved secrets", async () => {
    savedChannel();
    await render();
    await fill();
    await click("放弃修改");
    for (const label of Object.keys(fields))
      expect(input(label).props.value).toBe("");
    expect(
      renderer.root.findByProps({ actionLabel: "保存设置" }).props.disabled,
    ).toBe(true);
    expect(state.save).not.toHaveBeenCalled();
    expect(host.write).not.toHaveBeenCalled();
  });

  it("refreshes saved ordinary inputs without resetting credentials, including collapse and reopen", async () => {
    savedChannel();
    await render();
    await fill();
    host.settings = {
      ...state,
      revision: "r2",
      values: {
        ...state.values,
        channels: [{ ...state.values.channels[0]!, name: "Renamed elsewhere" }],
      },
    };
    await act(async () => renderer.update(createElement(Settings, props)));
    expect(input("名称").props.value).toBe("Renamed elsewhere");
    expectDraft();
    await act(async () =>
      renderer.root
        .findByProps({ label: "填写凭据" })
        .props.onValueChange(false),
    );
    await act(async () =>
      renderer.root
        .findByProps({ label: "填写凭据" })
        .props.onValueChange(true),
    );
    expectDraft();
  });

  it("retains input after a failed write and prevents duplicate submissions while pending", async () => {
    savedChannel();
    let reject!: (error: Error) => void;
    host.write.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await render();
    await fill();
    const press = renderer.root.findByProps({ actionLabel: "保存凭据" }).props
      .onPress;
    let pending!: Promise<void>;
    await act(async () => {
      pending = press();
      void press();
    });
    expect(host.write).toHaveBeenCalledOnce();
    for (const label of Object.keys(fields))
      expect(input(label).props.disabled).toBe(true);
    await act(async () => {
      reject(new Error("Connection lost"));
      await pending;
    });
    expectDraft();
    expect(renderer.root.findByProps({ label: "操作结果" }).props.hint).toBe(
      "Connection lost",
    );
    await click("保存凭据");
    expect(host.write).toHaveBeenCalledTimes(2);
  });

  it("preserves Telegram targets and tokens when collapsing credential fields", async () => {
    savedChannel("telegram");
    await render();
    const values = {
      服务根地址: "https://telegram.example.test",
      "Bot Token": "draft-telegram-token",
      "Chat ID": "-100123",
      "话题 ID（可选）": "42",
    };
    for (const [label, value] of Object.entries(values))
      await act(async () => input(label).props.onChangeText(value));
    await act(async () =>
      renderer.root
        .findByProps({ label: "填写凭据" })
        .props.onValueChange(false),
    );
    await act(async () =>
      renderer.root
        .findByProps({ label: "填写凭据" })
        .props.onValueChange(true),
    );
    for (const [label, value] of Object.entries(values))
      expect(input(label).props.value).toBe(value);
    await click("保存凭据");
    expect(host.write).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          url: values["服务根地址"],
          bearerToken: values["Bot Token"],
          target: "-100123",
          threadId: "42",
        }),
      }),
    );
  });

  it("does not carry credentials to another host even when channel IDs match", async () => {
    savedChannel();
    await render();
    await fill();
    host.settings = { ...state, values: structuredClone(state.values) };
    await act(async () =>
      renderer.update(
        createElement(Settings, {
          ...props,
          host: { id: "host-b", label: "Host B" },
        }),
      ),
    );
    for (const label of Object.keys(fields))
      expect(input(label).props.value).toBe("");
    expect(host.write).not.toHaveBeenCalled();
  });
});
