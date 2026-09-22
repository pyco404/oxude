import { API, type AgentRecord, type Character, type FeedItem, type Traits } from "@/lib/api";

// Kept out of page.tsx: Next only allows its own exports from a page file.
export type PublicAgent = {
  agentId: string;
  name: string;
  /** Null for an agent rented from a brief. The brief itself is never public. */
  presetName: string | null;
  /** The agent's own emoji. */
  mark: string | null;
  createdAt: string;
  retired: boolean;
  house: boolean;
  matchesPlayed: number | null;
  cumulativeNet: number | null;
  recentForm: number | null;
  band: "A" | "B" | "C";
  /** The most a match in this band can move. */
  worstMatch?: number;
  balance: number;
  character: Character | null;
  traits: Traits;
};

export type AgentPayload = { agent: PublicAgent; record: AgentRecord; matches: FeedItem[] };

export type AgentLookup = { status: "ok"; data: AgentPayload } | { status: "missing" } | { status: "unavailable" };

export async function lookupAgent(id: string): Promise<AgentLookup> {
  try {
    // No session is sent, so this is always the public view, even for the owner.
    const [agentRes, matchesRes] = await Promise.all([
      fetch(`${API}/agents/${id}`, { cache: "no-store" }),
      fetch(`${API}/agents/${id}/matches?limit=20`, { cache: "no-store" }),
    ]);
    if (agentRes.status === 404 || agentRes.status === 400) return { status: "missing" };
    if (!agentRes.ok || !matchesRes.ok) return { status: "unavailable" };
    const { agent } = (await agentRes.json()) as { agent: PublicAgent };
    const { record, matches } = (await matchesRes.json()) as { record: AgentRecord; matches: FeedItem[] };
    return { status: "ok", data: { agent, record, matches } };
  } catch {
    return { status: "unavailable" };
  }
}
