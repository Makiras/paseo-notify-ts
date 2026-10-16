import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  listSessionsRpc,
  sessionStatus,
  type SessionInfo,
} from "../shared/sessions";
import { SessionDelete } from "./session-delete";

export function SessionCleanup(props: PluginSurfaceProps) {
  return <SessionList key={props.host.id} {...props} />;
}
function SessionList({ theme, host, navigation }: PluginSurfaceProps) {
  const list = useRpc(listSessionsRpc);
  const [items, setItems] = useState<SessionInfo[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  const [canDelete, setCanDelete] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("archived"),
    [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const lock = useRef(false),
    mounted = useRef(true);
  const load = async (more = false) => {
    if (lock.current || deleting) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    if (!more) setSelected([]);
    try {
      const result = await list(more && cursor ? { cursor } : {});
      if (!mounted.current) return;
      setItems((old) => [
        ...new Map(
          [...(more ? old : []), ...result.sessions].map((s) => [s.id, s]),
        ).values(),
      ]);
      setUnreadable(result.unreadable);
      setCursor(result.nextCursor);
      setCanDelete(result.canDelete);
      setLoaded(true);
    } catch {
      if (mounted.current) setError("无法读取会话列表，请检查 Host 连接后重试");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, []);
  const search = query.trim().toLowerCase();
  const visible = items.filter(
    (s) =>
      (scope === "all" ||
        (scope === "archived" ? Boolean(s.archivedAt) : !s.archivedAt)) &&
      (!search ||
        [s.title, s.provider, s.cwd, s.id].some((text) =>
          text.toLowerCase().includes(search),
        )),
  );
  const groups = new Map<string, SessionInfo[]>();
  for (const item of visible) {
    const date = new Date(item.updatedAt);
    const day = Number.isNaN(date.getTime())
      ? "时间未知"
      : date.toLocaleDateString();
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return (
    <View style={{ gap: 16 }}>
      <SettingsSection title="会话清理">
        <SettingsCard>
          <SettingsRow
            label={`Host：${host.label}`}
            hint="按最近更新时间分组。先选择会话，再查看删除清单并确认；每次最多 20 个。删除立即生效，无需保存设置。"
          />
          <SettingsSelect
            label="查看范围"
            value={scope}
            options={[
              { value: "archived", label: "已归档" },
              { value: "active", label: "未归档" },
              { value: "all", label: "全部会话" },
            ]}
            disabled={deleting || busy}
            onValueChange={(value) => {
              setScope(value);
              setSelected([]);
            }}
          />
          <View style={{ padding: 12, gap: 6 }}>
            <Text style={{ color: theme.colors.foregroundMuted }}>
              搜索已加载会话（标题、目录、提供方或 ID）
            </Text>
            <TextInput
              accessibilityLabel="搜索会话"
              value={query}
              editable={!deleting && !busy}
              onChangeText={(value) => {
                setQuery(value);
                setSelected([]);
              }}
              style={{
                color: theme.colors.foreground,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 6,
                padding: 10,
                minHeight: 44,
              }}
            />
          </View>
          <SettingsAction
            label={`已加载 ${items.length} 个，当前显示 ${visible.length} 个，已选 ${selected.length} 个`}
            actionLabel={busy ? "读取中…" : "刷新会话"}
            disabled={busy || deleting}
            onPress={() => void load()}
          />
          <SettingsAction
            label="选择当前结果的前 20 个会话"
            actionLabel="选择当前结果"
            disabled={!visible.length || busy || deleting || !canDelete}
            onPress={() => setSelected(visible.slice(0, 20).map((s) => s.id))}
          />
          {!!selected.length && (
            <SettingsAction
              label="保留全部会话"
              actionLabel="清空选择"
              disabled={deleting}
              onPress={() => setSelected([])}
            />
          )}
          {error && <SettingsRow label="读取失败" error={error} />}
          {unreadable > 0 && (
            <SettingsRow
              label="部分会话未能读取"
              hint={`${unreadable} 项记录或目录暂时无法读取，当前列表可能不完整；请检查 Host 日志或目录权限后刷新。`}
            />
          )}
          {loaded && !canDelete && (
            <SettingsRow
              label="当前 Host 无法删除"
              hint="需要 Host 上可执行的 Paseo CLI；列表仍可查看。"
            />
          )}
        </SettingsCard>
      </SettingsSection>
      {[...groups].map(([day, sessions]) => (
        <SettingsSection key={day} title={day}>
          <SettingsCard>
            {sessions.map((s) => (
              <View key={s.id} testID={`cleanup-session-${s.id}`}>
                <SettingsSwitch
                  label={s.title}
                  hint={`${s.provider} · ${sessionStatus(s)} · ${new Date(s.updatedAt).toLocaleTimeString()}\n${s.cwd}\n${s.id}`}
                  value={selected.includes(s.id)}
                  disabled={
                    busy ||
                    deleting ||
                    !canDelete ||
                    (!selected.includes(s.id) && selected.length >= 20)
                  }
                  onValueChange={(checked) =>
                    setSelected((old) =>
                      checked
                        ? [...new Set([...old, s.id])]
                        : old.filter((id) => id !== s.id),
                    )
                  }
                />
                {navigation && (
                  <SettingsAction
                    label="查看此会话"
                    actionLabel="打开会话"
                    disabled={deleting}
                    onPress={() =>
                      navigation.openAgent({ agentId: s.id, serverId: host.id })
                    }
                  />
                )}
              </View>
            ))}
          </SettingsCard>
        </SettingsSection>
      ))}
      {loaded && !visible.length && (
        <SettingsCard>
          <SettingsRow
            label="当前没有匹配的会话"
            hint={
              cursor
                ? "还有未加载的会话，可继续加载后搜索。"
                : "可以更换查看范围或搜索内容。"
            }
          />
        </SettingsCard>
      )}
      {cursor && (
        <SettingsCard>
          <SettingsAction
            label="继续查看更早的会话"
            actionLabel="加载更多会话"
            disabled={busy || deleting}
            onPress={() => void load(true)}
          />
        </SettingsCard>
      )}
      <SessionDelete
        ids={selected}
        archivedOnly={scope === "archived"}
        theme={theme}
        disabled={busy || !canDelete}
        onBusyChange={setDeleting}
        onDone={(ids) => {
          setItems((old) => old.filter((s) => !ids.includes(s.id)));
          setSelected((old) => old.filter((id) => !ids.includes(id)));
        }}
      />
    </View>
  );
}
