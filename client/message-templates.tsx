import { useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
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
import { notificationExample } from "../shared/notification-example";
import { validationMessage } from "./validation";
import { SelectedEditor } from "./selected-editor";

type Theme = PluginSurfaceProps["theme"];

function Details({
  label,
  hint,
  open,
  onToggle,
  expandLabel,
  collapseLabel,
  children,
}: {
  label: string;
  hint: string;
  open: boolean;
  onToggle(): void;
  expandLabel: string;
  collapseLabel: string;
  children: ReactNode;
}) {
  return (
    <SettingsCard>
      <SettingsAction
        label={label}
        hint={hint}
        actionLabel={open ? collapseLabel : expandLabel}
        onPress={onToggle}
      />
      {open && children}
    </SettingsCard>
  );
}

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
          minHeight: multiline ? 160 : 42,
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
  onPreviewChange,
  theme,
  disabled,
}: {
  value: MessageTemplate;
  notifications: Pick<
    Config["notifications"],
    "includePreview" | "previewCharacters"
  >;
  onChange(value: MessageTemplate): void;
  onPreviewChange(enabled: boolean): void;
  theme: Theme;
  disabled: boolean;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showRuleHelp, setShowRuleHelp] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const [wide, setWide] = useState(false);
  const [selected, setSelected] = useState(0);
  const [kind, setKind] = useState<NoticeKind>("completed");
  const [sampleTitle, setSampleTitle] = useState(notificationExample().title);
  const [sampleSummary, setSampleSummary] = useState(
    notificationExample().summary,
  );
  const [sampleReply, setSampleReply] = useState(
    notificationExample().preview!,
  );
  const currentIndex = Math.min(selected, value.rules.length - 1);
  const rule = value.rules[currentIndex];
  const parsed = useMemo(() => messageTemplateSchema.safeParse(value), [value]);
  const ruleError = parsed.success
    ? undefined
    : parsed.error.issues.find(
        (issue) =>
          issue.path[0] === "rules" && typeof issue.path[1] === "number",
      );
  const errors = parsed.success
    ? undefined
    : parsed.error.issues
        .slice(0, 5)
        .map((issue) => {
          const field = issue.path[0];
          const label =
            field === "title"
              ? "标题模板"
              : field === "body"
                ? "正文模板"
                : typeof issue.path[1] === "number"
                  ? `提取规则 ${issue.path[1] + 1}`
                  : "提取规则";
          return `${label}：${validationMessage(issue)}`;
        })
        .join("\n");
  const preview = useMemo(
    () =>
      parsed.success
        ? renderNotification(
            {
              ...notificationExample(kind),
              title: sampleTitle,
              summary: sampleSummary,
              preview: sampleReply,
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
  const extraction = preview?.extractions[currentIndex];
  const currentRuleErrors = parsed.success
    ? undefined
    : parsed.error.issues
        .filter(
          (issue) =>
            issue.path[0] === "rules" && issue.path[1] === currentIndex,
        )
        .map(validationMessage)
        .join("\n");
  return (
    <>
      <SettingsSection title="消息模板">
        <Text style={{ color: theme.colors.foregroundMuted }}>
          在这里决定通知写什么。这台 Host
          的所有渠道共用，修改后点击顶部“保存设置”。
        </Text>
        {errors && (
          <SettingsCard>
            {ruleError ? (
              <SettingsAction
                label="模板需要修改"
                error={errors}
                actionLabel="展开错误规则"
                onPress={() => {
                  setSelected(ruleError.path[1] as number);
                  setShowRules(true);
                }}
              />
            ) : (
              <SettingsRow label="模板需要修改" error={errors} />
            )}
          </SettingsCard>
        )}
        <View
          onLayout={({ nativeEvent }) =>
            setWide(nativeEvent.layout.width >= 680)
          }
          style={{ flexDirection: wide ? "row" : "column", gap: 16 }}
          testID="template-editor-preview"
        >
          <View style={{ flex: wide ? 1 : undefined, minWidth: 0 }}>
            <SettingsCard>
              <Field
                label="标题模板"
                hint="例如：Paseo · {{event}} · {{title}}，最多 300 字符。"
                value={value.title}
                onChange={(title) => patch({ title })}
                theme={theme}
                maxLength={300}
                disabled={disabled}
              />
              <Field
                label="正文模板"
                hint="例如填写“任务：{{title}}”，发送时会换成 Paseo 侧栏显示名称，包含你的手动改名。支持换行，最多 6000 字符。"
                value={value.body}
                onChange={(body) => patch({ body })}
                theme={theme}
                multiline
                maxLength={6000}
                disabled={disabled}
              />
              <SettingsAction
                label="恢复默认模板"
                hint="只重置标题和正文，保留提取规则；保存后生效。"
                actionLabel="使用默认模板"
                disabled={disabled}
                onPress={() =>
                  patch({
                    title: defaultTitleTemplate,
                    body: defaultBodyTemplate,
                  })
                }
              />
            </SettingsCard>
          </View>
          <View style={{ flex: wide ? 1 : undefined, minWidth: 0, gap: 12 }}>
            <SettingsCard>
              <SettingsSelect
                label="预览事件"
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
              {preview ? (
                <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
                  <View style={{ padding: 12, gap: 10 }}>
                    <Text
                      selectable
                      accessibilityLabel="预览标题内容"
                      style={{
                        color: theme.colors.foreground,
                        fontWeight: "600",
                        fontSize: 16,
                      }}
                    >
                      {preview.title}
                    </Text>
                    <View
                      style={{
                        height: 1,
                        backgroundColor: theme.colors.border,
                      }}
                    />
                    <Text
                      selectable
                      accessibilityLabel="预览正文内容"
                      style={{ color: theme.colors.foreground, lineHeight: 22 }}
                    >
                      {preview.body}
                    </Text>
                  </View>
                </ScrollView>
              ) : (
                <SettingsRow
                  label="暂时无法预览"
                  hint="修正模板或提取规则错误后恢复预览。"
                />
              )}
              <SettingsSwitch
                label="附带最终回复摘要"
                hint={`允许使用 AI 最终回复的前 ${notifications.previewCharacters} 个字符。正文写 {{preview}} 可显示这段回复，也可只提取其中的工单号等信息。关闭后，通知和提取规则都不使用这段回复。`}
                value={notifications.includePreview}
                disabled={disabled}
                onValueChange={onPreviewChange}
              />
            </SettingsCard>
            <Details
              label="预览示例数据"
              hint="用一段示例回复试试模板效果。这里的示例不会发到群里，也不会保存到设置。"
              open={showSamples}
              onToggle={() => setShowSamples(!showSamples)}
              expandLabel="编辑示例数据"
              collapseLabel="收起示例数据"
            >
              <Field
                label="示例显示名称"
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
            </Details>
          </View>
        </View>
      </SettingsSection>
      <Details
        label={`从内容中提取信息 · ${value.rules.length}/12`}
        hint="例如从回复中找出工单号 PROJ-123，再把它填到通知里。不需要提取时可以跳过。"
        open={showRules}
        onToggle={() => setShowRules(!showRules)}
        expandLabel="展开提取规则"
        collapseLabel="收起提取规则"
      >
        <View style={{ padding: 8, gap: 12 }}>
          <SettingsSection title="添加规则">
            <SettingsCard>
              {extractionExamples.map((example) => (
                <SettingsAction
                  key={example.rule.name}
                  label={`${example.label}示例`}
                  hint="添加预设规则，并在正文末尾加入对应变量。"
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
            </SettingsCard>
          </SettingsSection>
          {rule ? (
            <SelectedEditor
              theme={theme}
              testID="extraction-rule-editor"
              title={`正在编辑：custom.${rule.name || "未命名"}`}
              hint="下方边框内的字段、匹配结果和删除操作只对应上方选中的规则。添加后会自动选中新规则。"
              selector={
                <SettingsSelect
                  label="编辑提取规则"
                  value={String(currentIndex)}
                  options={value.rules.map((item, i) => ({
                    value: String(i),
                    label: `custom.${item.name || "未命名"}`,
                  }))}
                  onValueChange={(v) => setSelected(Number(v))}
                />
              }
            >
              <Field
                label="变量名"
                hint="给结果起一个英文名，例如 ticket，然后在通知中写 {{custom.ticket}}。使用小写字母、数字或下划线，并以字母开头。"
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
                label="匹配规则（Pattern）"
                hint="填写用来查找内容的正则表达式，不加两端的 /。可以先添加上面的工单号或链接示例。"
                value={rule.pattern}
                onChange={(pattern) => patchRule({ pattern })}
                theme={theme}
                disabled={disabled}
              />
              {currentRuleErrors ? (
                <SettingsRow
                  label="当前规则需要修改"
                  error={currentRuleErrors}
                />
              ) : extraction ? (
                <SettingsRow
                  label={`{{custom.${extraction.name}}} · ${extraction.matched ? "已匹配" : "使用默认值"}`}
                  hint={extraction.value || "（空）"}
                />
              ) : null}
              <Field
                label="提取哪一部分（捕获组）"
                hint="填 0 使用完整匹配结果；填 1 只取第一个括号中的内容，填 2 取第二个。"
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
                hint="找不到内容时显示什么，例如“未提供工单号”。留空则让这个变量保持为空。"
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
            </SelectedEditor>
          ) : (
            <SettingsRow
              label="还没有提取规则"
              hint="在上方添加规则，添加后会在这里打开编辑区。"
            />
          )}
        </View>
      </Details>
      <Details
        label="提取规则说明与示例"
        hint="查看提取范围、示例和正则写法。展开说明不会添加或修改规则。"
        open={showRuleHelp}
        onToggle={() => setShowRuleHelp(!showRuleHelp)}
        expandLabel="展开规则说明"
        collapseLabel="收起规则说明"
      >
        <SettingsRow
          label="回复提取范围"
          hint={
            notifications.includePreview
              ? `从回复的前 ${notifications.previewCharacters} 个字符中查找，超出的内容不会参与匹配。`
              : "要从 AI 回复中提取内容，请先开启预览区的“附带最终回复摘要”。关闭时会显示规则中填写的默认值。"
          }
        />
        {extractionExamples.map((example) => (
          <SettingsRow
            key={example.rule.name}
            label={`${example.label}示例：${example.rule.pattern}`}
            hint={example.explanation}
          />
        ))}
        <SettingsRow
          label="Pattern 如何填写"
          hint={
            "只填写表达式，不加 /.../ 包裹。例如“工单[：:]\\s*([A-Z]+-[0-9]+)”中，组 0 是整个匹配，组 1 是括号里的工单号。只取第一次匹配；没有匹配或捕获组没有值时使用默认值。"
          }
        />
        <SettingsRow
          label="支持的语法"
          hint="使用 RE2 语法：字符集、分组、分支、重复等；不支持前后查找（lookaround）和反向引用。i 忽略大小写，m 让 ^/$ 匹配每行，s 让点号匹配换行。最多 12 条规则，每条 Pattern 最多 500 字符。变量重命名或删除后，请同步修改模板中的引用。"
        />
      </Details>
      <Details
        label="占位符与填写帮助"
        hint="不知道 {{title}} 等标记怎么用？展开查看内置信息的含义和发送方式。"
        open={showHelp}
        onToggle={() => setShowHelp(!showHelp)}
        expandLabel="展开填写帮助"
        collapseLabel="收起填写帮助"
      >
        <SettingsRow
          label="占位符用法"
          hint="{{title}} 这样的标记会在发送时换成实际内容。例如“任务：{{title}}”会变成“任务：每日构建检查”。自己提取的工单号可写成 {{custom.ticket}}。"
        />
        {templateFields.map(([name, description]) => (
          <SettingsRow key={name} label={`{{${name}}}`} hint={description} />
        ))}
        <SettingsRow
          label="发送方式"
          hint="ntfy、Bark 和飞书卡片会分开显示标题与正文；普通聊天消息把标题放在第一行。没有内容的变量会留空；一整行只有空变量时会省略。预览使用示例内容，平台可能会缩短过长的消息。"
        />
      </Details>
    </>
  );
}
