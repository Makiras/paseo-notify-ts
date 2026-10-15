import { useCallback, useEffect, useRef, useState } from "react";
import {
  openExternalUrl,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  checkUpdatesRpc,
  installUpdateRpc,
  updateWorkspacesRpc,
  updateStatusSchema,
  type UpdateStatus,
} from "../shared/updates";
import { pluginRepository, pluginVersion } from "../shared/version";

export function UpdatesPanel({
  automatic,
  savedAutomatic,
  onAutomaticChange,
  revision,
  disabled,
  onBusyChange,
  navigation,
  host,
}: {
  automatic: boolean;
  savedAutomatic: boolean;
  onAutomaticChange(value: boolean): void;
  revision: string;
  disabled: boolean;
  onBusyChange(value: boolean): void;
  navigation: PluginSurfaceProps["navigation"];
  host: PluginSurfaceProps["host"];
}) {
  const check = useRpc(checkUpdatesRpc),
    install = useRpc(installUpdateRpc),
    listWorkspaces = useRpc(updateWorkspacesRpc);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [job, setJob] = useState<{
    terminalId: string;
    workspaceId: string;
  } | null>(null);
  const generation = useRef(0);
  const lock = useRef(false);
  const refresh = useCallback(
    async (force: boolean) => {
      const request = ++generation.current;
      setChecking(true);
      try {
        const next = updateStatusSchema.parse(await check({ force }));
        if (request !== generation.current) return;
        setStatus(next);
        setError(null);
      } catch {
        if (request === generation.current)
          setError("无法读取更新状态，请检查 Host 连接后重试。");
      } finally {
        if (request === generation.current) setChecking(false);
      }
    },
    [check],
  );
  useEffect(() => {
    void refresh(false);
    return () => {
      generation.current++;
    };
  }, [refresh, savedAutomatic]);
  async function start() {
    if (disabled || lock.current || !status?.release || !workspaceId) return;
    lock.current = true;
    setInstalling(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await install({
        releaseId: status.release.id,
        tag: status.release.tag,
        workspaceId,
        revision,
      });
      setJob(result);
      setFeedback(
        "已创建更新终端；安装结果以终端输出和重新打开设置后的版本为准。插件重载时页面可能短暂断开。",
      );
    } catch {
      setError(
        "更新未启动或回执未确认。请先检查所选工作区的 Notifier update 终端和插件状态，再重新检查更新；不要连续点击安装。",
      );
    } finally {
      lock.current = false;
      setInstalling(false);
      onBusyChange(false);
    }
  }
  return (
    <SettingsSection title="版本与更新">
      <SettingsCard>
        <SettingsRow
          label={`当前版本 ${status?.currentVersion ?? pluginVersion}`}
          hint={
            status?.currentRevision
              ? `提交 ${status.currentRevision.slice(0, 12)}`
              : "当前 Host 的 Paseo Notifier"
          }
        />
        <SettingsSwitch
          label="打开设置时自动检查更新"
          hint="有正式新版时显示提醒，由你决定是否安装。成功查到的结果保留 6 小时；点击“检查更新”可重新检查。"
          value={automatic}
          disabled={installing}
          onValueChange={onAutomaticChange}
        />
        <SettingsAction
          label="查找可安装的正式版本"
          actionLabel={checking ? "检查中…" : "检查更新"}
          disabled={checking || installing}
          onPress={() => void refresh(true)}
        />
        {status && (
          <SettingsRow
            label={
              status.error
                ? "更新信息暂不可用"
                : status.available
                  ? `发现新版本 ${status.release?.tag}`
                  : status.release
                    ? "没有更新的正式版本"
                    : status.checkedAt
                      ? "暂未发布正式版本"
                      : "尚未检查更新"
            }
            hint={
              status.checkedAt
                ? `上次成功检查：${new Date(status.checkedAt).toLocaleString()}`
                : undefined
            }
            error={status.error ?? undefined}
          />
        )}
        <SettingsAction
          label="查看发布说明与安装包"
          actionLabel="GitHub Releases"
          onPress={() =>
            void openExternalUrl(
              status?.release?.url ??
                `https://github.com/${pluginRepository}/releases`,
            ).catch(() => setError("无法打开发布页面"))
          }
        />
        {status?.available && (
          <>
            <SettingsRow label="手动安装更新" hint={status.installHint} />
            {disabled && (
              <SettingsRow
                label="请先保存或放弃当前修改"
                hint="更新会重载插件；未保存的设置和凭据不能随重载保留。"
              />
            )}
            {status.canInstall && (
              <>
                <SettingsAction
                  label="选择用于显示安装输出的工作区终端"
                  actionLabel="选择工作区"
                  disabled={disabled || installing}
                  onPress={() => {
                    void listWorkspaces({})
                      .then((items) => {
                        setWorkspaces(items);
                        setError(null);
                      })
                      .catch(() => setError("无法读取工作区列表"));
                  }}
                />
                {workspaces && (
                  <SettingsSelect
                    label="安装终端所在工作区"
                    value={workspaceId}
                    options={[
                      { label: "请选择工作区", value: "" },
                      ...workspaces.map((w) => ({
                        label: w.name,
                        value: w.id,
                      })),
                    ]}
                    disabled={disabled || installing}
                    onValueChange={(id) => {
                      setWorkspaceId(id);
                      setJob(null);
                    }}
                  />
                )}
                {workspaces?.length === 0 && (
                  <SettingsRow
                    label="当前 Host 尚无可用工作区"
                    hint="打开一个工作区后重新读取，或在 Host 终端执行更新命令。"
                  />
                )}
                {workspaceId && (
                  <SettingsAction
                    label={`在 ${host.label} 安装 ${status.release?.tag}`}
                    hint="在所选工作区的终端中安装新版。安装完成时插件会短暂重新加载。"
                    actionLabel={
                      installing ? "正在启动…" : `安装 ${status.release?.tag}`
                    }
                    disabled={disabled || installing || !!job}
                    onPress={() => void start()}
                  />
                )}
              </>
            )}
            {status.command && (
              <SettingsAction
                label="在 Host 终端手动执行"
                hint={status.command}
                actionLabel="复制更新命令"
                onPress={() =>
                  void copyText(status.command!)
                    .then(() =>
                      setFeedback("更新命令已复制，请在当前 Host 的终端执行。"),
                    )
                    .catch(() =>
                      setError("无法访问剪贴板，请手动复制上方命令。"),
                    )
                }
              />
            )}
          </>
        )}
        {job && navigation && (
          <SettingsAction
            label="查看更新终端"
            actionLabel="打开工作区"
            onPress={() =>
              navigation.openWorkspace({
                workspaceId: job.workspaceId,
                serverId: host.id,
              })
            }
          />
        )}
        {feedback && <SettingsRow label="更新操作" hint={feedback} />}
        {error && <SettingsRow label="更新提示" error={error} />}
      </SettingsCard>
    </SettingsSection>
  );
}
