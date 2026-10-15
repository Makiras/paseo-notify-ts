import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { installRoutingButtons } from "../client/buttons";

vi.mock("@getpaseo/plugin/client", () => ({ useSettings: vi.fn() }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
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

function directory(entries: unknown[]) {
  let observer:
    | { snapshot(value: unknown): void; update(value: unknown): void }
    | undefined;
  const page = {
    entries,
    pageInfo: { hasMore: false, nextCursor: null as string | null },
    subscriptionId: "sub",
  };
  const subscription = {
    subscribe: vi.fn((next: typeof observer) => {
      observer = next;
      observer!.snapshot(page);
      return vi.fn();
    }),
    release: vi.fn(async () => {}),
  };
  return {
    page: { ...page, subscription },
    subscription,
    update: (message: unknown) => observer!.update(message),
    snapshot: () => observer!.snapshot(page),
  };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
describe("owned notification button directories", () => {
  it("registers native controls, ignores reviewers, follows moves and releases both streams", async () => {
    const agents = directory([
      { agent: { id: "a", workspaceId: "w" } },
      {
        agent: {
          id: "review",
          workspaceId: "w",
          labels: { "paseo-notifier": "reviewer" },
        },
      },
    ]);
    const workspaces = directory([{ id: "w" }]);
    const button = () => ({ update: vi.fn(), remove: vi.fn() });
    const addComposerPill = vi.fn(button),
      addHeaderButton = vi.fn(button);
    const stop = installRoutingButtons({
      paseo: {
        agents: { list: vi.fn(async () => agents.page) },
        workspaces: { list: vi.fn(async () => workspaces.page) },
      },
      addComposerPill,
      addHeaderButton,
    } as unknown as PluginClientContext);
    await flush();
    expect(addComposerPill).toHaveBeenCalledTimes(1);
    expect(addHeaderButton).toHaveBeenCalledTimes(1);
    agents.update({
      type: "agent_update",
      payload: { kind: "upsert", agent: { id: "a", workspaceId: "next" } },
    });
    expect(
      addComposerPill.mock.results[0]!.value.remove,
    ).toHaveBeenCalledOnce();
    expect(addComposerPill).toHaveBeenCalledTimes(2);
    agents.update({
      type: "agent_update",
      payload: { kind: "remove", agentId: "a" },
    });
    expect(
      addComposerPill.mock.results[1]!.value.remove,
    ).toHaveBeenCalledOnce();
    await stop();
    expect(workspaces.subscription.release).toHaveBeenCalledOnce();
    expect(agents.subscription.release).toHaveBeenCalledOnce();
    expect(
      addHeaderButton.mock.results[0]!.value.remove,
    ).toHaveBeenCalledOnce();
  });
  it("fetches remaining pages and applies live removals over stale bootstrap rows", async () => {
    const agents = directory([{ agent: { id: "a", workspaceId: "w" } }]);
    agents.page.pageInfo = {
      hasMore: true,
      nextCursor: "next",
    };
    // The owned snapshot is the first page delivered to each observer.
    agents.subscription.subscribe.mockImplementation((observer) => {
      observer!.snapshot(agents.page);
      return vi.fn();
    });
    let next!: (value: unknown) => void;
    const later = new Promise((resolve) => {
      next = resolve;
    });
    const list = vi.fn(async (options: { page: { cursor?: string } }) =>
      options.page.cursor ? later : agents.page,
    );
    const workspaces = directory([]);
    const addComposerPill = vi.fn(() => ({ update: vi.fn(), remove: vi.fn() }));
    const stop = installRoutingButtons({
      paseo: {
        agents: { list },
        workspaces: { list: vi.fn(async () => workspaces.page) },
      },
      addComposerPill,
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext);
    await flush();
    const observer = agents.subscription.subscribe.mock.calls[0]![0]!;
    observer.update({
      type: "agent_update",
      payload: { kind: "remove", agentId: "b" },
    });
    next({
      entries: [
        { agent: { id: "b", workspaceId: "w" } },
        { agent: { id: "c", workspaceId: "w" } },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await flush();
    expect(
      addComposerPill.mock.calls
        .map((call) => (call as unknown as [{ agentId: string }])[0].agentId)
        .sort(),
    ).toEqual(["a", "c"]);
    await stop();
  });
  it("releases a late bootstrap without registering controls after unload", async () => {
    const agents = directory([{ agent: { id: "a", workspaceId: "w" } }]);
    const workspaces = directory([]);
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const addComposerPill = vi.fn();
    const stop = installRoutingButtons({
      paseo: {
        agents: { list: vi.fn(() => pending) },
        workspaces: { list: vi.fn(async () => workspaces.page) },
      },
      addComposerPill,
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext);
    await stop();
    resolve(agents.page);
    await flush();
    expect(addComposerPill).not.toHaveBeenCalled();
    expect(agents.subscription.release).toHaveBeenCalledOnce();
  });
});
