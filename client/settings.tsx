import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
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

export function Settings(props: PluginSurfaceProps) {
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
}: PluginSurfaceProps & {
  settings: Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
}) {
  const [draft, setDraft] = useState<Config>(settings.values);
  const [revision, setRevision] = useState(settings.revision);
  const [dirty, setDirty] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
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
  const busy = savingAll || settings.saving;
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
    try {
      setStatus(await readStatus({}));
      setStatusError(null);
    } catch {
      setStatusError("无法读取运行状态");
    }
  }, [readStatus]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      try {
        const next = await readStatus({});
        if (active) {
          setStatus(next);
          setStatusError(null);
        }
      } catch {
        if (active) setStatusError("无法读取运行状态");
      } finally {
        if (active) timer = setTimeout(() => void update(), 5000);
      }
    };
    void update();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [readStatus]);
  useEffect(() => {
    if (!dirty && settings.revision !== revision) {
      setDraft(settings.values);
      setRevision(settings.revision);
      setFormKey((n) => n + 1);
    }
  }, [dirty, settings.revision, settings.values, revision]);
  const patch = (value: Partial<Config>) => {
    if (saving.current || transferBusy) return;
    setDraft((d) => ({ ...d, ...value }));
    setDirty(true);
    setFeedback(null);
  };
  const recovery = (value: Partial<Config["recovery"]>) =>
    patch({ recovery: { ...draft.recovery, ...value } });
  const numeric = (value: string) =>
    /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  const valid = configSchema.safeParse(draft);
  async function save() {
    const result = configSchema.safeParse(draft);
    if (!result.success || saving.current || settings.saving || transferBusy)
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
      await refresh();
    } catch {
      setFeedback("保存设置失败，已保留输入，请检查连接后重试");
    } finally {
      saving.current = false;
      if (mounted.current) setSavingAll(false);
    }
  }
  return (
    <View style={{ gap: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        任务结束后接收通知；发生临时故障时，可按预算自动继续原任务。
      </Text>
      <SettingsSection title="设置">
        <SettingsCard>
          <SettingsSwitch
            label="启用通知与恢复"
            value={draft.enabled}
            onValueChange={(enabled) => patch({ enabled })}
          />
          <SettingsSwitch
            label="包含子代理"
            hint="关闭时只处理主会话，避免重复通知"
            value={draft.includeSubagents}
            onValueChange={(includeSubagents) => patch({ includeSubagents })}
          />
          <SettingsAction
            label={dirty || credentialsDirty ? "有未保存的修改" : "配置已同步"}
            hint="先保存渠道与通用设置，再保存已填写的凭据"
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
              disabled={busy || credentialsBusy}
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
            <SettingsRow
              label="请检查设置"
              error={valid.error.issues
                .map((i) => `${i.path.join(".")}：${i.message}`)
                .join("；")}
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
        style={{ gap: 16 }}
        pointerEvents={transferBusy || busy ? "none" : "auto"}
      >
        {/* Refresh ordinary inputs without unmounting credential drafts. */}
        <SettingsSection key={`defaults:${formKey}`} title="Host 默认通知渠道">
          <ChannelSelection
            channels={draft.channels}
            value={draft.routing.host}
            disabled={busy || transferBusy}
            onChange={(ids) =>
              patch({ routing: { ...draft.routing, host: ids ?? [] } })
            }
          />
        </SettingsSection>
        <ScheduleSelection
          config={draft}
          disabled={busy || transferBusy}
          onChange={(schedules) =>
            patch({ routing: { ...draft.routing, schedules } })
          }
        />
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
              onChangeText={(v) => recovery({ maxElapsedMinutes: numeric(v) })}
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
        <SettingsSection key={`delivery:${formKey}`} title="通知内容与投递">
          <SettingsCard>
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
        {draft.channels.map((channel) => (
          <ChannelEditor
            key={`${channel.id}:${channel.kind}`}
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
            configured={
              status?.credentials.some(
                (c) => c.id === channel.id && c.kind === channel.kind,
              ) ?? false
            }
            onChange={(next) =>
              patch({
                channels: draft.channels.map((c) =>
                  c.id === next.id ? next : c,
                ),
              })
            }
            onRemove={() => patch(withoutChannel(draft, channel.id))}
            onCredentialsChanged={() => void refresh()}
          />
        ))}
        <SettingsSection title="添加通知渠道">
          <SettingsCard>
            {channelKindSchema.options.map((kind) => (
              <SettingsAction
                key={kind}
                label={channelNames[kind]}
                actionLabel="添加"
                disabled={draft.channels.length >= 20}
                onPress={() =>
                  patch({ channels: [...draft.channels, newChannel(kind)] })
                }
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      </View>
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
      <Activity
        status={status}
        error={statusError}
        refresh={() => void refresh()}
      />
    </View>
  );
}
