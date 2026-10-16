import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import {
  useSettings,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
  type PluginButtonContentProps,
  type PluginClientContext,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  configSchema,
  preferences,
  recoverySchema,
  type RecoveryConfig,
} from "../shared/config";
import { resolveRecovery } from "../shared/recovery";
import { RecoverySettings } from "./recovery-settings";

type Props =
  | PluginAgentPanelProps
  | PluginWorkspacePanelProps
  | PluginButtonContentProps;
type Ready = Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
export function createRecoveryPanel(
  client: Pick<PluginClientContext, "openPanel">,
) {
  return function Panel(props: Props) {
    return (
      <RecoveryPanel
        {...props}
        onOpenWorkspace={() => {
          client.openPanel("workspace-recovery", {
            workspaceId: props.workspaceId,
          });
          if ("close" in props) props.close();
        }}
      />
    );
  };
}
export function RecoveryPanel(props: Props & { onOpenWorkspace?: () => void }) {
  const settings = useSettings(preferences);
  if (settings.status !== "ready")
    return (
      <SettingsCard>
        <SettingsRow
          label="自动继续配置暂不可用"
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
  return (
    <Editor
      key={`${props.host.id}:${props.workspaceId}:${props.context === "agent" ? props.agentId : "workspace"}`}
      {...props}
      settings={settings}
    />
  );
}
function Editor(
  props: Props & { settings: Ready; onOpenWorkspace?: () => void },
) {
  const { settings } = props;
  const agentId = props.context === "agent" ? props.agentId : undefined;
  const scope = agentId ? "sessions" : "workspaces";
  const id = agentId ?? props.workspaceId;
  const resolved = resolveRecovery(settings.values, {
    agentId,
    workspaceId: props.workspaceId,
  });
  const [draft, setDraft] = useState<RecoveryConfig | undefined>(
    () => settings.values.recoveryOverrides[scope][id],
  );
  const [revision, setRevision] = useState(settings.revision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    if (!dirty && revision !== settings.revision) {
      setDraft(settings.values.recoveryOverrides[scope][id]);
      setRevision(settings.revision);
      setFormKey((v) => v + 1);
    }
  }, [dirty, revision, settings.revision, settings.values, scope, id]);
  const stale = revision !== settings.revision;
  const change = (value: RecoveryConfig | undefined) => {
    if (lock.current || settings.saving) return;
    setDraft(value);
    setDirty(true);
    setMessage("");
  };
  const parsed =
    draft === undefined ? undefined : recoverySchema.safeParse(draft);
  async function save() {
    if (lock.current || stale || !dirty || (parsed && !parsed.success)) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const next = structuredClone(settings.values);
      if (draft === undefined) delete next.recoveryOverrides[scope][id];
      else next.recoveryOverrides[scope][id] = recoverySchema.parse(draft);
      if (await settings.save(next, revision)) {
        setDirty(false);
        setMessage("已保存");
      } else
        setMessage(
          "保存失败，请重新读取最新设置后再试。你的修改仍保留在页面中。",
        );
    } catch {
      setMessage("保存失败，请检查连接后重试。你的修改仍保留在页面中。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const disabled = busy || settings.saving;
  return (
    <View style={{ gap: 12 }}>
      <SettingsCard>
        <SettingsRow
          label={agentId ? "会话自动继续" : "工作区自动继续"}
          hint={`当前生效：${resolved.value.enabled ? "开启" : "关闭"} · ${{ host: "Host", workspace: "Workspace", session: "Session" }[resolved.source]}`}
        />
        <SettingsRow
          label="Host → Workspace → Session"
          hint="跟随上级时，上级修改会同步生效。单独配置只作用于当前范围；更具体的会话设置优先。"
        />
        {!settings.values.enabled && (
          <SettingsRow
            label="插件总开关已关闭"
            hint="这里的设置会保留，但暂不执行自动继续。"
          />
        )}
        <SettingsSwitch
          label="跟随上级"
          value={draft === undefined}
          disabled={disabled}
          hint="关闭后，以当前生效参数开始单独配置。修改后点击保存。"
          onValueChange={(inherit) =>
            change(inherit ? undefined : structuredClone(resolved.value))
          }
        />
        {draft !== undefined && (
          <View pointerEvents={disabled ? "none" : "auto"}>
            <RecoverySettings
              key={formKey}
              value={draft}
              onChange={change}
              compact
              disabled={disabled}
            />
          </View>
        )}
        {parsed && !parsed.success && (
          <SettingsRow
            label="请检查设置"
            error={parsed.error.issues[0]?.message}
          />
        )}
        {stale && dirty && (
          <SettingsRow
            label="设置已在其他页面更新"
            hint="为避免覆盖新设置，请先重新读取，再修改并保存。"
          />
        )}
        {(message || settings.saveError) && (
          <SettingsRow
            label={message || "保存失败"}
            error={settings.saveError ?? undefined}
          />
        )}
        <SettingsAction
          label={dirty ? "有尚未保存的修改" : "配置已同步"}
          actionLabel="保存"
          disabled={disabled || !dirty || stale || parsed?.success === false}
          onPress={() => void save()}
        />
        <SettingsAction
          label="放弃本页修改并读取最新设置"
          actionLabel="重新读取"
          disabled={disabled}
          onPress={() => {
            setDraft(settings.values.recoveryOverrides[scope][id]);
            setRevision(settings.revision);
            setDirty(false);
            setMessage("");
            setFormKey((v) => v + 1);
            void settings.reload();
          }}
        />
      </SettingsCard>
      {agentId && props.onOpenWorkspace && (
        <SettingsCard>
          <SettingsAction
            label="工作区自动继续设置"
            hint={
              dirty
                ? "请先保存本页修改，再打开工作区设置"
                : "设置当前工作区的默认恢复方式"
            }
            actionLabel="打开"
            disabled={disabled || dirty}
            onPress={props.onOpenWorkspace}
          />
        </SettingsCard>
      )}
    </View>
  );
}
