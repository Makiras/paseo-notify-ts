import { useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
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

export function ChannelEditor({
  channel,
  saved,
  configured,
  onChange,
  onRemove,
  onCredentialsChanged,
}: {
  channel: Channel;
  saved: boolean;
  configured: boolean;
  onChange: (value: Channel) => void;
  onRemove: () => void;
  onCredentialsChanged: () => void;
}) {
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [showSecrets, setShowSecrets] = useState(!configured);
  const patch = (value: Partial<Channel>) => onChange({ ...channel, ...value });
  return (
    <SettingsSection title={channel.name || names[channel.kind]}>
      <SettingsCard>
        <SettingsRow
          label={names[channel.kind]}
          hint={`渠道 ID：${channel.id}`}
        />
        <SettingsSwitch
          label="启用渠道"
          value={channel.enabled}
          onValueChange={(enabled) => patch({ enabled })}
        />
        <SettingsInput
          label="名称"
          initialValue={channel.name}
          onChangeText={(name) => patch({ name })}
        />
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
          hint="逗号分隔；留空接收全部提供方"
          initialValue={channel.providers.join(", ")}
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
          hint="逗号分隔；留空接收全部工作区"
          initialValue={channel.workspaceIds.join(", ")}
          onChangeText={(text) =>
            patch({
              workspaceIds: text
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
        <SettingsRow
          label="凭据"
          hint={
            configured
              ? "已配置，保存后不会回传密钥。修改时需重新填写完整凭据。"
              : "未配置。先保存渠道设置，再填写凭据。"
          }
        />
        <SettingsSwitch
          label={configured ? "更新凭据" : "填写凭据"}
          value={showSecrets}
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
                      ? "支持自建服务；不要在此填写 topic 路径"
                      : channel.kind === "telegram"
                        ? "可改为自建 Bot API 服务地址"
                        : undefined
                }
                secureTextEntry
                initialValue={defaultUrl}
                placeholder="https://…"
                onChangeText={setUrl}
              />
              {["webhook", "feishu", "dingtalk"].includes(channel.kind) && (
                <SettingsInput
                  label="签名密钥（可选）"
                  secureTextEntry
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
                    onChangeText={setToken}
                  />
                  {channel.kind === "webhook" && (
                    <SettingsInput
                      label="自定义请求头 JSON（可选）"
                      secureTextEntry
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
                      : "公共服务上的公开 topic 可被其他人订阅；私密通知请使用有访问控制的 topic"
                  }
                  secureTextEntry
                  onChangeText={setTarget}
                />
              )}
              {channel.kind === "telegram" && (
                <SettingsInput
                  label="话题 ID（可选）"
                  onChangeText={setThreadId}
                />
              )}
              <SettingsAction
                label="保存凭据"
                hint={
                  saved
                    ? "凭据单独保存到宿主，普通设置中仅保留渠道 ID"
                    : "请先点击页面上方的保存设置"
                }
                actionLabel={busy ? "处理中…" : "保存凭据"}
                disabled={busy || !saved || !url.trim()}
                onPress={async () => {
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
                    setUrl(defaultUrl);
                    setSecret("");
                    setToken("");
                    setHeaders("");
                    setTarget("");
                    setThreadId("");
                    setReset((n) => n + 1);
                    setShowSecrets(false);
                    setFeedback("凭据已保存");
                    onCredentialsChanged();
                  } catch (e) {
                    setFeedback(
                      e instanceof Error ? e.message : "凭据保存失败",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </SettingsCard>
          </SettingsRow>
        )}
        <SettingsAction
          label="测试通知"
          hint="立即发送一条测试消息到此渠道"
          actionLabel={busy ? "处理中…" : "发送测试"}
          disabled={busy || !saved || !configured}
          onPress={async () => {
            setBusy(true);
            try {
              const result = await test({ id: channel.id });
              setFeedback(result.message);
            } catch {
              setFeedback("测试请求失败，请检查宿主连接");
            } finally {
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
          disabled={busy}
          onPress={onRemove}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
export function newChannel(kind: Channel["kind"]): Channel {
  return channelSchema.parse({
    id: `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: names[kind],
    kind,
  });
}
