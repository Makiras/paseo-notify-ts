import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginSurfaceProps,
  SettingsState,
} from "@getpaseo/plugin/client";
import { configSchema } from "../shared/config";
import { ConfigTransfer } from "../client/transfer";
import { config, memory } from "./fixtures";
import { exportConfiguration, planImport } from "../server/transfer";
import { parseTransfer } from "../shared/transfer";

const host = vi.hoisted(() => ({
  export: vi.fn(),
  prepare: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: { name: string }) =>
    rpc.name.endsWith("export") ? host.export : host.prepare,
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: "TextInput",
  copyText: host.copy,
}));
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
let imported: ReturnType<typeof vi.fn>;
const theme = {
  colors: { foreground: "black", foregroundMuted: "gray" },
} as PluginSurfaceProps["theme"];
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
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
  imported = vi.fn();
  host.export.mockResolvedValue({ text: "exported" });
  host.copy.mockResolvedValue(undefined);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render(disabled = false) {
  await act(async () => {
    renderer = create(
      createElement(ConfigTransfer, {
        settings: state,
        theme,
        disabled,
        onBusyChange: vi.fn(),
        onImported: imported,
      }),
    );
  });
}
async function click(actionLabel: string) {
  await act(async () =>
    renderer.root.findByProps({ actionLabel }).props.onPress(),
  );
}
async function paste(text: string) {
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: "待导入的配置 JSON" })
      .props.onChangeText(text),
  );
}

describe("clipboard configuration controls", () => {
  it("exports without credentials by default and includes them only after selection", async () => {
    await render();
    expect(host.copy).not.toHaveBeenCalled();
    await click("复制配置");
    expect(host.export).toHaveBeenLastCalledWith({
      revision: "r1",
      includeCredentials: false,
    });
    expect(host.copy).toHaveBeenCalledWith("exported");
    await act(async () =>
      renderer.root
        .findByProps({ label: "导出包含凭据" })
        .props.onValueChange(true),
    );
    await click("复制配置");
    expect(host.export).toHaveBeenLastCalledWith({
      revision: "r1",
      includeCredentials: true,
    });
  });
  it("retains a prepared export for a direct-click retry when the clipboard is denied", async () => {
    host.copy.mockRejectedValue(new Error("denied"));
    await render();
    await click("复制配置");
    expect(
      renderer.root.findByProps({ label: "导入导出结果" }).props.hint,
    ).toContain("未能写入剪贴板");
    host.copy.mockResolvedValue(undefined);
    await click("复制配置");
    expect(host.export).toHaveBeenCalledTimes(1);
    expect(host.copy).toHaveBeenCalledTimes(2);
    expect(
      renderer.root.findByProps({ label: "导入导出结果" }).props.hint,
    ).toContain("已复制普通配置");
  });
  it("requires preview, saves against the prepared revision, and clears pasted secrets on success", async () => {
    await render();
    const text = exportConfiguration(config(), memory().secrets.read(), true);
    const { staged: _staged, ...plan } = planImport(
      state.values,
      memory().secrets.read(),
      parseTransfer(text),
    );
    host.prepare.mockResolvedValue({ ...plan, revision: "r1" });
    await paste(text);
    expect(
      renderer.root.findAllByProps({ actionLabel: "应用导入" }),
    ).toHaveLength(0);
    await click("预览导入");
    expect(host.prepare).not.toHaveBeenCalled();
    await click("应用导入");
    expect(state.save).toHaveBeenCalledWith(plan.config, "r1");
    expect(imported).toHaveBeenCalledOnce();
    expect(
      renderer.root.findByProps({ accessibilityLabel: "待导入的配置 JSON" })
        .props.value,
    ).toBe("");
  });
  it("keeps pasted input on a save conflict without claiming the import succeeded", async () => {
    state.save = vi.fn(async () => false);
    await render();
    const text = exportConfiguration(config(), {}, false);
    host.prepare.mockResolvedValue({
      config: state.values,
      revision: "r1",
      added: 0,
      reused: 1,
      missingCredentials: 1,
    });
    await paste(text);
    await click("预览导入");
    await click("应用导入");
    expect(imported).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ label: "导入导出结果" }).props.hint,
    ).toContain("导入未生效");
    expect(
      renderer.root.findByProps({ accessibilityLabel: "待导入的配置 JSON" })
        .props.value,
    ).toBe(text);
  });
  it("invalidates the preview when pasted content is edited and blocks unsaved host drafts", async () => {
    await render();
    await paste(exportConfiguration(config(), {}, false));
    await click("预览导入");
    await paste("invalid private content");
    expect(
      renderer.root.findAllByProps({ actionLabel: "应用导入" }),
    ).toHaveLength(0);
    await click("预览导入");
    expect(
      renderer.root.findByProps({ label: "导入导出结果" }).props.hint,
    ).not.toContain("private content");
    await act(async () => renderer.unmount());
    await render(true);
    expect(
      renderer.root.findByProps({ actionLabel: "复制配置" }).props.disabled,
    ).toBe(true);
  });
});
