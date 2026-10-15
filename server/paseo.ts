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
  status: string;
  pendingPermissions: number;
  error?: string | null;
}
export interface PaseoPort {
  inspect(agentId: string): Promise<AgentView>;
  history?(agentId: string): Promise<readonly AgentTimelineItem[]>;
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
      // Execution state is authoritative. History length/content is not a
      // precondition for recovering a failed turn.
      const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (!snapshot) throw new Error("暂时无法读取会话状态");
      return {
        available:
          !snapshot.archivedAt &&
          !snapshot.providerUnavailable &&
          snapshot.status !== "closed",
        idle:
          ["idle", "error"].includes(snapshot.status) &&
          !snapshot.activeTurn &&
          snapshot.pendingPermissions.length === 0,
        status: snapshot.status,
        pendingPermissions: snapshot.pendingPermissions.length,
        error: snapshot.lastError ?? null,
      };
    },
    async history(agentId) {
      // Only AI review needs a bounded excerpt. No user-boundary pagination.
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: 100,
        projection: "projected",
      });
      if (page.error || page.gap || page.staleCursor)
        throw new Error("暂时无法读取复核所需的会话摘录");
      return page.entries.map((e) => e.item);
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
