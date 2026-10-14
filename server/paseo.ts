import type { PaseoApi, AgentTimelineItem } from "./types";
import type { RecoveryCard } from "../shared/contracts";
import {
  reviewWithPaseo,
  archiveReviewer,
  type ReviewRequest,
  type ReviewDecision,
} from "./reviewer";

export interface AgentView {
  available: boolean;
  idle: boolean;
  sessionId: string | null;
  lastUserMessageAt: string | null;
  items: readonly AgentTimelineItem[];
}
export interface PaseoPort {
  inspect(agentId: string): Promise<AgentView>;
  send(agentId: string, text: string, messageId: string): Promise<void>;
  publish(card: RecoveryCard): Promise<void>;
  review?(request: ReviewRequest, signal: AbortSignal): Promise<ReviewDecision>;
  archiveReviewer?(id: string): Promise<void>;
}
export function paseoPort(paseo: PaseoApi): PaseoPort {
  return {
    review: (request, signal) => reviewWithPaseo(paseo, request, signal),
    archiveReviewer: (id) => archiveReviewer(paseo, id),
    async inspect(agentId) {
      const agent = paseo.agents.ref(agentId);
      // Lifecycle callbacks use the host's projected timeline, including merged assistant rows.
      let page = await agent.timeline.refetch({
        direction: "tail",
        limit: 100,
        projection: "projected",
      });
      if (page.error || page.gap || page.staleCursor)
        throw new Error("无法核对会话历史");
      let items = page.entries.map((e) => e.item);
      // Never guess a missing user boundary. Fetch only the current user turn, with a hard bound.
      for (
        let i = 0;
        i < 9 &&
        !items.some((item) => item.type === "user_message") &&
        page.hasOlder &&
        page.startCursor;
        i++
      ) {
        const epoch = page.epoch;
        page = await agent.timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit: 100,
          projection: "projected",
        });
        if (
          page.error ||
          page.gap ||
          page.staleCursor ||
          page.reset ||
          page.epoch !== epoch
        )
          throw new Error("会话历史已发生变化");
        items = [...page.entries.map((e) => e.item), ...items];
      }
      const snapshot = (await agent.refresh())?.agent;
      return {
        available: Boolean(
          snapshot &&
            !snapshot.archivedAt &&
            !snapshot.providerUnavailable &&
            snapshot.status !== "closed" &&
            items.some((i) => i.type === "user_message"),
        ),
        idle: Boolean(
          snapshot &&
            ["idle", "error"].includes(snapshot.status) &&
            !snapshot.activeTurn &&
            snapshot.pendingPermissions.length === 0,
        ),
        sessionId: snapshot?.persistence?.sessionId ?? null,
        lastUserMessageAt: snapshot?.lastUserMessageAt ?? null,
        items,
      };
    },
    async send(agentId, text, messageId) {
      // The public host API has no atomic if-idle predicate. Steer avoids the SDK's
      // default interruption in the remaining check/send race; see README limits.
      await paseo.agents
        .ref(agentId)
        .send(text, { messageId, activeTurnBehavior: "steer" });
    },
    async publish(card) {
      await paseo.agents.ref(card.agentId).timeline.append({
        type: "plugin",
        id: `recovery-${card.id}`,
        kind: "notifier-recovery",
        version: 1,
        data: card,
      });
    },
  };
}
