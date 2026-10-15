import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../shared/updates";

const host = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  workspaces: vi.fn(),
  open: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: { name: string }) =>
    ({
      "notifier.updates.check": host.check,
      "notifier.updates.install": host.install,
      "notifier.updates.workspaces": host.workspaces,
    })[rpc.name],
  openExternalUrl: host.open,
}));
vi.mock("@getpaseo/plugin/client/ui", () =>
  Object.fromEntries(
    [
      "SettingsAction",
      "SettingsCard",
      "SettingsRow",
      "SettingsSection",
      "SettingsSelect",
      "SettingsSwitch",
    ].map((key) => [key, key]),
  ),
);
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  copyText: host.copy,
}));
import { UpdatesPanel } from "../client/updates";

let renderer: ReactTestRenderer;
const props = {
  automatic: true,
  savedAutomatic: true,
  revision: "r7",
  disabled: false,
  onAutomaticChange: vi.fn(),
  onBusyChange: vi.fn(),
  navigation: { openWorkspace: vi.fn(), openAgent: vi.fn() },
  host: { id: "host-a", label: "Host A" },
};
const status: UpdateStatus = {
  currentVersion: "0.2.0",
  currentRevision: "a".repeat(40),
  release: {
    id: 42,
    version: "0.3.0",
    tag: "v0.3.0",
    url: "https://github.com/Makiras/paseo-notify-ts/releases/tag/v0.3.0",
    publishedAt: "2026-10-15T00:00:00Z",
  },
  available: true,
  checkedAt: 1000000,
  error: null,
  canInstall: true,
  installHint: "在 Host 终端安装",
  command: "paseo plugin update paseo-notifier --ref v0.3.0",
};
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  host.check.mockResolvedValue(status);
  host.install.mockResolvedValue({ workspaceId: "w1", terminalId: "t1" });
  host.workspaces.mockResolvedValue([{ id: "w1", name: "Project" }]);
  host.open.mockResolvedValue(undefined);
  host.copy.mockResolvedValue(undefined);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render(disabled = false) {
  await act(async () => {
    renderer = create(createElement(UpdatesPanel, { ...props, disabled }));
  });
}
async function chooseWorkspace() {
  await act(async () =>
    renderer.root.findByProps({ actionLabel: "选择工作区" }).props.onPress(),
  );
  await act(async () =>
    renderer.root
      .findByProps({ label: "安装终端所在工作区" })
      .props.onValueChange("w1"),
  );
}
describe("updates UI", () => {
  it("checks on open but never installs without an explicit workspace and click", async () => {
    await render();
    expect(host.check).toHaveBeenCalledWith({ force: false });
    expect(host.install).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ actionLabel: "安装 v0.3.0" }),
    ).toHaveLength(0);
    await chooseWorkspace();
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "安装 v0.3.0" }).props.onPress(),
    );
    expect(host.install).toHaveBeenCalledWith({
      releaseId: 42,
      tag: "v0.3.0",
      workspaceId: "w1",
      revision: "r7",
    });
    expect(
      renderer.root.findByProps({ actionLabel: "安装 v0.3.0" }).props.disabled,
    ).toBe(true);
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "打开工作区" }).props.onPress(),
    );
    expect(props.navigation.openWorkspace).toHaveBeenCalledWith({
      workspaceId: "w1",
      serverId: "host-a",
    });
  });
  it("blocks installation while a settings or credential draft exists", async () => {
    await render();
    await chooseWorkspace();
    await act(async () =>
      renderer.update(
        createElement(UpdatesPanel, { ...props, disabled: true }),
      ),
    );
    expect(
      renderer.root.findByProps({ actionLabel: "安装 v0.3.0" }).props.disabled,
    ).toBe(true);
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "安装 v0.3.0" }).props.onPress(),
    );
    expect(host.install).not.toHaveBeenCalled();
  });
  it("keeps failed installation receipts distinct from success", async () => {
    host.install.mockRejectedValueOnce(new Error("offline"));
    await render();
    await chooseWorkspace();
    await act(async () =>
      renderer.root.findByProps({ actionLabel: "安装 v0.3.0" }).props.onPress(),
    );
    expect(
      renderer.root.findByProps({ label: "更新提示" }).props.error,
    ).toContain("回执未确认");
    expect(renderer.root.findAllByProps({ label: "更新操作" })).toHaveLength(0);
    expect(props.onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("does not expose the installer when the Host source cannot be verified", async () => {
    host.check.mockResolvedValueOnce({
      ...status,
      canInstall: false,
      command: null,
    });
    await render();
    expect(
      renderer.root.findAllByProps({ actionLabel: "选择工作区" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ actionLabel: "GitHub Releases" }),
    ).toBeTruthy();
  });
});
