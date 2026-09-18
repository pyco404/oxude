/** Thin client for the HTTP layer. */
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type Preset = { name: string; description: string; policyTable: Record<string, Record<string, string>> };
export type RosterAgent = {
  agentId: string;
  name: string;
  presetName: string | null;
  maxStake: number;
  matchesPlayed: number;
  cumulativeNet: number;
  recentForm: number;
  balance: number;
};
export const BANDS = [
  { name: "10-20", min: 10, max: 20 },
  { name: "20-40", min: 20, max: 40 },
  { name: "40-60", min: 40, max: 60 },
] as const;
/** Mirrors the server: upper bound wins at a boundary. */
export const bandOf = (ceiling: number) => (ceiling <= 20 ? "10-20" : ceiling <= 40 ? "20-40" : "40-60");
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
  balance?: number;
  maxStake?: number;
  retired?: boolean;
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
  balance: number;
  retired: boolean;
};
export type PlayResult = {
  matchId: string;
  opponent: { id: string; name: string };
  matchmaking: { path: string; candidates: number; ratingGap: number | null };
  stake: number;
  result: { winner: "A" | "B" | null; net: number; opponentNet: number; rounds: number; uncappedNet: number };
  balance: number;
  retired: boolean;
};

/** One match as the public feed shows it. Mirrors the API's FeedItem. */
export type FeedItem = {
  id: string;
  seq: number;
  createdAt: string;
  a: { id: string; name: string };
  b: { id: string; name: string };
  winner: "A" | "B" | null;
  netA: number;
  netB: number;
  stake: number;
  rounds: number;
  headline: string | null;
  beat: string | null;
  beatSeat: "A" | "B" | null;
  /** House agents playing each other: nothing was staked or settled. */
  exhibition: boolean;
};
export type Feed = { matches: FeedItem[]; bluff: FeedItem | null };
export type AgentRecord = { wins: number; losses: number; level: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  previewTable: (token: string | null, policyTable: unknown) =>
    request<{ preview: Preview }>("/preview", { method: "POST", token, body: JSON.stringify({ policyTable }) }),
  previewBrief: (token: string | null, brief: string) =>
    request<{ preview: Preview; elicitation: { free: boolean } | null }>("/preview", {
      method: "POST",
      token,
      body: JSON.stringify({ brief }),
    }),
  rent: (token: string | null, input: { name: string; presetName?: string; brief?: string; maxStake?: number }) =>
    request<{ agent: AgentView; elicitation: { free: boolean } | null }>("/agents", {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
  setCeiling: (token: string | null, id: string, maxStake: number) =>
    request<{ maxStake: number }>(`/agents/${id}/ceiling`, { method: "POST", token, body: JSON.stringify({ maxStake }) }),
  agent: (token: string | null, id: string) => request<{ agent: AgentView; view: string }>(`/agents/${id}`, { token }),
  play: (token: string | null, id: string) => request<PlayResult>(`/agents/${id}/play`, { method: "POST", token }),
  match: (id: string) => request<{ transcript: string }>(`/matches/${id}`),
  roster: (band?: string) =>
    request<{ agents: RosterAgent[]; counts?: Record<string, number> }>(band ? `/roster?band=${band}` : "/roster"),
  feed: (limit = 12, before?: number) =>
    request<Feed>(`/matches?limit=${limit}${before === undefined ? "" : `&before=${before}`}`),
  ladder: (sort: "winnings" | "per-match", limit = 25) =>
    request<{ rows: LadderRow[] }>(`/ladder?sort=${sort}&limit=${limit}`),
};
