import { API } from "@/lib/api";

// Kept out of page.tsx: Next only allows its own exports from a page file.
export type MatchPayload = {
  match: {
    id: string;
    agentA: { id: string; name: string };
    agentB: { id: string; name: string };
    winner: "A" | "B" | null;
    netA: number;
    netB: number;
    stake: number;
    createdAt: string;
    /** House agents playing each other: nothing was staked or settled. */
    exhibition: boolean;
  };
  summary: {
    names: { A: string; B: string };
    netA: number;
    netB: number;
    winnerName: string | null;
    rounds: number;
    stake: number;
    headline: string | null;
  };
  transcript: string;
  /** What the chain has recorded; null for a level match, which moves nothing. */
  settlement: { status: "pending" | "confirmed" | "failed"; signature: string | null; amount: number } | null;
};

export type MatchLookup =
  | { status: "ok"; data: MatchPayload }
  /** The API answered: there is no such match. */
  | { status: "missing" }
  /** The API could not be reached. Not the same as missing: a shared link must not claim the match is gone. */
  | { status: "unavailable" };

export async function lookupMatch(id: string): Promise<MatchLookup> {
  try {
    const res = await fetch(`${API}/matches/${id}`, { cache: "no-store" });
    if (res.status === 404 || res.status === 400) return { status: "missing" };
    if (!res.ok) return { status: "unavailable" };
    return { status: "ok", data: (await res.json()) as MatchPayload };
  } catch {
    return { status: "unavailable" };
  }
}

export async function getMatch(id: string): Promise<MatchPayload | null> {
  const found = await lookupMatch(id);
  return found.status === "ok" ? found.data : null;
}

