import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleSelection } from "../client/schedules";
import { config } from "./fixtures";

const host = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => host.read }));
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
let renderer: ReactTestRenderer;
beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  host.read.mockResolvedValue({
    schedules: [
      {
        id: "daily",
        name: "Daily",
        status: "active",
        cadence: "0 9 * * *",
        timezone: "UTC",
        cwd: "/project",
      },
    ],
    unreadable: 0,
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
describe("schedule channel selection", () => {
  it("changes only the selected task and removes its override when inheritance resumes", async () => {
    const c = config();
    c.routing.schedules.other = ["hook-a"];
    const change = vi.fn((schedules) => {
      c.routing.schedules = schedules;
      renderer.update(
        createElement(ScheduleSelection, {
          config: c,
          disabled: false,
          onChange: change,
        }),
      );
    });
    await act(async () => {
      renderer = create(
        createElement(ScheduleSelection, {
          config: c,
          disabled: false,
          onChange: change,
        }),
      );
    });
    expect(
      renderer.root.findByProps({ label: "任务默认通知去向" }).props.hint,
    ).toContain("Host");
    await act(async () =>
      renderer.root
        .findByProps({ label: "跟随上级" })
        .props.onValueChange(false),
    );
    expect(c.routing.schedules).toEqual({ other: ["hook-a"], daily: [] });
    await act(async () =>
      renderer.root.findByProps({ label: "Webhook" }).props.onValueChange(true),
    );
    expect(c.routing.schedules.daily).toEqual(["hook-a"]);
    await act(async () =>
      renderer.root
        .findByProps({ label: "跟随上级" })
        .props.onValueChange(true),
    );
    expect(c.routing.schedules).toEqual({ other: ["hook-a"] });
  });
  it("retains existing bindings when the task list cannot be read", async () => {
    host.read.mockRejectedValue(new Error("Offline"));
    const c = config();
    c.routing.schedules.saved = [];
    const change = vi.fn();
    await act(async () => {
      renderer = create(
        createElement(ScheduleSelection, {
          config: c,
          disabled: false,
          onChange: change,
        }),
      );
    });
    expect(
      renderer.root.findByProps({ label: "任务列表读取失败" }),
    ).toBeTruthy();
    expect(renderer.root.findByProps({ label: "定时任务" }).props.value).toBe(
      "saved",
    );
    expect(change).not.toHaveBeenCalled();
  });
});
