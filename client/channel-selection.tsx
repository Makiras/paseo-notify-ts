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
          hint="使用上级设置的通知渠道。上级以后更换渠道，这里也会一起变化。"
          value={value === undefined}
          disabled={disabled}
          onValueChange={(inherit) => onChange(inherit ? undefined : [])}
        />
      )}
      {value !== undefined && (
        <>
          {!value.length && (
            <SettingsRow
              label={inheritable ? "此处已关闭通知" : "还没有默认通知渠道"}
              hint={
                inheritable
                  ? "选择下方渠道可重新开启通知，或打开“跟随上级”。更具体的工作区或会话设置仍然优先。"
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
              label="取消这里选择的所有渠道"
              actionLabel="关闭通知"
              disabled={disabled}
              onPress={() => onChange([])}
            />
          )}
        </>
      )}
      {!channels.length && (
        <SettingsRow
          label="还没有通知渠道"
          hint="先到插件的“通知渠道”页面添加渠道，并保存连接信息。"
        />
      )}
    </SettingsCard>
  );
}
