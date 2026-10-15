import { useRef, useState } from "react";
import {
  useRpc,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import { copyText, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { configSchema } from "../shared/config";
import {
  exportConfigRpc,
  parseTransfer,
  prepareImportRpc,
  transferLimit,
  type Transfer,
} from "../shared/transfer";

export function ConfigTransfer({
  settings,
  theme,
  disabled,
  onBusyChange,
  onImported,
}: {
  settings: Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
  theme: PluginSurfaceProps["theme"];
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onImported(): void;
}) {
  const exportConfig = useRpc(exportConfigRpc),
    prepareImport = useRpc(prepareImportRpc);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [preparedExport, setPreparedExport] = useState<{
    text: string;
    revision: string;
    includeCredentials: boolean;
  } | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{
    value: Transfer;
    revision: string;
  } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const blocked = disabled || busy;
  async function perform(action: () => Promise<void>) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setFeedback(null);
    try {
      await action();
    } catch {
      setFeedback(
        "操作未完成。请检查配置格式、渠道数量或连接，重新读取最新设置后再试。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <SettingsSection title="跨 Host 导入 / 导出">
      <SettingsCard>
        <SettingsRow
          label="同步渠道与 Host 默认设置"
          hint="保留目标 Host 已有渠道及 Workspace / Session 绑定；不传输本地绑定、工作区过滤和运行记录。同一配置复用，冲突渠道另建。"
        />
        {disabled && (
          <SettingsRow
            label="先保存或放弃当前草稿"
            hint="导入导出只使用已保存的配置"
          />
        )}
        <SettingsSwitch
          label="导出包含凭据"
          hint="包括 Webhook 地址、Token 和目标群组；复制内容为明文，仅粘贴到你信任的 Host"
          value={includeCredentials}
          disabled={blocked}
          onValueChange={(value) => {
            setIncludeCredentials(value);
            setPreparedExport(null);
          }}
        />
        <SettingsAction
          label="复制当前 Host 配置"
          actionLabel="复制配置"
          disabled={blocked}
          onPress={() =>
            void perform(async () => {
              let result = preparedExport;
              if (
                !result ||
                result.revision !== settings.revision ||
                result.includeCredentials !== includeCredentials
              ) {
                result = {
                  ...(await exportConfig({
                    revision: settings.revision,
                    includeCredentials,
                  })),
                  revision: settings.revision,
                  includeCredentials,
                };
                setPreparedExport(result);
              }
              try {
                await copyText(result.text);
              } catch {
                // A second click calls copyText before any RPC, preserving browser user activation.
                setFeedback(
                  "配置已生成，但未能写入剪贴板。请允许剪贴板访问后再次点击「复制配置」。",
                );
                return;
              }
              setPreparedExport(null);
              setFeedback(
                includeCredentials
                  ? "已复制配置及凭据"
                  : "已复制普通配置；目标 Host 仍需配置凭据",
              );
            })
          }
        />
        <SettingsRow
          label="粘贴配置"
          hint="在下方使用系统粘贴，再预览并应用；不会自动读取剪贴板"
        >
          <TextInput
            accessibilityLabel="待导入的配置 JSON"
            value={text}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
            editable={!blocked}
            maxLength={transferLimit + 1}
            style={{
              color: theme.colors.foreground,
              minHeight: 100,
              maxHeight: 220,
              padding: 10,
              borderWidth: 1,
              borderColor: theme.colors.foregroundMuted,
              textAlignVertical: "top",
            }}
            placeholder="粘贴 paseo-notify-ts 导出的 JSON"
            onChangeText={(value) => {
              setText(value);
              setPreview(null);
              setFeedback(null);
            }}
          />
        </SettingsRow>
        <SettingsAction
          label="检查粘贴内容"
          actionLabel="预览导入"
          disabled={blocked || !text.trim()}
          onPress={() => {
            try {
              setPreview({
                value: parseTransfer(text),
                revision: settings.revision,
              });
              setFeedback(null);
            } catch (error) {
              setPreview(null);
              setFeedback((error as Error).message);
            }
          }}
        />
        {preview && (
          <>
            <SettingsRow
              label={`导入 ${preview.value.config.channels.length} 个渠道`}
              hint={
                preview.value.config.channels.map((c) => c.name).join("、") ||
                "无渠道"
              }
            />
            <SettingsRow
              label="将替换 Host 默认选择及通用设置"
              hint={`默认渠道：${preview.value.config.routing.host.map((id) => preview.value.config.channels.find((c) => c.id === id)!.name).join("、") || "关闭通知"}；自动恢复：${preview.value.config.recovery.enabled ? "开启" : "关闭"}；包含 ${Object.keys(preview.value.credentials ?? {}).length} 份凭据`}
            />
            <SettingsRow
              label="通知内容与复核"
              hint={`回复摘要：${preview.value.config.notifications.includePreview ? "包含" : "不包含"}；AI 复核：${preview.value.config.recovery.review.enabled ? "开启（随自动恢复执行）" : "关闭"}；插件总开关：${preview.value.config.enabled ? "开启" : "关闭"}`}
            />
            {preview.revision !== settings.revision && (
              <SettingsRow label="配置已变化，请重新预览" />
            )}
            <SettingsAction
              label="合并渠道并应用上面的设置"
              actionLabel="应用导入"
              disabled={blocked || preview.revision !== settings.revision}
              onPress={() =>
                void perform(async () => {
                  const result = await prepareImport({
                    text,
                    revision: preview.revision,
                  });
                  const saved = await settings.save(
                    result.config,
                    result.revision,
                  );
                  if (!saved) {
                    setFeedback("配置保存冲突，导入未生效；请刷新后重新预览");
                    setPreview(null);
                    return;
                  }
                  setText("");
                  setPreview(null);
                  setIncludeCredentials(false);
                  setPreparedExport(null);
                  onImported();
                  await settings.reload();
                  setFeedback(
                    `已导入：新增 ${result.added} 个，复用 ${result.reused} 个；${result.missingCredentials} 个尚需配置凭据`,
                  );
                })
              }
            />
          </>
        )}
        {text && (
          <SettingsAction
            label="清空粘贴内容"
            actionLabel="清空"
            disabled={busy}
            onPress={() => {
              setText("");
              setPreview(null);
              setFeedback(null);
            }}
          />
        )}
        {feedback && <SettingsRow label="导入导出结果" hint={feedback} />}
      </SettingsCard>
    </SettingsSection>
  );
}
