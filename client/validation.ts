import type { z } from "zod";

// Keep the host's global Zod locale unchanged; translate only this plugin's UI.
export function validationMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "too_small" || issue.code === "too_big") {
    const minimum = issue.code === "too_small";
    const bound = minimum ? issue.minimum : issue.maximum;
    const unit =
      issue.origin === "string"
        ? " 个字符"
        : issue.origin === "array"
          ? " 项"
          : "";
    return `${minimum ? "至少" : "最多"}${bound}${unit}`;
  }
  if (issue.code === "invalid_type") {
    if (issue.expected === "number") return "请填写有效数字";
    if (issue.expected === "int") return "请填写整数";
    return "请检查填写内容";
  }
  if (issue.code === "invalid_value") return "请从可用选项中选择";
  return issue.message;
}

const fields: Record<string, string> = {
  enabled: "启用开关",
  includeSubagents: "包含子代理",
  updates: "版本更新",
  checkAutomatically: "自动检查更新",
  recovery: "自动恢复",
  network: "网络故障",
  overloaded: "服务繁忙",
  rateLimited: "请求限流",
  maxElapsedMinutes: "恢复时间上限",
  baseDelaySeconds: "初始等待",
  maxDelaySeconds: "两次重试最多间隔",
  prompt: "继续指令",
  review: "AI 复核",
  provider: "AI 提供方",
  timeoutSeconds: "复核等待时间",
  maxReviews: "最多复核次数",
  contextCharacters: "会话摘录字符上限",
  notifications: "通知管理",
  includePreview: "附带最终回复摘要",
  previewCharacters: "摘要字符数",
  retentionDays: "运行记录保留天数",
  template: "消息模板",
  title: "标题模板",
  body: "正文模板",
  rules: "提取规则",
  name: "名称",
  pattern: "匹配规则",
  flags: "匹配选项",
  group: "提取部分",
  fallback: "未匹配默认值",
  source: "提取来源",
  channels: "通知渠道",
  id: "渠道标识",
  originId: "来源渠道标识",
  kind: "通知平台",
  feishu: "飞书",
  messageType: "消息类型",
  events: "通知类型",
  providers: "限定提供方",
  workspaceIds: "限定工作区",
  routing: "通知去向",
  host: "Host 默认渠道",
  workspaces: "工作区",
  sessions: "会话",
  schedules: "定时任务",
};

export function settingsIssue(issue: z.core.$ZodIssue): string {
  const label = issue.path
    .map((part) => {
      if (typeof part === "number") return `第 ${part + 1} 项`;
      if (part === "maxAttempts")
        return issue.path[0] === "recovery"
          ? "最大重试次数"
          : "通知最多发送次数";
      return fields[String(part)] ?? String(part);
    })
    .join(" · ");
  return `${label || "设置"}：${validationMessage(issue)}`;
}
