import { z } from "zod";
import { RE2JS } from "./vendor/re2js.js";

export const templateFields = [
  ["event", "通知类型，例如“任务完成”“需要处理”"],
  ["event_type", "通知类型的英文代码，例如 completed、blocked"],
  ["title", "会话标题"],
  ["summary", "插件给出的任务状态说明，不是 AI 回复；AI 回复使用 {{preview}}"],
  [
    "preview",
    "AI 最终回复的开头片段；需开启“附带最终回复摘要”，长度由“摘要字符数”决定",
  ],
  ["session_id", "会话的唯一编号，不是会话标题"],
  ["workspace_id", "工作区的唯一编号；没有工作区时留空"],
  ["schedule_id", "来源定时任务的编号；手动创建的普通会话留空"],
  ["provider", "使用的 AI 工具，例如 codex"],
  ["failure", "中断原因，例如“网络故障”；没有异常时留空"],
  ["failure_type", "中断原因的英文代码，例如 network；没有异常时留空"],
  ["attempts", "自动恢复尝试次数，未恢复时为 0"],
  ["recovery", "有恢复时填入“自动恢复尝试：N 次”，否则为空"],
  ["created_at", "通知发生时间，使用 UTC 时区，例如 2026-01-01T08:00:00Z"],
  ["notification_id", "这条通知的唯一编号，可用于核对运行记录"],
] as const;

export const defaultTitleTemplate = "Paseo · {{event}}";
export const defaultBodyTemplate = [
  "{{title}}",
  "{{summary}}",
  "{{preview}}",
  "{{recovery}}",
  "会话：{{session_id}}",
  "提供方：{{provider}}",
  "{{created_at}}",
].join("\n");
export const extractionSources = [
  { value: "preview", label: "最终回复摘要" },
  { value: "title", label: "会话标题" },
  { value: "summary", label: "状态说明" },
] as const;

const compiled = new Map<string, RE2JS>();
export function compilePattern(pattern: string, flags: string): RE2JS {
  const key = JSON.stringify([pattern, flags]);
  const cached = compiled.get(key);
  if (cached) return cached;
  let bits = 0;
  if (flags.includes("i")) bits |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes("m")) bits |= RE2JS.MULTILINE;
  if (flags.includes("s")) bits |= RE2JS.DOTALL;
  const regex = RE2JS.compile(pattern, bits);
  if (regex.programSize() > 4096)
    throw new Error("Pattern 过于复杂，请简化重复次数或分支");
  if (compiled.size >= 64) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, regex);
  return regex;
}

export const extractionRuleSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9_]{0,31}$/,
        "变量名以小写字母开头，仅含小写字母、数字、下划线，最多 32 字符",
      ),
    source: z.enum(["preview", "title", "summary"]).default("preview"),
    pattern: z.string().min(1, "请填写 Pattern").max(500),
    flags: z
      .string()
      .max(3)
      .regex(/^(?!.*(.).*\1)[ims]*$/, "标志仅支持 i、m、s，不能重复")
      .default(""),
    group: z.number().int().min(0).max(20).default(0),
    fallback: z.string().max(500).default(""),
  })
  .superRefine((rule, ctx) => {
    if (!rule.pattern || rule.pattern.length > 500) return;
    try {
      const regex = compilePattern(rule.pattern, rule.flags);
      if (rule.group > regex.groupCount())
        ctx.addIssue({
          code: "custom",
          path: ["group"],
          message: `Pattern 只有 ${regex.groupCount()} 个捕获组；0 代表整个匹配`,
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message:
          "Pattern 无效或过于复杂；使用 RE2 语法，不支持前后查找和反向引用",
      });
    }
  });
export type ExtractionRule = z.infer<typeof extractionRuleSchema>;

export const messageTemplateSchema = z
  .object({
    title: z
      .string()
      .min(1, "请填写标题模板")
      .max(300)
      .default(defaultTitleTemplate),
    body: z
      .string()
      .min(1, "请填写正文模板")
      .max(6000)
      .default(defaultBodyTemplate),
    rules: z
      .array(extractionRuleSchema)
      .max(12, "最多添加 12 条提取规则")
      .default([]),
  })
  .superRefine((template, ctx) => {
    const known = new Set<string>(templateFields.map(([name]) => name));
    for (const [i, rule] of template.rules.entries()) {
      const name = `custom.${rule.name}`;
      if (known.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "name"],
          message: "变量名不能重复",
        });
      known.add(name);
    }
    for (const field of ["title", "body"] as const) {
      const text = template[field];
      if (!text.trim())
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "模板不能只包含空白",
        });
      const rest = text.replace(/\{\{([^{}]*)\}\}/g, (_, raw: string) => {
        if (!known.has(raw.trim()))
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `未知占位符：{{${raw.trim().slice(0, 80)}}}`,
          });
        return "";
      });
      if (rest.includes("{{") || rest.includes("}}"))
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "占位符使用完整的 {{名称}}，请检查括号",
        });
    }
  });
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;
export const defaultMessageTemplate = (): MessageTemplate =>
  messageTemplateSchema.parse({});

export const extractionExamples: {
  label: string;
  explanation: string;
  rule: ExtractionRule;
}[] = [
  {
    label: "工单号",
    explanation: "回复“已处理工单 PROJ-123” → PROJ-123；组 0 取整个匹配。",
    rule: {
      name: "ticket",
      source: "preview",
      pattern: "[A-Z][A-Z0-9]+-[0-9]+",
      flags: "",
      group: 0,
      fallback: "未提供工单号",
    },
  },
  {
    label: "结果链接",
    explanation:
      "回复“结果：https://example.com/result/123” → URL；组 1 只取括号内的链接。",
    rule: {
      name: "link",
      source: "preview",
      pattern: "结果[：:]\\s*(https?://[^\\s]+)",
      flags: "i",
      group: 1,
      fallback: "未提供链接",
    },
  },
];
