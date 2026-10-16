import { createRecoveryPanel } from "./client/recovery-routing";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createSettingsScreen } from "./client/settings";
import { SessionCleanup } from "./client/sessions";
import { RecoveryCard } from "./client/recovery-card";
import { recoveryCardSchema } from "./shared/contracts";
import { createRoutingPanel } from "./client/routing";
import { installRoutingButtons } from "./client/buttons";

export default function contribute(client: PluginClientContext) {
  const RoutingPanel = createRoutingPanel(client);
  const RecoveryPanel = createRecoveryPanel(client);
  client.addWorkspacePanel({
    id: "workspace-recovery",
    title: "工作区自动继续设置",
    icon: "RefreshCw",
    context: "workspace",
    Component: RecoveryPanel,
  });
  client.addWorkspacePanel({
    id: "session-recovery",
    title: "会话自动继续设置",
    icon: "RefreshCw",
    context: "agent",
    Component: RecoveryPanel,
  });
  client.addCommandCenterItem({
    id: "workspace-recovery",
    title: "Notifier：工作区自动继续设置",
    icon: "RefreshCw",
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("workspace-recovery"),
  });
  client.addCommandCenterItem({
    id: "session-recovery",
    title: "Notifier：会话自动继续设置",
    icon: "RefreshCw",
    context: "agent",
    onSelect: ({ openPanel }) => openPanel("session-recovery"),
  });
  const settings = createSettingsScreen("channels", [
    "channels",
    "schedules",
    "notifications",
    "transfer",
    "activity",
    "updates",
    "sessions",
  ]);
  const recovery = createSettingsScreen("recovery", ["recovery", "activity"]);
  client.addSettingsScreen({
    id: "settings",
    title: "通知管理",
    icon: "BellRing",
    Component: settings.Component,
  });
  client.addSettingsScreen({
    id: "recovery",
    title: "自动恢复与继续",
    icon: "RefreshCw",
    Component: recovery.Component,
  });
  client.addSettingsScreen({
    id: "sessions",
    title: "会话清理",
    icon: "Trash2",
    Component: SessionCleanup,
  });
  client.addCommandCenterItem({
    id: "open-recovery",
    title: "Notifier：自动恢复与继续",
    icon: "RefreshCw",
    context: "global",
    onSelect: ({ openSettings }) => {
      recovery.select("recovery");
      openSettings("recovery");
    },
  });
  client.addCommandCenterItem({
    id: "session-cleanup",
    title: "Notifier：会话清理",
    icon: "Trash2",
    context: "global",
    onSelect: ({ openSettings }) => openSettings("sessions"),
  });
  client.addTimelineRenderer({
    kind: "notifier-recovery",
    version: 1,
    schema: recoveryCardSchema,
    Component: RecoveryCard,
  });
  client.addCommandCenterItem({
    id: "open-settings",
    title: "Notifier：通知管理",
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
