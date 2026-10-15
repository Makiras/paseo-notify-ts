import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  configSchema,
  preferences,
  channelKindSchema,
  channelNames,
  type Config,
} from "../shared/config";
import {
  deleteCredentialsRpc,
  statusRpc,
  type RuntimeStatus,
} from "../shared/contracts";
import {
  ChannelEditor,
  newChannel,
  type CredentialEditorHandle,
} from "./channel-editor";
import { Activity } from "./activity";
import { ReviewSettings } from "./review-settings";
import { ChannelSelection } from "./channel-selection";
import { ConfigTransfer } from "./transfer";
import { withoutChannel } from "../shared/routing";
import { ScheduleSelection } from "./schedules";
import { UpdatesPanel } from "./updates";
import {
  createSettingsNavigation,
  SectionNavigation,
  SettingsPanel,
  type SettingsNavigation,
  type SettingsSectionId,
} from "./settings-sections";

type SettingsProps = PluginSurfaceProps & {
  sectionNavigation?: SettingsNavigation;
};

export function createSettingsScreen() {
  const sectionNavigation = createSettingsNavigation();
  return {
    select: sectionNavigation.select,
    Component: function SettingsScreen(props: PluginSurfaceProps) {
      return <Settings {...props} sectionNavigation={sectionNavigation} />;
    },
  };
}

export function Settings(props: SettingsProps) {
  const settings = useSettings(preferences);
  if (settings.status !== "ready")
    return (
      <SettingsSection title="通知与自动恢复">
        <SettingsCard>
          <SettingsRow
            label={
              settings.status === "loading" ? "正在读取设置…" : "设置暂不可用"
            }
            error={
              settings.status === "error" || settings.status === "invalid"
                ? settings.error
                : undefined
            }
          />
          {settings.status !== "loading" && (
            <SettingsAction
              label="重新读取配置"
              actionLabel="重试"
              onPress={() => void settings.reload()}
            />
          )}
          {settings.status === "invalid" && (
            <SettingsAction
              label="将普通设置恢复为默认值"
              hint="此操作会移除渠道配置，凭据文件会保留"
              actionLabel="重置设置"
              disabled={settings.saving}
              onPress={() => void settings.reset()}
            />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  return <Editor key={props.host.id} {...props} settings={settings} />;
}

function Editor({
  settings,
  theme,
  navigation,
  host,
  layout,
  sectionNavigation,
}: SettingsProps & {
  settings: Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
}) {
  const [localNavigation] = useState(createSettingsNavigation);
  const sections = sectionNavigation ?? localNavigation;
  const section = useSyncExternalStore(sections.subscribe, sections.current);
  const [draft, setDraft] = useState<Config>(settings.values);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const activeChannel = draft.channels.some((c) => c.id === selectedChannel)
    ? selectedChannel
    : draft.channels[0]?.id;
  const [newChannelKind, setNewChannelKind] =
    useState<(typeof channelKindSchema.options)[number]>("webhook");
  const [revision, setRevision] = useState(settings.revision);
  const [dirty, setDirty] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [credentials, setCredentials] = useState<RuntimeStatus["credentials"]>(
    [],
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const statusRequest = useRef(0);
  const saving = useRef(false);
  const [savingAll, setSavingAll] = useState(false);
  const credentialEditors = useRef(new Map<string, CredentialEditorHandle>());
  const [credentialStates, setCredentialStates] = useState<
    Record<string, { dirty: boolean; busy: boolean }>
  >({});
  const onCredentialState = useCallback(
    (id: string, dirty: boolean, busy: boolean) => {
      setCredentialStates((previous) =>
        previous[id]?.dirty === dirty && previous[id]?.busy === busy
          ? previous
          : { ...previous, [id]: { dirty, busy } },
      );
    },
    [],
  );
  const credentialsDirty = draft.channels.some(
    (c) => credentialStates[c.id]?.dirty,
  );
  const credentialsBusy = draft.channels.some(
    (c) => credentialStates[c.id]?.busy,
  );
  const [updateBusy, setUpdateBusy] = useState(false);
  const busy = savingAll || settings.saving || updateBusy;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [transferBusy, setTransferBusy] = useState(false);
  const readStatus = useRpc(statusRpc),
    removeCredentials = useRpc(deleteCredentialsRpc);
  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    try {
      const next = await readStatus({});
      if (!mounted.current || request !== statusRequest.current) return;
      setStatus(next);
      // The server's unavailable-state response contains an empty placeholder,
      // not evidence that credentials were removed after a confirmed save.
      if (!next.storageError) setCredentials(next.credentials);
      setStatusError(null);
    } catch {
      if (mounted.current && request === statusRequest.current)
        setStatusError("无法读取运行状态");
    }
  }, [readStatus]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void update(), 5000);
    };
    void update();
    return () => {
      active = false;
      clearTimeout(timer);
      statusRequest.current++;
    };
  }, [refresh]);
  function credentialsSaved(channel: Config["channels"][number]) {
    if (!mounted.current) return;
    // A successful write is authoritative; a status read started before it
    // must not turn the test button off when its older snapshot arrives.
    statusRequest.current++;
    setCredentials((current) => [
      ...current.filter((c) => c.id !== channel.id),
      { id: channel.id, kind: channel.kind, configured: true },
    ]);
    // The unified save refreshes once after all writes and removals finish.
    if (!saving.current) void refresh();
  }
  useEffect(() => {
    if (!dirty && settings.revision !== revision) {
      setDraft(settings.values);
      setRevision(settings.revision);
      setFormKey((n) => n + 1);
    }
  }, [dirty, settings.revision, settings.values, revision]);
  const patch = (value: Partial<Config>) => {
    if (saving.current || transferBusy || updateBusy) return;
    setDraft((d) => ({ ...d, ...value }));
    setDirty(true);
    setFeedback(null);
  };
  const recovery = (value: Partial<Config["recovery"]>) =>
    patch({ recovery: { ...draft.recovery, ...value } });
  const numeric = (value: string) =>
    /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  const valid = configSchema.safeParse(draft);
  function showValidationError() {
    if (valid.success) return;
    const path = valid.error.issues[0]?.path ?? [];
    let target: SettingsSectionId = "channels";
    if (path[0] === "recovery") target = "recovery";
    else if (path[0] === "notifications" || path[0] === "includeSubagents")
      target = "notifications";
    else if (path[0] === "routing" && path[1] === "schedules")
      target = "schedules";
    else if (path[0] === "updates") target = "updates";
    if (path[0] === "channels" && typeof path[1] === "number")
      setSelectedChannel(draft.channels[path[1]]?.id ?? null);
    sections.select(target);
  }
  async function save() {
    const result = configSchema.safeParse(draft);
    if (
      !result.success ||
      saving.current ||
      settings.saving ||
      transferBusy ||
      updateBusy
    )
      return;
    const editors = draft.channels.map((channel) => ({
      channel,
      editor: credentialEditors.current.get(channel.id),
    }));
    if (editors.some(({ editor }) => editor?.busy)) return;
    const pending = editors.filter(({ editor }) => editor?.dirty);
    saving.current = true;
    setSavingAll(true);
    setFeedback(null);
    const removed = settings.values.channels.filter(
      (c) => !draft.channels.some((next) => next.id === c.id),
    );
    try {
      // Preserve the configuration revision check, then submit secret drafts via
      // their private RPCs. Do not put credentials in the settings document.
      const ok = await settings.save(result.data, revision);
      if (!ok || !mounted.current) return;
      setDirty(false);
      const failed: string[] = [];
      for (const { channel, editor } of pending) {
        if (!mounted.current) return;
        if (!(await editor!.saveCredentials())) failed.push(channel.name);
      }
      let cleanupFailed = false;
      for (const channel of removed) {
        if (!mounted.current) return;
        try {
          await removeCredentials({ id: channel.id });
        } catch {
          cleanupFailed = true;
        }
      }
      setFeedback(
        [
          failed.length
            ? `设置已保存；以下渠道的凭据未保存：${failed.join("、")}。输入已保留，请重试。`
            : pending.length
              ? "设置和凭据已保存"
              : "设置已保存",
          cleanupFailed ? "旧渠道凭据未能清理，请检查连接。" : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      // Refresh in the background; confirmed saves do not depend on another
      // network round trip before the user can test their saved channel.
      void refresh();
    } catch {
      setFeedback("保存设置失败，已保留输入，请检查连接后重试");
    } finally {
      saving.current = false;
      if (mounted.current) setSavingAll(false);
    }
  }
  return (
    <View style={{ gap: 16 }}>
      <SectionNavigation
        value={section}
        onChange={sections.select}
        theme={theme}
        compact={layout.compact}
      />
      <SettingsSection title="全局设置">
        <SettingsCard>
          <SettingsSwitch
            label="启用通知与恢复"
            value={draft.enabled}
            disabled={busy || transferBusy}
            onValueChange={(enabled) => patch({ enabled })}
          />
          <SettingsAction
            label={dirty || credentialsDirty ? "有未保存的修改" : "配置已同步"}
            hint="保存所有栏目：先保存设置，再保存已填写的渠道凭据。切换栏目会保留草稿。"
            actionLabel={busy ? "保存中…" : "保存设置"}
            disabled={
              (!dirty && !credentialsDirty) ||
              busy ||
              credentialsBusy ||
              transferBusy ||
              !valid.success
            }
            onPress={save}
          />
          {(dirty || credentialsDirty) && (
            <SettingsAction
              label="放弃未保存的设置和凭据，读取最新设置"
              actionLabel="放弃修改"
              disabled={busy || credentialsBusy || transferBusy}
              onPress={() => {
                for (const editor of credentialEditors.current.values())
                  editor.discardCredentials();
                setDraft(settings.values);
                setRevision(settings.revision);
                setDirty(false);
                setFormKey((n) => n + 1);
                setFeedback(null);
              }}
            />
          )}
          {dirty && revision !== settings.revision && (
            <SettingsRow
              label="其他客户端已修改配置"
              hint="你的草稿已保留；请放弃修改读取新配置，再重新编辑"
            />
          )}
          {!valid.success && (
            <SettingsAction
              label="请检查设置"
              error={valid.error.issues
                .map((i) => `${i.path.join(".")}：${i.message}`)
                .join("；")}
              actionLabel="前往修改"
              onPress={showValidationError}
            />
          )}
          {(settings.saveError || feedback) && (
            <SettingsRow
              label="保存结果"
              error={settings.saveError}
              hint={feedback ?? undefined}
            />
          )}
        </SettingsCard>
      </SettingsSection>
      <View
        style={{
          gap: 16,
          display: [
            "channels",
            "schedules",
            "recovery",
            "notifications",
          ].includes(section)
            ? "flex"
            : "none",
        }}
        pointerEvents={transferBusy || busy ? "none" : "auto"}
      >
        <SettingsPanel active={section === "channels"}>
          <SettingsSection title="渠道管理">
            <SettingsCard>
              {draft.channels.length ? (
                <SettingsSelect
                  label="编辑渠道"
                  value={activeChannel ?? ""}
                  options={draft.channels.map((c, index) => ({
                    value: c.id,
                    label: `${index + 1}. ${c.name || channelNames[c.kind]}${credentialStates[c.id]?.dirty ? "（凭据待保存）" : ""}`,
                  }))}
                  onValueChange={setSelectedChannel}
                />
              ) : (
                <SettingsRow
                  label="尚未注册通知渠道"
                  hint="选择平台并添加一个接收目标，再填写连接信息。"
                />
              )}
              <SettingsSelect
                label="新渠道平台"
                value={newChannelKind}
                options={channelKindSchema.options.map((kind) => ({
                  value: kind,
                  label: channelNames[kind],
                }))}
                disabled={busy || transferBusy || draft.channels.length >= 20}
                onValueChange={(kind) => {
                  const parsed = channelKindSchema.safeParse(kind);
                  if (parsed.success) setNewChannelKind(parsed.data);
                }}
              />
              <SettingsAction
                label="注册新的接收目标"
                hint={
                  draft.channels.length >= 20
                    ? "最多注册 20 个渠道"
                    : "同一平台可以添加多个群组或设备"
                }
                actionLabel="添加渠道"
                disabled={busy || transferBusy || draft.channels.length >= 20}
                onPress={() => {
                  if (busy || transferBusy || draft.channels.length >= 20)
                    return;
                  const channel = newChannel(newChannelKind);
                  patch({ channels: [...draft.channels, channel] });
                  setSelectedChannel(channel.id);
                }}
              />
            </SettingsCard>
          </SettingsSection>
          {draft.channels.map((channel) => (
            <SettingsPanel
              key={`${channel.id}:${channel.kind}`}
              active={activeChannel === channel.id}
            >
              <ChannelEditor
                ref={(editor) => {
                  if (editor) credentialEditors.current.set(channel.id, editor);
                  else credentialEditors.current.delete(channel.id);
                }}
                settingsKey={formKey}
                disabled={busy || transferBusy}
                onCredentialState={onCredentialState}
                channel={channel}
                saved={settings.values.channels.some(
                  (c) => c.id === channel.id && c.kind === channel.kind,
                )}
                configured={credentials.some(
                  (c) =>
                    c.id === channel.id &&
                    c.kind === channel.kind &&
                    c.configured,
                )}
                onChange={(next) =>
                  patch({
                    channels: draft.channels.map((c) =>
                      c.id === next.id ? next : c,
                    ),
                  })
                }
                onRemove={() => patch(withoutChannel(draft, channel.id))}
                onCredentialsSaved={() => credentialsSaved(channel)}
                onCredentialsChanged={() => void refresh()}
              />
            </SettingsPanel>
          ))}
          {/* Refresh ordinary inputs without unmounting credential drafts. */}
          <SettingsSection
            key={`defaults:${formKey}`}
            title="Host 默认通知渠道"
          >
            <ChannelSelection
              channels={draft.channels}
              value={draft.routing.host}
              disabled={busy || transferBusy}
              onChange={(ids) =>
                patch({ routing: { ...draft.routing, host: ids ?? [] } })
              }
            />
          </SettingsSection>
        </SettingsPanel>
        <SettingsPanel active={section === "schedules"}>
          <ScheduleSelection
            config={draft}
            disabled={busy || transferBusy}
            onChange={(schedules) =>
              patch({ routing: { ...draft.routing, schedules } })
            }
          />
        </SettingsPanel>
        <SettingsPanel active={section === "recovery"}>
          <SettingsSection key={`recovery:${formKey}`} title="自动恢复">
            <SettingsCard>
              <SettingsSwitch
                label="自动继续"
                hint="仅恢复网络、请求限流和服务繁忙；安全拦截、额度和上下文问题会通知你处理"
                value={draft.recovery.enabled}
                onValueChange={(enabled) => recovery({ enabled })}
              />
              <SettingsSwitch
                label="网络故障"
                value={draft.recovery.network}
                onValueChange={(network) => recovery({ network })}
              />
              <SettingsSwitch
                label="服务繁忙 / 容量不足"
                value={draft.recovery.overloaded}
                onValueChange={(overloaded) => recovery({ overloaded })}
              />
              <SettingsSwitch
                label="请求限流"
                value={draft.recovery.rateLimited}
                onValueChange={(rateLimited) => recovery({ rateLimited })}
              />
              <SettingsInput
                label="最大重试次数"
                initialValue={String(draft.recovery.maxAttempts)}
                onChangeText={(v) => recovery({ maxAttempts: numeric(v) })}
              />
              <SettingsInput
                label="恢复时间上限（分钟）"
                initialValue={String(draft.recovery.maxElapsedMinutes)}
                onChangeText={(v) =>
                  recovery({ maxElapsedMinutes: numeric(v) })
                }
              />
              <SettingsInput
                label="初始等待（秒）"
                initialValue={String(draft.recovery.baseDelaySeconds)}
                onChangeText={(v) => recovery({ baseDelaySeconds: numeric(v) })}
              />
              <SettingsInput
                label="最长退避等待（秒）"
                hint="服务明确要求更久时，遵守其等待时间；超出恢复预算则停止"
                initialValue={String(draft.recovery.maxDelaySeconds)}
                onChangeText={(v) => recovery({ maxDelaySeconds: numeric(v) })}
              />
              <SettingsInput
                label="继续指令"
                initialValue={draft.recovery.prompt}
                onChangeText={(prompt) => recovery({ prompt })}
              />
              <ReviewSettings
                recoveryEnabled={draft.recovery.enabled}
                value={draft.recovery.review}
                onChange={(review) => recovery({ review })}
              />
            </SettingsCard>
          </SettingsSection>
        </SettingsPanel>
        <SettingsPanel active={section === "notifications"}>
          <SettingsSection key={`delivery:${formKey}`} title="通知内容与投递">
            <SettingsCard>
              <SettingsSwitch
                label="包含子代理"
                hint="关闭时只处理主会话，避免重复通知"
                value={draft.includeSubagents}
                onValueChange={(includeSubagents) =>
                  patch({ includeSubagents })
                }
              />
              <SettingsSwitch
                label="附带最终回复摘要"
                hint="开启后会把最终回复的截取内容发送给所选渠道"
                value={draft.notifications.includePreview}
                onValueChange={(includePreview) =>
                  patch({
                    notifications: { ...draft.notifications, includePreview },
                  })
                }
              />
              <SettingsInput
                label="摘要字符数"
                initialValue={String(draft.notifications.previewCharacters)}
                onChangeText={(v) =>
                  patch({
                    notifications: {
                      ...draft.notifications,
                      previewCharacters: numeric(v),
                    },
                  })
                }
              />
              <SettingsInput
                label="通知最多发送次数"
                initialValue={String(draft.notifications.maxAttempts)}
                onChangeText={(v) =>
                  patch({
                    notifications: {
                      ...draft.notifications,
                      maxAttempts: numeric(v),
                    },
                  })
                }
              />
              <SettingsInput
                label="运行记录保留天数"
                initialValue={String(draft.notifications.retentionDays)}
                onChangeText={(v) =>
                  patch({
                    notifications: {
                      ...draft.notifications,
                      retentionDays: numeric(v),
                    },
                  })
                }
              />
            </SettingsCard>
          </SettingsSection>
        </SettingsPanel>
      </View>
      <SettingsPanel active={section === "transfer"}>
        <ConfigTransfer
          settings={settings}
          theme={theme}
          disabled={dirty || credentialsDirty || credentialsBusy || busy}
          onBusyChange={setTransferBusy}
          onImported={() => {
            setDirty(false);
            void refresh();
          }}
        />
      </SettingsPanel>
      <SettingsPanel active={section === "activity"}>
        <Activity
          status={status}
          error={statusError}
          refresh={() => void refresh()}
        />
      </SettingsPanel>
      <SettingsPanel active={section === "updates"}>
        <UpdatesPanel
          automatic={draft.updates.checkAutomatically}
          savedAutomatic={settings.values.updates.checkAutomatically}
          onAutomaticChange={(checkAutomatically) =>
            patch({ updates: { checkAutomatically } })
          }
          revision={revision}
          disabled={
            dirty || credentialsDirty || credentialsBusy || busy || transferBusy
          }
          onBusyChange={setUpdateBusy}
          navigation={navigation}
          host={host}
        />
      </SettingsPanel>
    </View>
  );
}
