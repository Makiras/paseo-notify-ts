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
import { MessageTemplates } from "./message-templates";
import { SessionCleanup } from "./sessions";
import { SelectedEditor } from "./selected-editor";
import { settingsIssue } from "./validation";
import {
  settingsSections,
  createSettingsNavigation,
  SectionNavigation,
  SettingsPanel,
  type SettingsNavigation,
  type SettingsSectionId,
} from "./settings-sections";

type SettingsProps = PluginSurfaceProps & {
  sectionNavigation?: SettingsNavigation;
  visibleSections?: readonly SettingsSectionId[];
};

export function createSettingsScreen(
  initial: SettingsSectionId = "channels",
  visibleSections?: readonly SettingsSectionId[],
) {
  const sectionNavigation = createSettingsNavigation(initial);
  return {
    select: sectionNavigation.select,
    Component: function SettingsScreen(props: PluginSurfaceProps) {
      return (
        <Settings
          {...props}
          sectionNavigation={sectionNavigation}
          visibleSections={visibleSections}
        />
      );
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
  visibleSections,
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
  const editingChannel = draft.channels.find((c) => c.id === activeChannel);
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
    value.trim() ? Number(value) : Number.NaN;
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
        sections={
          visibleSections
            ? settingsSections.filter((s) => visibleSections.includes(s.value))
            : settingsSections
        }
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
            hint="一次保存所有栏目的修改，包括渠道地址和密钥。切换栏目不会丢失已填写的内容。"
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
              hint="其他设备或页面已保存了新设置。请先记下这次的修改，再点击“放弃修改”载入新设置并重新填写。"
            />
          )}
          {!valid.success && (
            <SettingsAction
              label="请检查设置"
              error={valid.error.issues.map(settingsIssue).join("；")}
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
          <SettingsSection title="添加渠道">
            <SettingsCard>
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
                label="添加接收通知的群组或设备"
                hint={
                  draft.channels.length >= 20
                    ? "最多添加 20 个渠道"
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
          {editingChannel ? (
            <SelectedEditor
              theme={theme}
              testID="notification-channel-editor"
              title={`正在编辑：${editingChannel.name || channelNames[editingChannel.kind]}`}
              hint="下方边框内的设置、连接信息、测试和移除操作只对应上方选中的渠道。切换不会清空未保存的内容。"
              selector={
                <SettingsSelect
                  label="编辑渠道"
                  value={activeChannel ?? ""}
                  options={draft.channels.map((c, index) => ({
                    value: c.id,
                    label: `${index + 1}. ${c.name || channelNames[c.kind]}${credentialStates[c.id]?.dirty ? "（凭据待保存）" : ""}`,
                  }))}
                  onValueChange={setSelectedChannel}
                />
              }
            >
              {draft.channels.map((channel) => (
                <SettingsPanel
                  key={`${channel.id}:${channel.kind}`}
                  active={activeChannel === channel.id}
                >
                  <ChannelEditor
                    ref={(editor) => {
                      if (editor)
                        credentialEditors.current.set(channel.id, editor);
                      else credentialEditors.current.delete(channel.id);
                    }}
                    settingsKey={formKey}
                    disabled={busy || transferBusy}
                    onCredentialState={onCredentialState}
                    channel={channel}
                    format={draft.notifications}
                    theme={theme}
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
            </SelectedEditor>
          ) : (
            <SettingsCard>
              <SettingsRow
                label="还没有通知渠道"
                hint="在上方选择平台并添加渠道，添加后会在这里打开编辑区。"
              />
            </SettingsCard>
          )}
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
                hint="遇到临时断网、请求过多或服务繁忙时，稍后继续原任务。安全拦截、额度用完或对话过长时，会通知你手动处理。"
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
                label="两次重试最多间隔（秒）"
                hint="连续失败时逐渐延长等待。如果服务要求等得更久，会按要求等待；超过上面的恢复时间上限后停止。"
                initialValue={String(draft.recovery.maxDelaySeconds)}
                onChangeText={(v) => recovery({ maxDelaySeconds: numeric(v) })}
              />
              <SettingsInput
                label="继续指令"
                hint="恢复任务时发给 AI 的消息。通常保留默认内容即可。"
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
          <MessageTemplates
            value={draft.notifications.template}
            notifications={draft.notifications}
            theme={theme}
            disabled={busy || transferBusy}
            onChange={(template) =>
              patch({ notifications: { ...draft.notifications, template } })
            }
            onPreviewChange={(includePreview) =>
              patch({
                notifications: { ...draft.notifications, includePreview },
              })
            }
          />
          <SettingsSection key={`delivery:${formKey}`} title="通知内容与投递">
            <SettingsCard>
              <SettingsSwitch
                label="包含子代理"
                hint="开启后，AI 创建的子任务也使用这里的通知和恢复设置。关闭时只处理原任务。"
                value={draft.includeSubagents}
                onValueChange={(includeSubagents) =>
                  patch({ includeSubagents })
                }
              />
              <SettingsInput
                label="摘要字符数"
                hint="最多附带多少个回复字符，可填写 80–2000。只截取已有回复，不会另外调用 AI 总结。"
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
                hint="包括第一次发送；发送失败后会再试，最多 12 次。不会重新运行 AI 任务。"
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
                hint="通知和恢复记录保留多久，可填写 1–30 天。"
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
      {section === "sessions" && (
        <SessionCleanup
          theme={theme}
          host={host}
          layout={layout}
          navigation={navigation}
        />
      )}
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
