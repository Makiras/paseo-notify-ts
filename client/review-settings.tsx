import { SettingsInput, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { ReviewConfig } from "../shared/config";

export function ReviewSettings({
  recoveryEnabled,
  value,
  onChange,
}: {
  recoveryEnabled: boolean;
  value: ReviewConfig;
  onChange(value: ReviewConfig): void;
}) {
  const patch = (update: Partial<ReviewConfig>) =>
    onChange({ ...value, ...update });
  const number = (text: string) => (text.trim() ? Number(text) : NaN);
  return (
    <>
      <SettingsSwitch
        label="重试前由 AI 复核"
        value={value.enabled}
        disabled={!recoveryEnabled}
        onValueChange={(enabled) => {
          if (recoveryEnabled) patch({ enabled });
        }}
        hint={
          recoveryEnabled
            ? "自动恢复的可选步骤。每次重试前将会话摘录交给独立 AI 判断，产生模型费用；复核不通过或超时则暂停。"
            : "开启自动继续后可启用复核；已有复核设置会保留。"
        }
      />
      {value.enabled && (
        <>
          <SettingsInput
            label="复核提供方 / 模型"
            initialValue={value.provider}
            onChangeText={(provider) => patch({ provider })}
            hint="留空沿用原会话。支持 codex、claude、opencode，也可填写 提供方/模型。"
          />
          <SettingsInput
            label="单次复核超时（秒）"
            initialValue={String(value.timeoutSeconds)}
            onChangeText={(v) => patch({ timeoutSeconds: number(v) })}
          />
          <SettingsInput
            label="每个恢复计划最多复核次数"
            initialValue={String(value.maxReviews)}
            onChangeText={(v) => patch({ maxReviews: number(v) })}
          />
          <SettingsInput
            label="会话摘录字符上限"
            initialValue={String(value.contextCharacters)}
            onChangeText={(v) => patch({ contextCharacters: number(v) })}
          />
        </>
      )}
    </>
  );
}
