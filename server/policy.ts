import type { Config } from "../shared/config";
import type { Failure } from "./classifier";

export function nextRetry(input: {
  failure: Failure;
  attempts: number;
  startedAt: number;
  now: number;
  config: Config;
  random: number;
}): { dueAt: number } | { stopped: string } {
  const { config, failure, attempts, startedAt, now } = input;
  const r = config.recovery;
  if (!config.enabled || !r.enabled) return { stopped: "自动恢复已关闭" };
  const allowed =
    failure.kind === "network"
      ? r.network
      : failure.kind === "overloaded"
        ? r.overloaded
        : failure.kind === "rate_limited"
          ? r.rateLimited
          : false;
  if (!allowed) return { stopped: "此类中断需要人工处理" };
  if (attempts >= r.maxAttempts) return { stopped: "已达到重试次数上限" };
  const ceiling = Math.min(
    r.maxDelaySeconds * 1000,
    r.baseDelaySeconds * 1000 * 2 ** attempts,
  );
  const delay = Math.max(
    ceiling * (0.75 + Math.min(1, Math.max(0, input.random)) * 0.25),
    failure.retryAfterMs ?? 0,
  );
  const deadline = startedAt + r.maxElapsedMinutes * 60_000;
  if (now + delay > deadline) return { stopped: "已达到自动恢复时间上限" };
  return { dueAt: Math.ceil(now + delay) };
}
