import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { Channel } from "../shared/config";

export function ChannelSelection({
  channels,
  value,
  onChange,
  inheritable = false,
  disabled = false,
}: {
  channels: Channel[];
  value: string[] | undefined;
  onChange(value: string[] | undefined): void;
  inheritable?: boolean;
  disabled?: boolean;
}) {
  return (
    <SettingsCard>
      {inheritable && (
        <SettingsSwitch
          label="跟随上级"
          hint="未单独选择时，自动跟随上级之后的修改"
          value={value === undefined}
          disabled={disabled}
          onValueChange={(inherit) => onChange(inherit ? undefined : [])}
        />
      )}
      {value !== undefined && (
        <>
          {!value.length && (
            <SettingsRow
              label={inheritable ? "本层已关闭通知" : "Host 尚未选择默认渠道"}
              hint={
                inheritable
                  ? "不会回退到上级渠道；下级仍可单独选择"
                  : "在下方选择默认渠道，可多选"
              }
            />
          )}
          {channels.map((channel) => (
            <SettingsSwitch
              key={channel.id}
              label={channel.name}
              hint={channel.enabled ? undefined : "渠道已停用，选中也不会发送"}
              value={value.includes(channel.id)}
              disabled={disabled}
              onValueChange={(selected) =>
                onChange(
                  selected
                    ? [...value, channel.id]
                    : value.filter((id) => id !== channel.id),
                )
              }
            />
          ))}
          {value.length > 0 && (
            <SettingsAction
              label="清空本层选择"
              actionLabel="关闭通知"
              disabled={disabled}
              onPress={() => onChange([])}
            />
          )}
        </>
      )}
      {!channels.length && (
        <SettingsRow
          label="尚未注册通知渠道"
          hint="先到插件设置页添加渠道和凭据"
        />
      )}
    </SettingsCard>
  );
}
