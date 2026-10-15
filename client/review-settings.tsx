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
            ? "每次继续任务前，另开一个 AI 判断是否适合继续。会产生额外模型用量；复核不建议继续或判断超时，就暂停并通知你。"
            : "先开启“自动继续”，再选择是否让 AI 复核。"
        }
      />
      {value.enabled && (
        <>
          <SettingsInput
            label="复核提供方 / 模型"
            initialValue={value.provider}
            onChangeText={(provider) => patch({ provider })}
            hint="留空使用原会话的 AI。也可填写 codex、claude、opencode，或使用“提供方/模型名”指定模型。"
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
