/** Thin client for the HTTP layer. */
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type Preset = { name: string; policyTable: Record<string, Record<string, string>> };
export type PreviewBreakdown = { weight: number; expectedNet: number };
export type Preview = {
  trueRating: number;
  basis: string;
  roster: number;
  breakdown: PreviewBreakdown[];
};
export type AgentView = {
  agentId?: string;
  id?: string;
  name: string;
  presetName: string | null;
  brief?: string | null;
  matchesPlayed?: number;
  cumulativeNet?: number;
  recentForm?: number;
  trueRating?: number | null;
  trueRatingBasis?: string;
};
export type LadderRow = {
  agentId: string;
  name: string;
  presetName: string | null;
  matchesPlayed: number;
  cumulativeNet: number;
  netPerMatch?: number;
  recentForm: number;
};
export type PlayResult = {
  matchId: string;
  opponent: { id: string; name: string };
  matchmaking: { path: string; candidates: number; ratingGap: number | null };
  result: { winner: "A" | "B" | null; net: number; opponentNet: number; rounds: number };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { ownerId?: string } = {}): Promise<T> {
  const { ownerId, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(ownerId ? { "x-owner-id": ownerId } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof body["error"] === "string" ? body["error"] : `request failed (${res.status})`,
      Number(res.headers.get("retry-after")) || undefined,
    );
  }
  return body as T;
}

export const api = {
  presets: () => request<{ presets: Preset[]; free: boolean }>("/presets"),
  previewTable: (ownerId: string, policyTable: unknown) =>
    request<{ preview: Preview }>("/preview", { method: "POST", ownerId, body: JSON.stringify({ policyTable }) }),
  previewBrief: (ownerId: string, brief: string) =>
    request<{ preview: Preview }>("/preview", { method: "POST", ownerId, body: JSON.stringify({ brief }) }),
  rent: (ownerId: string, input: { name: string; presetName?: string; brief?: string }) =>
    request<{ agent: AgentView }>("/agents", { method: "POST", ownerId, body: JSON.stringify(input) }),
  agent: (ownerId: string, id: string) => request<{ agent: AgentView; view: string }>(`/agents/${id}`, { ownerId }),
  play: (ownerId: string, id: string) => request<PlayResult>(`/agents/${id}/play`, { method: "POST", ownerId }),
  match: (id: string) => request<{ transcript: string }>(`/matches/${id}`),
  ladder: (sort: "winnings" | "per-match") => request<{ rows: LadderRow[] }>(`/ladder?sort=${sort}&limit=25`),
};
