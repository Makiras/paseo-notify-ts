import { useState } from "react";
import {
  SettingsAction,
  SettingsInput,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { RecoveryConfig } from "../shared/config";
import { ReviewSettings } from "./review-settings";
export function RecoverySettings({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  compact?: boolean;
  disabled?: boolean;
  value: RecoveryConfig;
  onChange(value: RecoveryConfig): void;
}) {
  const [details, setDetails] = useState(!compact);
  const patch = (update: Partial<RecoveryConfig>) =>
    onChange({ ...value, ...update });
  const numeric = (text: string) => (text.trim() ? Number(text) : NaN);
  return (
    <>
      <SettingsSwitch
        disabled={disabled}
        label="自动继续"
        hint="遇到临时断网、请求过多或服务繁忙时，稍后继续原任务。安全拦截、额度用完或对话过长时，会通知你手动处理。"
        value={value.enabled}
        onValueChange={(enabled) => patch({ enabled })}
      />
      {compact && (
        <SettingsAction
          label="重试参数与 AI 复核"
          actionLabel={details ? "收起" : "展开"}
          onPress={() => setDetails(!details)}
        />
      )}
      {details && (
        <>
          <SettingsSwitch
            disabled={disabled}
            label="网络故障"
            value={value.network}
            onValueChange={(network) => patch({ network })}
          />
          <SettingsSwitch
            disabled={disabled}
            label="服务繁忙 / 容量不足"
            value={value.overloaded}
            onValueChange={(overloaded) => patch({ overloaded })}
          />
          <SettingsSwitch
            disabled={disabled}
            label="请求限流"
            value={value.rateLimited}
            onValueChange={(rateLimited) => patch({ rateLimited })}
          />
          <SettingsInput
            disabled={disabled}
            label="最大重试次数"
            initialValue={String(value.maxAttempts)}
            onChangeText={(v) => patch({ maxAttempts: numeric(v) })}
          />
          <SettingsInput
            disabled={disabled}
            label="恢复时间上限（分钟）"
            initialValue={String(value.maxElapsedMinutes)}
            onChangeText={(v) => patch({ maxElapsedMinutes: numeric(v) })}
          />
          <SettingsInput
            disabled={disabled}
            label="初始等待（秒）"
            initialValue={String(value.baseDelaySeconds)}
            onChangeText={(v) => patch({ baseDelaySeconds: numeric(v) })}
          />
          <SettingsInput
            disabled={disabled}
            label="两次重试最多间隔（秒）"
            hint="连续失败时逐渐延长等待。如果服务要求等得更久，会按要求等待；超过上面的恢复时间上限后停止。"
            initialValue={String(value.maxDelaySeconds)}
            onChangeText={(v) => patch({ maxDelaySeconds: numeric(v) })}
          />
          <SettingsInput
            disabled={disabled}
            label="继续指令"
            hint="恢复任务时发给 AI 的消息。通常保留默认内容即可。"
            initialValue={value.prompt}
            onChangeText={(prompt) => patch({ prompt })}
          />
          <ReviewSettings
            disabled={disabled}
            recoveryEnabled={value.enabled}
            value={value.review}
            onChange={(review) => patch({ review })}
          />
        </>
      )}
    </>
  );
}
