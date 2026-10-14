import { useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import {
  cancelRecoveryRpc,
  retryDeliveryRpc,
  type RuntimeStatus,
} from "../shared/contracts";
import { noticeLabels } from "../shared/config";
import { phaseLabels } from "./recovery-card";

const deliveryLabels = {
  pending: "等待发送",
  sent: "已发送",
  failed: "发送失败",
  canceled: "已取消",
};
export function Activity({
  status,
  refresh,
  error,
}: {
  status: RuntimeStatus | null;
  refresh: () => void;
  error: string | null;
}) {
  const cancel = useRpc(cancelRecoveryRpc),
    retry = useRpc(retryDeliveryRpc);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<{ ok: boolean }>) {
    setBusy(true);
    try {
      const result = await fn();
      setFeedback(result.ok ? "操作已完成" : "状态已变化，请刷新查看");
    } catch {
      setFeedback("操作失败，请检查连接后重试");
    } finally {
      setBusy(false);
      refresh();
    }
  }
  return (
    <SettingsSection title="运行状态">
      <SettingsCard>
        <SettingsAction label="刷新状态" actionLabel="刷新" onPress={refresh} />
        {error && <SettingsRow label="连接异常" error={error} />}
        {status?.settingsError && (
          <SettingsRow label="配置异常" error={status.settingsError} />
        )}
        {status?.storageError && (
          <SettingsRow label="运行记录异常" error={status.storageError} />
        )}
        {status && !status.connected && (
          <SettingsRow
            label="等待宿主连接"
            hint="取得宿主连接后会核对待恢复任务"
          />
        )}
        {feedback && <SettingsRow label="操作结果" hint={feedback} />}
        {status && !status.recoveries.length && !status.deliveries.length && (
          <SettingsRow
            label="暂无运行记录"
            hint="任务完成或发生中断后，记录会显示在这里"
          />
        )}
        {status?.recoveries.slice(0, 20).map((r) => (
          <SettingsRow
            key={r.id}
            label={`${r.title} · ${phaseLabels[r.phase]}`}
            hint={`${r.reason} · 已重试 ${r.attempts} 次${r.dueAt ? ` · ${new Date(r.dueAt).toLocaleString()}` : ""}${r.reviews.length ? ` · AI 复核 ${r.reviews.length} 次：${r.reviews.at(-1)?.reason}` : ""}`}
          >
            {["waiting", "reviewing", "dispatching", "running"].includes(
              r.phase,
            ) && (
              <SettingsAction
                label="停止后续自动恢复"
                actionLabel="取消重试"
                disabled={busy}
                onPress={() => void act(() => cancel({ id: r.id }))}
              />
            )}
          </SettingsRow>
        ))}
        {status?.deliveries.slice(0, 20).map((d) => (
          <SettingsRow
            key={d.id}
            label={`${noticeLabels[d.kind]} · ${deliveryLabels[d.phase]}`}
            hint={`${d.title} · ${d.channelId} · ${d.attempts} 次${d.error ? ` · ${d.error}` : ""}`}
          >
            {d.phase === "failed" && (
              <SettingsAction
                label="再次投递这条通知"
                actionLabel="重试发送"
                disabled={busy}
                onPress={() => void act(() => retry({ id: d.id }))}
              />
            )}
          </SettingsRow>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
