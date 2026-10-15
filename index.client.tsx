import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createSettingsScreen } from "./client/settings";
import { RecoveryCard } from "./client/recovery-card";
import { recoveryCardSchema } from "./shared/contracts";
import { createRoutingPanel } from "./client/routing";
import { installRoutingButtons } from "./client/buttons";

export default function contribute(client: PluginClientContext) {
  const RoutingPanel = createRoutingPanel(client);
  const settings = createSettingsScreen();
  client.addSettingsScreen({
    id: "settings",
    title: "通知与自动恢复",
    icon: "BellRing",
    Component: settings.Component,
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
    onSelect: ({ openSettings }) => {
      settings.select("channels");
      openSettings("settings");
    },
  });
  client.addWorkspacePanel({
    id: "workspace-routing",
    title: "工作区通知设置",
    icon: "BellRing",
    context: "workspace",
    Component: RoutingPanel,
  });
  client.addWorkspacePanel({
    id: "session-routing",
    title: "会话通知设置",
    icon: "BellRing",
    context: "agent",
    Component: RoutingPanel,
  });
  client.addCommandCenterItem({
    id: "schedule-routing",
    title: "Notifier：定时任务通知渠道",
    icon: "BellRing",
    context: "global",
    onSelect: ({ openSettings }) => {
      settings.select("schedules");
      openSettings("settings");
    },
  });
  client.addCommandCenterItem({
    id: "workspace-routing",
    title: "Notifier：工作区通知设置",
    icon: "BellRing",
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("workspace-routing"),
  });
  client.addCommandCenterItem({
    id: "session-routing",
    title: "Notifier：会话通知设置",
    icon: "BellRing",
    context: "agent",
    onSelect: ({ openPanel }) => openPanel("session-routing"),
  });
  return installRoutingButtons(client);
}
