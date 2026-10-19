import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { FailureKind } from "../shared/config";
import { isCyberRejection } from "./opencode/cyber-retry-guard";

export interface Failure {
  kind: FailureKind;
  evidence: "code" | "error" | "refusal";
  retryAfterMs?: number;
}
const codes: Record<string, FailureKind> = {
  econnreset: "network",
  etimedout: "network",
  econnrefused: "network",
  enetunreach: "network",
  eai_again: "network",
  und_err_socket: "network",
  und_err_connect_timeout: "network",
  overloaded_error: "overloaded",
  service_unavailable: "overloaded",
  server_error: "overloaded",
  internal_server_error: "overloaded",
  "500": "overloaded",
  "502": "overloaded",
  "503": "overloaded",
  "504": "overloaded",
  "529": "overloaded",
  rate_limit_exceeded: "rate_limited",
  rate_limit_error: "rate_limited",
  "429": "rate_limited",
  insufficient_quota: "quota_exhausted",
  usage_limit_reached: "quota_exhausted",
  billing_hard_limit_reached: "quota_exhausted",
  context_length_exceeded: "context_exhausted",
  max_context_length_exceeded: "context_exhausted",
  content_filter: "policy_blocked",
  content_policy_violation: "policy_blocked",
  safety_violation: "policy_blocked",
  policy_violation: "policy_blocked",
  cyber_safety: "policy_blocked",
  cyber_policy: "policy_blocked",
};

export function classify(
  outcome: PluginTurnOutcome,
  finalText = "",
  timelineError = "",
): Failure | null {
  if (outcome.kind === "canceled") return null;
  if (outcome.kind === "completed") {
    // Only a clear first-person refusal in the final answer; ordinary discussion of security is not an error.
    const refusal =
      /^(?:I(?:'m| am) sorry[,.:!]?\s*)?I (?:can(?:not|'t)|am unable to) (?:help|assist|comply|provide)[\s\S]{0,400}(?:security policy|safety policy|cyber safety|harmful|malicious)/i;
    const chinese =
      /^(?:抱歉[，,。]?\s*)?(?:我)?(?:无法|不能)(?:协助|帮助|提供|继续)[\s\S]{0,180}(?:安全策略|安全政策|恶意|违反政策)/;
    const flagged =
      /^(?:your|this) request (?:was|has been|is) (?:flagged|blocked)[\s\S]{0,300}(?:cyber|safety|security|policy)/i;
    return refusal.test(finalText.trim()) ||
      chinese.test(finalText.trim()) ||
      flagged.test(finalText.trim())
      ? { kind: "policy_blocked", evidence: "refusal" }
      : null;
  }
  const code = outcome.error.code?.toLowerCase();
  const text = `${outcome.error.message}\n${timelineError}`.slice(0, 16000);
  // Explicit cyber refusal wins even when a gateway wraps it in a network/5xx error.
  if (isCyberRejection({ code, message: text }))
    return {
      kind: "policy_blocked",
      evidence:
        code === "cyber_policy" || code === "cyber_safety" ? "code" : "error",
    };
  // Quota / policy / context details take precedence over generic HTTP rate or server codes.
  const rules: [FailureKind, RegExp][] = [
    [
      "policy_blocked",
      /content[_ -](?:filter|policy)|safety[_ -](?:policy|violation|check)|cyber[_ -]?(?:safety|security)[\s\S]{0,60}(?:blocked|denied|interrupted)|安全(?:策略|政策).{0,20}(?:拦截|阻止)|违反.{0,10}(?:内容|安全)政策/i,
    ],
    [
      "quota_exhausted",
      /insufficient[_ ]quota|quota (?:exceeded|exhausted)|usage limit|billing.{0,30}(?:limit|balance)|credit balance|额度.{0,10}(?:耗尽|不足)|用量.{0,10}(?:上限|限制)/i,
    ],
    [
      "context_exhausted",
      /context[_ ](?:length|window).{0,40}(?:exceed|full|limit)|maximum context|prompt is too long|上下文.{0,10}(?:已满|超限)|输入.{0,10}过长/i,
    ],
    [
      "rate_limited",
      /rate[_ -]?limit|too many requests|(?:HTTP\s*)?\b429\b|请求.{0,10}(?:过于频繁|限流)/i,
    ],
    [
      "overloaded",
      /overload|at capacity|capacity.{0,30}(?:exceed|unavailable)|service unavailable|internal server error|bad gateway|gateway timeout|\b(?:500|502|503|504|529)\b|服务器繁忙|服务.{0,10}(?:过载|繁忙)/i,
    ],
    [
      "network",
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|UND_ERR_|fetch failed|network (?:error|failed|unavailable)|connection (?:reset|closed|lost|timed out)|stream.{0,30}(?:disconnect|closed|interrupt)|socket hang up|request timed out|网络.{0,10}(?:错误|断开|超时)/i,
    ],
  ];
  const hard = rules.slice(0, 3).find(([, pattern]) => pattern.test(text));
  const kind =
    hard?.[0] ??
    (code ? codes[code] : undefined) ??
    rules.find(([, pattern]) => pattern.test(text))?.[0] ??
    "unknown";
  const retry = text.match(
    /(?:retry(?:[ -]after| in)|try again in)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)\b/i,
  );
  const retryAfterMs = retry
    ? Number(retry[1]) *
      (/^m(?!s)/i.test(retry[2]!)
        ? 60_000
        : /^ms|millisecond/i.test(retry[2]!)
          ? 1
          : 1000)
    : undefined;
  return {
    kind,
    evidence: code && codes[code] === kind && !hard ? "code" : "error",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
