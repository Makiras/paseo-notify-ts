import type { PaseoApi } from "./types";

export type PreviewReader = (
  agentId: string,
  turnId: string,
  signal: AbortSignal,
) => Promise<string | null>;

// Projected entries merge streamed assistant chunks within one turn. Never
// substitute another turn (or an entry without turnId) when history is missing.
export async function readTurnPreview(
  paseo: PaseoApi,
  agentId: string,
  turnId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!turnId || signal.aborted) return null;
  const timeline = paseo.agents.ref(agentId).timeline;
  let cursor: { epoch: string; seq: number } | undefined;
  let epoch: string | undefined;
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    if (signal.aborted) return null;
    const page = await timeline.refetch({
      direction: cursor ? "before" : "tail",
      ...(cursor ? { cursor } : {}),
      limit: 100,
      projection: "projected",
    });
    if (
      signal.aborted ||
      page.agentId !== agentId ||
      page.error ||
      page.gap ||
      page.staleCursor ||
      page.reset
    )
      return null;
    if (epoch !== undefined && page.epoch !== epoch) return null;
    epoch = page.epoch;
    const reply = page.entries.findLast(
      (entry) =>
        entry.turnId === turnId && entry.item.type === "assistant_message",
    );
    if (reply?.item.type === "assistant_message")
      return Array.from(reply.item.text).slice(0, 2000).join("");
    const next = page.startCursor;
    if (
      !page.hasOlder ||
      !next ||
      next.epoch !== epoch ||
      (cursor && next.seq >= cursor.seq)
    )
      return null;
    cursor = next;
  }
  return null;
}

// An unavailable SDK request must not hold up the completion notification. The
// signal stops additional pages if an in-flight request finishes after timeout.
export async function boundedPreview(
  reader: PreviewReader,
  agentId: string,
  turnId: string,
  parentSignal: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    if (signal.aborted) return "";
    const deadline = new Promise<null>((resolve) => {
      aborted = () => resolve(null);
      signal.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => controller.abort(), 2000);
    });
    return (
      (await Promise.race([deadline, reader(agentId, turnId, signal)])) ?? ""
    );
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
    if (aborted) signal.removeEventListener("abort", aborted);
    controller.abort();
  }
}
