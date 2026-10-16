import { preferences } from "../shared/config";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
} from "@getpaseo/plugin/client/ui";
import {
  prepareSessionConfigCleanupRpc,
  deleteSessionRpc,
  prepareDeleteSessionsRpc,
  sessionStatus,
  type SessionInfo,
} from "../shared/sessions";

type Theme = PluginSurfaceProps["theme"];
export function DangerButton({
  label,
  disabled,
  onPress,
  theme,
}: {
  label: string;
  disabled?: boolean;
  onPress(): void;
  theme: Theme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={{
        margin: 12,
        minHeight: 44,
        padding: 12,
        borderWidth: 1,
        borderRadius: 8,
        borderColor: theme.colors.statusDanger,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        style={{
          color: theme.colors.statusDanger,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function SessionDelete({
  ids,
  archivedOnly = false,
  theme,
  disabled,
  onDone,
  onBusyChange,
}: {
  ids: string[];
  archivedOnly?: boolean;
  theme: Theme;
  disabled?: boolean;
  onDone?(deletedIds: string[]): void;
  onBusyChange?(busy: boolean): void;
}) {
  const settings = useSettings(preferences);
  const prepareCleanup = useRpc(prepareSessionConfigCleanupRpc);
  const [pendingCleanup, setPendingCleanup] = useState<string[]>([]);
  const prepare = useRpc(prepareDeleteSessionsRpc),
    remove = useRpc(deleteSessionRpc);
  const [plan, setPlan] = useState<{
    token: string;
    sessions: SessionInfo[];
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<string | null>(null);
  const lock = useRef(false),
    mounted = useRef(true);
  const selection = ids.join(",");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setPlan(null);
  }, [selection, archivedOnly]);
  const setWorking = (value: boolean) => {
    lock.current = value;
    if (mounted.current) setBusy(value);
    onBusyChange?.(value);
  };
  async function review() {
    if (lock.current || disabled || !ids.length || pendingCleanup.length)
      return;
    setWorking(true);
    setFeedback(null);
    try {
      const result = await prepare({ ids, archivedOnly });
      if (mounted.current) setPlan(result);
    } catch (error) {
      if (mounted.current)
        setFeedback(
          error instanceof Error
            ? error.message
            : "无法读取待删除会话，请刷新重试",
        );
    } finally {
      setWorking(false);
    }
  }
  async function cleanup(deleted: string[]): Promise<boolean> {
    if (!deleted.length) return true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const plan = await prepareCleanup({ ids: deleted });
        if (
          !plan.changed ||
          (await settings.save(plan.config, plan.revision))
        ) {
          if (mounted.current) setPendingCleanup([]);
          return true;
        }
      }
    } catch {
      /* Deletion succeeded; only configuration cleanup is pending. */
    }
    if (mounted.current) setPendingCleanup(deleted);
    return false;
  }
  async function retryCleanup() {
    if (lock.current || !pendingCleanup.length) return;
    setWorking(true);
    try {
      if (await cleanup(pendingCleanup)) {
        if (mounted.current) {
          setFeedback("会话配置已清理");
          onDone?.(pendingCleanup);
        }
      } else if (mounted.current)
        setFeedback(
          "会话已删除，配置仍待清理。请检查连接后重试清理；不会再次删除会话。",
        );
    } finally {
      setWorking(false);
    }
  }
  async function confirm() {
    if (lock.current || !plan || disabled) return;
    setWorking(true);
    const deleted: string[] = [],
      failures: string[] = [];
    try {
      for (const session of plan.sessions) {
        // Closing the page cancels the remainder, never the already sent request.
        if (!mounted.current) break;
        try {
          const result = await remove({ token: plan.token, id: session.id });
          if (result.ok) deleted.push(session.id);
          else failures.push(`${session.title}：${result.message}`);
        } catch {
          failures.push(`${session.title}：无法确认删除结果，请刷新列表检查`);
        }
      }
      const cleaned = await cleanup(deleted);
      if (mounted.current) {
        setPlan(null);
        setFeedback(
          `已删除 ${deleted.length} 个会话。${cleaned ? "" : "配置待清理，请点击重试清理；不会再次删除会话。"}${failures.length ? `\n${failures.join("\n")}` : ""}`,
        );
        if (cleaned) onDone?.(deleted);
      }
    } finally {
      setWorking(false);
    }
  }
  return (
    <SettingsCard>
      <SettingsRow
        label="删除会话"
        hint="永久移除 Paseo 会话记录与时间线，无法撤销。运行中的会话会被中断。不会删除项目文件；AI 提供方自身保存的历史不在此操作范围内。"
      />
      {plan ? (
        <View testID="session-delete-confirmation">
          <SettingsRow
            label={`请确认这 ${plan.sessions.length} 个会话`}
            hint="只删除下面列出的会话。确认有效期为 5 分钟。"
          />
          {plan.sessions.map((session) => (
            <SettingsRow
              key={session.id}
              label={session.title}
              hint={`${session.provider} · ${sessionStatus(session)}\n${session.cwd}\n${session.id}`}
            />
          ))}
          <DangerButton
            theme={theme}
            label={
              busy ? "正在删除…" : `确认删除 ${plan.sessions.length} 个会话`
            }
            disabled={busy || disabled}
            onPress={() => void confirm()}
          />
          <SettingsAction
            label="保留这些会话"
            actionLabel="取消删除"
            disabled={busy}
            onPress={() => setPlan(null)}
          />
        </View>
      ) : (
        <DangerButton
          theme={theme}
          label={
            busy
              ? "正在读取会话…"
              : ids.length > 1
                ? `删除选中的 ${ids.length} 个会话`
                : "删除会话"
          }
          disabled={
            busy || disabled || !ids.length || pendingCleanup.length > 0
          }
          onPress={() => void review()}
        />
      )}
      {pendingCleanup.length > 0 && (
        <SettingsAction
          label="已删除会话的配置待清理"
          actionLabel="重试清理"
          disabled={busy}
          onPress={() => void retryCleanup()}
        />
      )}
      {feedback && <SettingsRow label="删除结果" hint={feedback} />}
    </SettingsCard>
  );
}
