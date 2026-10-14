import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "./types";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Plugin projections are never part of task identity or failure classification.
export function fingerprint(items: readonly AgentTimelineItem[]): string {
  return digest([userIdentity(items), finalText(items), currentError(items)]);
}
export function latestUser(items: readonly AgentTimelineItem[]) {
  return items.findLast((i) => i.type === "user_message");
}
export function userIdentity(
  items: readonly AgentTimelineItem[],
): string | null {
  const item = latestUser(items);
  return item
    ? (item.clientMessageId ?? item.messageId ?? digest(item.text))
    : null;
}
export function finalText(items: readonly AgentTimelineItem[]): string {
  const start = items.findLastIndex((i) => i.type === "user_message");
  const item = items
    .slice(start + 1)
    .findLast((i) => i.type === "assistant_message");
  return item?.type === "assistant_message" ? item.text : "";
}
export function currentError(items: readonly AgentTimelineItem[]): string {
  const start = items.findLastIndex((i) => i.type === "user_message");
  const item = items.slice(start + 1).findLast((i) => i.type === "error");
  return item?.type === "error" ? item.message : "";
}
