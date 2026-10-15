import { useRef, useState } from "react";
import { View } from "react-native";
import {
  useSettings,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
  type PluginButtonContentProps,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/config";
import { routeLabel } from "../shared/routing";
import { ChannelSelection } from "./channel-selection";

export function RoutingPanel(
  props:
    | PluginAgentPanelProps
    | PluginWorkspacePanelProps
    | PluginButtonContentProps,
) {
  const settings = useSettings(preferences);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  if (settings.status !== "ready")
    return (
      <SettingsCard>
        <SettingsRow
          label="通知配置暂不可用"
          hint={
            settings.status === "loading" ? "正在读取配置…" : "请重新读取设置"
          }
        />
        <SettingsAction
          label="重新读取"
          actionLabel="重试"
          onPress={() => void settings.reload()}
        />
      </SettingsCard>
    );
  const context = {
    workspaceId: props.workspaceId,
    agentId: props.context === "agent" ? props.agentId : undefined,
  };
  async function change(
    scope: "workspaces" | "sessions",
    id: string,
    value: string[] | undefined,
  ) {
    if (lock.current || settings.status !== "ready") return;
    lock.current = true;
    setBusy(true);
    try {
      const next = structuredClone(settings.values);
      if (value === undefined) delete next.routing[scope][id];
      else next.routing[scope][id] = value;
      await settings.save(next, settings.revision);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 16 }}>
      <SettingsCard>
        <SettingsRow
          label="当前通知去向"
          hint={routeLabel(settings.values, context)}
        />
        <SettingsRow
          label="Host → Workspace → Session"
          hint="未单独选择时跟随上级；渠道启用状态与事件、提供方过滤仍然生效"
        />
        {!settings.values.enabled && (
          <SettingsRow label="插件总开关已关闭" hint="当前不会发送通知" />
        )}
        {settings.saveError && (
          <SettingsRow label="未能保存选择" error={settings.saveError} />
        )}
        <SettingsAction
          label="读取其他客户端的最新选择"
          actionLabel="刷新"
          disabled={busy}
          onPress={() => void settings.reload()}
        />
      </SettingsCard>
      {context.agentId && (
        <SettingsSection title="Session 通知渠道">
          <ChannelSelection
            channels={settings.values.channels}
            value={settings.values.routing.sessions[context.agentId]}
            inheritable
            disabled={busy || settings.saving}
            onChange={(v) => void change("sessions", context.agentId!, v)}
          />
        </SettingsSection>
      )}
      <SettingsSection title="Workspace 通知渠道">
        <ChannelSelection
          channels={settings.values.channels}
          value={settings.values.routing.workspaces[props.workspaceId]}
          inheritable
          disabled={busy || settings.saving}
          onChange={(v) => void change("workspaces", props.workspaceId, v)}
        />
      </SettingsSection>
    </View>
  );
}
