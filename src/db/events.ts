import type { Db } from "./client.js";
import { agentEvents, type AgentEventKind, type AgentEventSource } from "./schema.js";

/**
 * Records a change to an agent's settings. Written beside the change itself,
 * never read to decide anything: it is what lets a gap in an agent's play be
 * explained afterwards.
 */
export async function recordEvent(
  db: Db,
  agentId: string,
  kind: AgentEventKind,
  source: AgentEventSource,
  detail: string | null = null,
): Promise<void> {
  await db.insert(agentEvents).values({ agentId, kind, source, detail });
}
