import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import type { Config } from "../shared/config";
import { listSchedulesRpc, type ScheduleInfo } from "../shared/schedules";
import { routeLabel } from "../shared/routing";
import { ChannelSelection } from "./channel-selection";

const statusNames = { active: "已启用", paused: "已暂停", completed: "已结束" };

export function ScheduleSelection({
  config,
  disabled,
  onChange,
}: {
  config: Config;
  disabled: boolean;
  onChange(value: Config["routing"]["schedules"]): void;
}) {
  const read = useRpc(listSchedulesRpc);
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [unreadable, setUnreadable] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const result = await read({});
      if (current !== request.current) return;
      setSchedules(result.schedules);
      setUnreadable(result.unreadable);
      setError(null);
    } catch {
      if (current === request.current)
        setError("无法读取任务列表，请检查 Host 连接或数据目录后重试");
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [read]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);
  const options = schedules.map((schedule) => ({
    label: `${schedule.name} · ${statusNames[schedule.status]} · ${schedule.id}`,
    value: schedule.id,
  }));
  for (const id of Object.keys(config.routing.schedules))
    if (!schedules.some((s) => s.id === id))
      options.push({ label: `${id} · 已保存绑定，任务不在列表中`, value: id });
  const id = options.some((o) => o.value === selected)
    ? selected
    : (options[0]?.value ?? "");
  const schedule = schedules.find((s) => s.id === id);
  return (
    <SettingsSection title="定时任务通知渠道">
      <SettingsCard>
        <SettingsRow
          label="为定时任务选择通知去向"
          hint="每次运行都使用这里选定的渠道。没有单独选择时，使用 Host 默认渠道；工作区或会话中单独选定的渠道优先。修改后点击顶部“保存设置”。"
        />
        <SettingsAction
          label="读取 Paseo 定时任务"
          actionLabel={loading ? "读取中…" : "刷新任务列表"}
          disabled={loading || disabled}
          onPress={() => void refresh()}
        />
        {error && <SettingsRow label="任务列表读取失败" error={error} />}
        {unreadable > 0 && (
          <SettingsRow
            label={`有 ${unreadable} 个任务文件无法读取`}
            hint="其他任务仍可配置；已有绑定不会被删除"
          />
        )}
        {!loading && !error && !options.length && (
          <SettingsRow
            label="尚无定时任务"
            hint="先在 Paseo 的 Schedules 页面创建任务，再刷新列表。Heartbeat 使用其原会话的渠道选择。"
          />
        )}
        {id && (
          <>
            <SettingsSelect
              label="定时任务"
              value={id}
              options={options}
              disabled={disabled}
              onValueChange={setSelected}
            />
            {!schedule && !loading && !error && (
              <SettingsRow
                label="此任务不在当前列表中"
                hint="若已删除此任务，可打开下方“跟随上级”并保存，移除旧绑定。暂停或执行结束的任务无需清理；读取失败不会自动删除绑定。"
              />
            )}
            {schedule && (
              <SettingsRow
                label="执行计划"
                hint={`${schedule.cadence} · ${schedule.timezone} · ${schedule.cwd}`}
              />
            )}
            <SettingsRow
              label="任务默认通知去向"
              hint={routeLabel(config, { scheduleId: id })}
            />
          </>
        )}
      </SettingsCard>
      {id && (
        <ChannelSelection
          channels={config.channels}
          value={config.routing.schedules[id]}
          inheritable
          disabled={disabled}
          onChange={(value) => {
            const next = { ...config.routing.schedules };
            if (value === undefined) delete next[id];
            else next[id] = value;
            onChange(next);
          }}
        />
      )}
    </SettingsSection>
  );
}
