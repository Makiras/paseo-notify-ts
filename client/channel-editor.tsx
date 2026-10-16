import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
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
  channelSchema,
  channelNames as names,
  noticeLabels,
  type Channel,
  type NoticeKind,
} from "../shared/config";
import { saveCredentialsRpc, testChannelRpc } from "../shared/contracts";
import type { MessageFormat } from "../shared/templates";
import { FeishuPreview } from "./feishu-preview";

export interface CredentialEditorHandle {
  dirty: boolean;
  busy: boolean;
  saveCredentials(): Promise<boolean>;
  discardCredentials(): void;
}
type ChannelEditorProps = {
  channel: Channel;
  format: MessageFormat;
  theme: PluginSurfaceProps["theme"];
  saved: boolean;
  configured: boolean;
  settingsKey: number;
  disabled: boolean;
  onCredentialState: (id: string, dirty: boolean, busy: boolean) => void;
  onChange: (value: Channel) => void;
  onRemove: () => void;
  onCredentialsSaved: () => void;
  onCredentialsChanged: () => void;
};

export const ChannelEditor = forwardRef<
  CredentialEditorHandle,
  ChannelEditorProps
>(function ChannelEditor(
  {
    channel,
    format,
    theme,
    saved,
    configured,
    settingsKey,
    disabled,
    onCredentialState,
    onChange,
    onRemove,
    onCredentialsSaved,
    onCredentialsChanged,
  },
  ref,
) {
  const write = useRpc(saveCredentialsRpc),
    test = useRpc(testChannelRpc);
  const defaultUrl =
    channel.kind === "telegram"
      ? "https://api.telegram.org"
      : channel.kind === "ntfy"
        ? "https://ntfy.sh"
        : "";
  const [url, setUrl] = useState(defaultUrl);
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("");
  const [target, setTarget] = useState("");
  const [threadId, setThreadId] = useState("");
  const [busy, setBusy] = useState(false);
  const requestInFlight = useRef(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [showSecrets, setShowSecrets] = useState(!configured);
  const dirty = Boolean(
    url !== defaultUrl || secret || token || headers || target || threadId,
  );
  const locked = disabled || busy;
  function clearDraft() {
    setUrl(defaultUrl);
    setSecret("");
    setToken("");
    setHeaders("");
    setTarget("");
    setThreadId("");
    setReset((n) => n + 1);
  }
  useEffect(() => {
    onCredentialState(channel.id, dirty, busy);
  }, [channel.id, dirty, busy, onCredentialState]);
  async function saveCredentials(): Promise<boolean> {
    if (requestInFlight.current) return false;
    requestInFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      let parsed: unknown = {};
      try {
        parsed = headers.trim() ? JSON.parse(headers) : {};
      } catch {
        throw new Error("请求头必须是有效的 JSON 对象");
      }
      if (
        typeof parsed !== "object" ||
        !parsed ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((v) => typeof v !== "string")
      )
        throw new Error("请求头应为字符串键值对象");
      await write({
        id: channel.id,
        kind: channel.kind,
        credentials: {
          url: url.trim(),
          signingSecret: secret,
          bearerToken: token,
          headers: parsed as Record<string, string>,
          target: target.trim(),
          threadId: threadId.trim(),
        },
      });
      clearDraft();
      setShowSecrets(false);
      setFeedback("凭据已保存");
      onCredentialsSaved();
      return true;
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "凭据保存失败");
      return false;
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    dirty,
    busy,
    saveCredentials,
    discardCredentials() {
      clearDraft();
      setFeedback(null);
      setShowSecrets(!configured);
    },
  }));
  const patch = (value: Partial<Channel>) => onChange({ ...channel, ...value });
  return (
    <SettingsSection title="渠道设置">
      <SettingsCard key={settingsKey}>
        <SettingsRow
          label={names[channel.kind]}
          hint="一个渠道对应一个接收群组、账号或设备。添加后，还需在默认通知去向或会话中选中它。"
        />
        <SettingsSwitch
          label="启用渠道"
          value={channel.enabled}
          disabled={locked}
          onValueChange={(enabled) => patch({ enabled })}
        />
        <SettingsInput
          label="名称"
          hint="起一个容易辨认的名字，例如“开发群”或“我的手机”。"
          initialValue={channel.name}
          disabled={locked}
          onChangeText={(name) => patch({ name })}
        />
        {channel.kind === "feishu" && (
          <>
            <SettingsSelect
              label="消息类型"
              hint="只影响这个渠道。标题和正文在“通知管理”中修改；切换类型无需重新填写凭据。保存设置后，可发送测试。"
              value={channel.feishu?.messageType ?? "text"}
              options={[
                { value: "text", label: "文本消息" },
                { value: "card", label: "卡片消息" },
              ]}
              disabled={locked}
              onValueChange={(value) => {
                if (!locked)
                  patch({ feishu: { messageType: value as "text" | "card" } });
              }}
            />
            {channel.feishu?.messageType === "card" ? (
              <FeishuPreview format={format} theme={theme} />
            ) : (
              <SettingsRow
                label="普通文本"
                hint="把标题和正文作为一条普通消息发送到群里。"
              />
            )}
          </>
        )}
        {(
          [
            "completed",
            "recovered",
            "failed",
            "blocked",
            "permission",
          ] as NoticeKind[]
        ).map((kind) => (
          <SettingsSwitch
            key={kind}
            label={noticeLabels[kind]}
            value={channel.events.includes(kind)}
            disabled={locked}
            onValueChange={(enabled) =>
              patch({
                events: enabled
                  ? [...channel.events, kind]
                  : channel.events.filter((k) => k !== kind),
              })
            }
          />
        ))}
        <SettingsInput
          label="限定提供方"
          hint="留空接收所有 AI 的通知。只接收特定 AI 时，填写 codex、claude 或 opencode，多个用逗号分隔。"
          initialValue={channel.providers.join(", ")}
          disabled={locked}
          onChangeText={(text) =>
            patch({
              providers: text
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
        <SettingsInput
          label="限定工作区 ID"
          hint="通常留空。在工作区设置中选择通知渠道即可；这里填写 ID 会进一步限制此渠道接收哪些工作区的通知。"
          initialValue={channel.workspaceIds.join(", ")}
          disabled={locked}
          onChangeText={(text) =>
            patch({
              workspaceIds: text
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsRow
          label="凭据"
          hint={
            configured
              ? "连接信息已保存。为保护密钥，这里不会显示原值；需要更换时，请重新填写完整连接信息。"
              : "填写平台提供的地址和密钥，然后点击顶部“保存设置”，即可保存这个渠道。"
          }
        />
        <SettingsSwitch
          label={configured ? "更新凭据" : "填写凭据"}
          value={showSecrets}
          disabled={locked}
          onValueChange={setShowSecrets}
        />
        {showSecrets && (
          <SettingsRow label="连接信息">
            <SettingsCard key={reset}>
              <SettingsInput
                label={
                  ["telegram", "ntfy"].includes(channel.kind)
                    ? "服务根地址"
                    : channel.kind === "bark"
                      ? "Bark 推送地址（含设备 Key）"
                      : "Webhook 地址"
                }
                hint={
                  channel.kind === "bark"
                    ? "例如 https://api.day.app/设备Key，支持自建服务"
                    : channel.kind === "ntfy"
                      ? "例如 https://ntfy.sh。订阅名称填在下方 Topic 中，不要拼在地址后面。"
                      : channel.kind === "telegram"
                        ? "可改为自建 Bot API 服务地址"
                        : "粘贴接收消息的 Webhook 完整地址。群机器人地址可从机器人设置中复制。"
                }
                secureTextEntry={!["telegram", "ntfy"].includes(channel.kind)}
                initialValue={url}
                disabled={locked}
                placeholder="https://…"
                onChangeText={setUrl}
              />
              {["webhook", "feishu", "dingtalk"].includes(channel.kind) && (
                <SettingsInput
                  label="签名密钥（可选）"
                  hint={
                    channel.kind === "webhook"
                      ? "接收方要求签名校验时，填写双方约定的密钥；否则留空。"
                      : "如果机器人开启了签名校验，请填写对应密钥；未开启则留空。"
                  }
                  secureTextEntry
                  initialValue={secret}
                  disabled={locked}
                  onChangeText={setSecret}
                />
              )}
              {["webhook", "ntfy", "telegram"].includes(channel.kind) && (
                <>
                  <SettingsInput
                    label={
                      channel.kind === "telegram"
                        ? "Bot Token"
                        : "Bearer Token（可选）"
                    }
                    secureTextEntry
                    initialValue={token}
                    disabled={locked}
                    onChangeText={setToken}
                  />
                  {channel.kind === "webhook" && (
                    <SettingsInput
                      label="自定义请求头 JSON（可选）"
                      secureTextEntry
                      initialValue={headers}
                      disabled={locked}
                      placeholder='{"X-Api-Key":"…"}'
                      onChangeText={setHeaders}
                    />
                  )}
                </>
              )}
              {["telegram", "ntfy"].includes(channel.kind) && (
                <SettingsInput
                  label={channel.kind === "telegram" ? "Chat ID" : "Topic"}
                  hint={
                    channel.kind === "telegram"
                      ? "数字 ID 或 @频道名；私聊需先向 Bot 发起会话"
                      : "填写 ntfy 中订阅的名称。公开订阅名称可被其他人使用；私密消息请先在 ntfy 中设置访问权限。"
                  }
                  secureTextEntry
                  initialValue={target}
                  disabled={locked}
                  onChangeText={setTarget}
                />
              )}
              {channel.kind === "telegram" && (
                <SettingsInput
                  label="话题 ID（可选）"
                  initialValue={threadId}
                  disabled={locked}
                  onChangeText={setThreadId}
                />
              )}
              <SettingsAction
                label="保存凭据"
                hint={
                  saved
                    ? "仅保存这里填写的连接信息。也可以用顶部“保存设置”一起保存所有修改。"
                    : "新渠道请使用顶部“保存设置”，连接信息会一起保存。"
                }
                actionLabel={busy ? "处理中…" : "保存凭据"}
                disabled={locked || !saved || !url.trim()}
                onPress={async () => {
                  if (locked || !saved || !url.trim()) return;
                  return saveCredentials();
                }}
              />
            </SettingsCard>
          </SettingsRow>
        )}
        <SettingsAction
          label="测试通知"
          hint={
            !saved
              ? "先点击页面上方的保存设置，保存此渠道和填写的凭据"
              : !configured
                ? "请先填写并保存此渠道的连接信息"
                : "向此渠道发送一条测试消息。使用上次保存的设置；修改后请先保存。"
          }
          actionLabel={busy ? "处理中…" : "发送测试"}
          disabled={locked || !saved || !configured}
          onPress={async () => {
            if (requestInFlight.current || locked || !saved || !configured)
              return;
            requestInFlight.current = true;
            setBusy(true);
            try {
              const result = await test({ id: channel.id });
              setFeedback(result.message);
            } catch {
              setFeedback("测试请求失败，请检查宿主连接");
            } finally {
              requestInFlight.current = false;
              setBusy(false);
              onCredentialsChanged();
            }
          }}
        />
        {feedback && <SettingsRow label="操作结果" hint={feedback} />}
        <SettingsAction
          label="移除此渠道"
          hint="保存设置后生效"
          actionLabel="移除"
          disabled={locked}
          onPress={onRemove}
        />
      </SettingsCard>
    </SettingsSection>
  );
});
export function newChannel(kind: Channel["kind"]): Channel {
  return channelSchema.parse({
    id: `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: names[kind],
    kind,
  });
}
