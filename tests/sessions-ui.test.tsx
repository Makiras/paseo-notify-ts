import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDelete } from "../client/session-delete";
import { SessionCleanup } from "../client/sessions";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: { name: string }) =>
    rpc.name.endsWith("prepare-delete")
      ? mocks.prepare
      : rpc.name.endsWith(".delete")
        ? mocks.remove
        : mocks.list,
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: "TextInput",
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
    ].map((name) => [name, name]),
  ),
);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = {
  id,
  title: "测试归档",
  provider: "codex",
  cwd: "/test",
  status: "closed",
  archivedAt: "2026-10-16",
  updatedAt: "2026-10-16T00:00:00Z",
  workspaceId: "w",
};
const props = {
  theme: { colors: { statusDanger: "red" } },
  host: { id: "host", label: "Test" },
  layout: { compact: false, platform: "web" },
} as PluginSurfaceProps;
let renderer: ReactTestRenderer;
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue({ token: id, sessions: [session] });
  mocks.remove.mockResolvedValue({ ok: true, message: "已删除" });
  mocks.list.mockResolvedValue({
    sessions: [session],
    nextCursor: null,
    canDelete: true,
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
const press = (label: string) =>
  act(async () =>
    renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(),
  );
const action = (label: string) =>
  act(async () =>
    renderer.root.findByProps({ actionLabel: label }).props.onPress(),
  );
describe("session cleanup confirmation", () => {
  it("requires a second explicit red action and allows cancellation without deletion", async () => {
    await act(async () => {
      renderer = create(
        createElement(SessionDelete, { ids: [id], theme: props.theme }),
      );
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    await press("删除会话");
    expect(
      renderer.root.findByProps({ label: "测试归档" }).props.hint,
    ).toContain(id);
    expect(mocks.remove).not.toHaveBeenCalled();
    await action("取消删除");
    expect(mocks.remove).not.toHaveBeenCalled();
    await press("删除会话");
    await press("确认删除 1 个会话");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ token: id, id });
    expect(
      renderer.root.findByProps({ label: "删除结果" }).props.hint,
    ).toContain("已删除 1");
  });
  it("clears confirmation when selection changes and reports partial batch failures", async () => {
    const onDone = vi.fn();
    await act(async () => {
      renderer = create(
        createElement(SessionDelete, { ids: [id], theme: props.theme, onDone }),
      );
    });
    await press("删除会话");
    await act(async () =>
      renderer.update(
        createElement(SessionDelete, {
          ids: [id, other],
          theme: props.theme,
          onDone,
        }),
      ),
    );
    expect(
      renderer.root.findAllByProps({ testID: "session-delete-confirmation" }),
    ).toHaveLength(0);
    mocks.prepare.mockResolvedValue({
      token: id,
      sessions: [session, { ...session, id: other, title: "第二条" }],
    });
    mocks.remove
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: "会话仍存在" });
    await press("删除选中的 2 个会话");
    await press("确认删除 2 个会话");
    expect(onDone).toHaveBeenCalledWith([id]);
    expect(
      renderer.root.findByProps({ label: "删除结果" }).props.hint,
    ).toContain("第二条：会话仍存在");
  });
  it("merges pagination, filters archived sessions, and removes only successful deletions", async () => {
    mocks.list
      .mockResolvedValueOnce({
        sessions: [session],
        nextCursor: "next",
        canDelete: true,
      })
      .mockResolvedValueOnce({
        sessions: [
          { ...session, id: other, title: "活跃会话", archivedAt: null },
        ],
        nextCursor: null,
        canDelete: true,
      });
    await act(async () => {
      renderer = create(createElement(SessionCleanup, props));
    });
    await action("加载更多会话");
    expect(mocks.list).toHaveBeenLastCalledWith({ cursor: "next" });
    expect(renderer.root.findAllByProps({ label: "活跃会话" })).toHaveLength(0);
    await action("选择当前结果");
    await press("删除会话");
    expect(mocks.prepare).toHaveBeenCalledWith({
      ids: [id],
      archivedOnly: true,
    });
    await press("确认删除 1 个会话");
    expect(
      renderer.root.findAllByProps({ testID: `cleanup-session-${id}` }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ label: "删除结果" }).props.hint,
    ).toContain("已删除 1");
    await act(async () =>
      renderer.root
        .findByProps({ label: "查看范围" })
        .props.onValueChange("all"),
    );
    expect(renderer.root.findByProps({ label: "活跃会话" }).props.value).toBe(
      false,
    );
  });
  it("resets selected sessions when switching hosts", async () => {
    await act(async () => {
      renderer = create(createElement(SessionCleanup, props));
    });
    await action("选择当前结果");
    await press("删除会话");
    await act(async () =>
      renderer.update(
        createElement(SessionCleanup, {
          ...props,
          host: { id: "other", label: "Other" },
        }),
      ),
    );
    expect(
      renderer.root.findAllByProps({ testID: "session-delete-confirmation" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ accessibilityLabel: "删除会话" }).props
        .disabled,
    ).toBe(true);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
