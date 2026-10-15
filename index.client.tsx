import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Settings } from "./client/settings";
import { RecoveryCard } from "./client/recovery-card";
import { recoveryCardSchema } from "./shared/contracts";
import { RoutingPanel } from "./client/routing";
import { installRoutingButtons } from "./client/buttons";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "settings",
    title: "通知与自动恢复",
    icon: "BellRing",
    Component: Settings,
  });
  client.addTimelineRenderer({
    kind: "notifier-recovery",
    version: 1,
    schema: recoveryCardSchema,
    Component: RecoveryCard,
  });
  client.addCommandCenterItem({
    id: "open-settings",
    title: "Notifier：通知与自动恢复",
    icon: "BellRing",
    context: "global",
    onSelect: ({ openSettings }) => openSettings("settings"),
  });
  client.addWorkspacePanel({
    id: "workspace-routing",
    title: "通知渠道",
    icon: "BellRing",
    context: "workspace",
    Component: RoutingPanel,
  });
  client.addWorkspacePanel({
    id: "session-routing",
    title: "通知渠道",
    icon: "BellRing",
    context: "agent",
    Component: RoutingPanel,
  });
  client.addCommandCenterItem({
    id: "workspace-routing",
    title: "Notifier：工作区通知渠道",
    icon: "BellRing",
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("workspace-routing"),
  });
  client.addCommandCenterItem({
    id: "session-routing",
    title: "Notifier：会话通知渠道",
    icon: "BellRing",
    context: "agent",
    onSelect: ({ openPanel }) => openPanel("session-routing"),
  });
  return installRoutingButtons(client);
}
