import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import {
  cancelRecoveryRpc,
  type RecoveryCard as Card,
} from "../shared/contracts";

export const phaseLabels: Record<Card["phase"], string> = {
  waiting: "等待重试",
  reviewing: "AI 复核中",
  dispatching: "正在提交",
  running: "恢复执行中",
  paused: "需要检查",
  exhausted: "已停止恢复",
  done: "已完成",
  canceled: "已取消",
};
export function RecoveryCard({ item, theme }: PluginTimelineItemProps<Card>) {
  const cancel = useRpc(cancelRecoveryRpc);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const data = item.data;
  return (
    <View
      style={{
        padding: 14,
        gap: 8,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        自动恢复 · {phaseLabels[data.phase]}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{data.reason}</Text>
      {data.reviews?.length > 0 && (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          AI 复核 {data.reviews.length} 次 · {data.reviews.at(-1)?.reason}
          {data.reviews.some((r) => r.cleanupPending && r.status !== "pending")
            ? " · 审查会话归档未确认"
            : ""}
        </Text>
      )}
      <Text style={{ color: theme.colors.foregroundMuted }}>
        已尝试 {data.attempts} 次
        {data.dueAt
          ? ` · 下次 ${new Date(data.dueAt).toLocaleTimeString()}`
          : ""}
      </Text>
      {["waiting", "reviewing", "dispatching", "running"].includes(
        data.phase,
      ) && (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              const result = await cancel({ id: data.id });
              setFeedback(result.ok ? "已取消后续自动恢复" : "此计划已结束");
            } catch {
              setFeedback("取消失败，请重试");
            } finally {
              setBusy(false);
            }
          }}
          style={{ paddingVertical: 8 }}
        >
          <Text style={{ color: theme.colors.accent }}>
            {busy ? "正在取消…" : "取消后续重试"}
          </Text>
        </Pressable>
      )}
      {feedback ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>{feedback}</Text>
      ) : null}
    </View>
  );
}
