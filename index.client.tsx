import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Settings } from "./client/settings";
import { RecoveryCard } from "./client/recovery-card";
import { recoveryCardSchema } from "./shared/contracts";

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
  return () => {};
}
