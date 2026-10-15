import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { noticeLabels, type Config, type NoticeKind } from "../shared/config";
import {
  defaultBodyTemplate,
  defaultTitleTemplate,
  extractionExamples,
  extractionSources,
  messageTemplateSchema,
  templateFields,
  type ExtractionRule,
  type MessageTemplate,
} from "../shared/template-schema";
import { renderNotification } from "../shared/templates";

type Theme = PluginSurfaceProps["theme"];
function Field({
  label,
  hint,
  value,
  onChange,
  theme,
  multiline = false,
  maxLength = 500,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(value: string): void;
  theme: Theme;
  multiline?: boolean;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <View style={{ padding: 12, gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        {label}
      </Text>
      {hint && (
        <Text style={{ color: theme.colors.foregroundMuted }}>{hint}</Text>
      )}
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        maxLength={maxLength}
        editable={!disabled}
        autoCorrect={false}
        autoCapitalize="none"
        style={{
          color: theme.colors.foreground,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 6,
          padding: 10,
          minHeight: multiline ? 100 : 42,
          maxHeight: multiline ? 240 : undefined,
          textAlignVertical: "top",
        }}
      />
    </View>
  );
}

export function MessageTemplates({
  value,
  notifications,
  onChange,
  theme,
  disabled,
}: {
  value: MessageTemplate;
  notifications: Pick<
    Config["notifications"],
    "includePreview" | "previewCharacters"
  >;
  onChange(value: MessageTemplate): void;
  theme: Theme;
  disabled: boolean;
}) {
  const [showFields, setShowFields] = useState(false);
  const [selected, setSelected] = useState(0);
  const [kind, setKind] = useState<NoticeKind>("completed");
  const [sampleTitle, setSampleTitle] = useState("每日构建检查");
  const [sampleSummary, setSampleSummary] =
    useState("请在 Paseo 查看任务结果。");
  const [sampleReply, setSampleReply] = useState(
    "已处理工单 PROJ-123。\n结果：https://example.com/result/123\n全部检查通过。",
  );
  const currentIndex = Math.min(selected, value.rules.length - 1);
  const rule = value.rules[currentIndex];
  const parsed = useMemo(() => messageTemplateSchema.safeParse(value), [value]);
  const preview = useMemo(
    () =>
      parsed.success
        ? renderNotification(
            {
              id: "example-notification",
              kind,
              agentId: "example-session",
              workspaceId: "example-workspace",
              scheduleId: "daily-check",
              provider: "codex",
              title: sampleTitle,
              summary: sampleSummary,
              preview: sampleReply,
              createdAt: Date.UTC(2026, 0, 1, 8),
              attempts: ["recovered", "failed"].includes(kind) ? 2 : 0,
              failure:
                kind === "blocked"
                  ? "policy_blocked"
                  : ["recovered", "failed"].includes(kind)
                    ? "network"
                    : undefined,
            },
            { ...notifications, template: parsed.data },
          )
        : null,
    [
      parsed,
      kind,
      sampleTitle,
      sampleSummary,
      sampleReply,
      notifications.includePreview,
      notifications.previewCharacters,
    ],
  );
  const patch = (next: Partial<MessageTemplate>) => {
    if (!disabled) onChange({ ...value, ...next });
  };
  const patchRule = (next: Partial<ExtractionRule>) =>
    patch({
      rules: value.rules.map((item, i) =>
        i === currentIndex ? { ...item, ...next } : item,
      ),
    });
  const addRule = (candidate: ExtractionRule, label?: string) => {
    if (disabled || value.rules.length >= 12) return;
    let name = candidate.name,
      suffix = 2;
    while (value.rules.some((item) => item.name === name))
      name = `${candidate.name}_${suffix++}`;
    patch({
      rules: [...value.rules, { ...candidate, name }],
      ...(label ? { body: `${value.body}\n${label}：{{custom.${name}}}` } : {}),
    });
    setSelected(value.rules.length);
  };
  return (
    <>
      <SettingsSection title="消息模板">
        <SettingsCard>
          <SettingsRow
            label="用 Pattern 补全通知内容"
            hint="填写 {{title}} 等占位符，发送时自动替换。自定义提取变量写作 {{custom.变量名}}。本 Host 的所有渠道共用此模板；修改后点页面顶部“保存设置”。"
          />
          <Field
            label="标题模板"
            hint="例如：Paseo · {{event}} · {{title}}"
            value={value.title}
            onChange={(title) => patch({ title })}
            theme={theme}
            maxLength={300}
            disabled={disabled}
          />
          <Field
            label="正文模板"
            hint="例如：任务：{{title}}，状态：{{summary}}。支持换行；最多 6000 字符。"
            value={value.body}
            onChange={(body) => patch({ body })}
            theme={theme}
            multiline
            maxLength={6000}
            disabled={disabled}
          />
          <SettingsRow
            label="发送方式"
            hint="ntfy 和 Bark 分别使用标题、正文；其他聊天渠道把标题放在正文第一行。模板是纯文本，不执行脚本。仅含空占位符的行会省略；整段为空时使用默认事件标题或状态说明。平台可能截断超长消息。"
          />
          <SettingsAction
            label="恢复默认模板"
            hint="只重置标题和正文，保留提取规则；保存后生效。"
            actionLabel="使用默认模板"
            disabled={disabled}
            onPress={() =>
              patch({ title: defaultTitleTemplate, body: defaultBodyTemplate })
            }
          />
          {!parsed.success && (
            <SettingsRow
              label="模板需要修改"
              error={parsed.error.issues
                .slice(0, 5)
                .map((issue) => `${issue.path.join(".")}：${issue.message}`)
                .join("\n")}
            />
          )}
          <SettingsAction
            label={`内置占位符说明（${templateFields.length} 项）`}
            hint="常用：{{title}} 会话标题、{{summary}} 状态说明、{{preview}} 最终回复摘要。"
            actionLabel={showFields ? "收起字段说明" : "展开字段说明"}
            onPress={() => setShowFields(!showFields)}
          />
          {showFields &&
            templateFields.map(([name, description]) => (
              <SettingsRow
                key={name}
                label={`{{${name}}}`}
                hint={description}
              />
            ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="自定义正则提取">
        <SettingsCard>
          <SettingsRow
            label="Pattern 如何填写"
            hint={
              "只填写表达式，不加 /.../ 包裹。例如“工单[：:]\\s*([A-Z]+-[0-9]+)”中，组 0 是整个匹配，组 1 是括号里的工单号。只取第一次匹配；没有匹配或捕获组没有值时使用默认值。"
            }
          />
          <SettingsRow
            label="支持的语法"
            hint="使用 RE2 语法：字符集、分组、分支、重复等；不支持前后查找（lookaround）和反向引用。i 忽略大小写，m 让 ^/$ 匹配每行，s 让点号匹配换行。最多 12 条规则，每条 Pattern 最多 500 字符。"
          />
          <SettingsRow
            label="回复提取范围"
            hint={`只读取“附带最终回复摘要”允许发送的前 ${notifications.previewCharacters} 个字符，不读取完整会话。${notifications.includePreview ? "摘要已开启。" : "摘要当前关闭：回复规则会使用未匹配默认值。"} 变量重命名或删除后，请同步修改模板中的引用。`}
          />
          {extractionExamples.map((example) => (
            <SettingsAction
              key={example.rule.name}
              label={`${example.label}示例：${example.rule.pattern}`}
              hint={`${example.explanation} 点击后添加规则，并在正文末尾加入变量。`}
              actionLabel={`添加${example.label}示例`}
              disabled={disabled || value.rules.length >= 12}
              onPress={() => addRule(example.rule, example.label)}
            />
          ))}
          <SettingsAction
            label="新增自定义规则"
            actionLabel="添加提取规则"
            disabled={disabled || value.rules.length >= 12}
            onPress={() =>
              addRule({
                name: "field",
                source: "preview",
                pattern: "",
                flags: "",
                group: 0,
                fallback: "",
              })
            }
          />
          {rule && (
            <>
              <SettingsSelect
                label="编辑提取规则"
                value={String(currentIndex)}
                options={value.rules.map((item, i) => ({
                  value: String(i),
                  label: `custom.${item.name || "未命名"}`,
                }))}
                onValueChange={(v) => setSelected(Number(v))}
              />
              <Field
                label="变量名"
                hint="例如 ticket；模板中使用 {{custom.ticket}}。小写字母开头，仅含字母、数字、下划线。"
                value={rule.name}
                onChange={(name) => patchRule({ name })}
                theme={theme}
                maxLength={32}
                disabled={disabled}
              />
              <SettingsSelect
                label="提取来源"
                value={rule.source}
                options={[...extractionSources]}
                onValueChange={(source) => {
                  if (extractionSources.some((s) => s.value === source))
                    patchRule({ source: source as ExtractionRule["source"] });
                }}
              />
              <Field
                label="Pattern 表达式"
                value={rule.pattern}
                onChange={(pattern) => patchRule({ pattern })}
                theme={theme}
                disabled={disabled}
              />
              <Field
                label="捕获组"
                hint="0：整个匹配；1：第一个括号；2：第二个括号，以此类推。"
                value={Number.isNaN(rule.group) ? "" : String(rule.group)}
                onChange={(text) =>
                  patchRule({ group: text.trim() ? Number(text) : NaN })
                }
                theme={theme}
                maxLength={2}
                disabled={disabled}
              />
              {(
                [
                  ["i", "忽略大小写（i）"],
                  ["m", "多行锚点（m）"],
                  ["s", "点号匹配换行（s）"],
                ] as const
              ).map(([flag, label]) => (
                <SettingsSwitch
                  key={flag}
                  label={label}
                  value={rule.flags.includes(flag)}
                  disabled={disabled}
                  onValueChange={(enabled) =>
                    patchRule({
                      flags: enabled
                        ? [...new Set(rule.flags + flag)].sort().join("")
                        : rule.flags.replace(flag, ""),
                    })
                  }
                />
              ))}
              <Field
                label="未匹配默认值"
                hint="留空表示空字符串。默认值中的占位符按普通文字处理。"
                value={rule.fallback}
                onChange={(fallback) => patchRule({ fallback })}
                theme={theme}
                disabled={disabled}
              />
              <SettingsAction
                label={`正文引用：{{custom.${rule.name}}}`}
                actionLabel="将变量加入正文"
                disabled={disabled}
                onPress={() =>
                  patch({ body: `${value.body}\n{{custom.${rule.name}}}` })
                }
              />
              <SettingsAction
                label="删除当前规则"
                hint="如模板正在引用此变量，请同时修改正文或标题。"
                actionLabel="删除提取规则"
                disabled={disabled}
                onPress={() =>
                  patch({
                    rules: value.rules.filter((_, i) => i !== currentIndex),
                  })
                }
              />
            </>
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="模板预览">
        <SettingsCard>
          <SettingsRow
            label="使用示例数据预览"
            hint="这里的文本仅用于预览，不保存、不发送，也不读取真实会话。更改模板或示例后会立即更新；实际通知仍受平台长度限制。"
          />
          <SettingsSelect
            label="示例事件"
            value={kind}
            options={Object.entries(noticeLabels).map(([value, label]) => ({
              value,
              label,
            }))}
            onValueChange={(next) => {
              if (Object.hasOwn(noticeLabels, next))
                setKind(next as NoticeKind);
            }}
          />
          <Field
            label="示例会话标题"
            value={sampleTitle}
            onChange={setSampleTitle}
            theme={theme}
            maxLength={200}
          />
          <Field
            label="示例状态说明"
            value={sampleSummary}
            onChange={setSampleSummary}
            theme={theme}
            maxLength={2000}
          />
          <Field
            label="示例回复"
            value={sampleReply}
            onChange={setSampleReply}
            theme={theme}
            multiline
            maxLength={4000}
          />
          {preview ? (
            <>
              {preview.extractions.map((result) => (
                <SettingsRow
                  key={result.name}
                  label={`{{custom.${result.name}}} · ${result.matched ? "已匹配" : "使用默认值"}`}
                  hint={result.value || "（空）"}
                />
              ))}
              <SettingsRow label="预览标题" hint={preview.title} />
              <View style={{ padding: 12, gap: 6 }}>
                <Text
                  style={{ color: theme.colors.foreground, fontWeight: "600" }}
                >
                  预览正文
                </Text>
                <Text
                  selectable
                  accessibilityLabel="预览正文内容"
                  style={{ color: theme.colors.foreground }}
                >
                  {preview.body}
                </Text>
              </View>
            </>
          ) : (
            <SettingsRow
              label="暂时无法预览"
              hint="修正上面的模板或 Pattern 错误后恢复预览。"
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
