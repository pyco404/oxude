/** Thin client for the HTTP layer. */
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type Preset = { name: string; description: string; policyTable: Record<string, Record<string, string>> };
export type RosterAgent = {
  agentId: string;
  name: string;
  presetName: string | null;
  /** The agent's own emoji. */
  mark?: string | null;
  band: BandName;
  matchesPlayed: number;
  cumulativeNet: number;
  recentForm: number;
  balance: number;
};
export type BandName = "A" | "B" | "C";

/**
 * Mirrors STAKE_BANDS on the server. A band is a money scale: every amount in a
 * match is multiplied by the same factor, so the game is identical in each and
 * only what it is worth changes.
 */
export const BANDS = [
  { name: "A", label: "Low", ante: 2, baseBet: 5, raisedBet: 10, worstMatch: 20 },
  { name: "B", label: "Standard", ante: 4, baseBet: 10, raisedBet: 20, worstMatch: 40 },
  { name: "C", label: "High", ante: 6, baseBet: 15, raisedBet: 30, worstMatch: 60 },
] as const;

export const DEFAULT_BAND: BandName = "B";
export const SEED_BALANCE = 900;

export const bandByName = (name: BandName) => BANDS.find((b) => b.name === name)!;

/** The bands a balance can still cover, cheapest first. */
export const affordableBands = (balance: number): BandName[] =>
  BANDS.filter((b) => balance >= b.worstMatch).map((b) => b.name);

export type BandSurvival = { low: number; high: number };
/** The measured table, served by /roster so the client keeps no copy of it. */
export type BandSurvivalRow = {
  overall: number;
  low: number;
  high: number;
  medianMatches: number | null;
  medianHours: number | null;
  byPreset: Record<string, number>;
};

/**
 * What to tell someone renting this preset in this band. A preset gets its own
 * measured figure; a brief has no preset yet, so it gets the range across them.
 */
export const survivalFor = (row: BandSurvivalRow | undefined, preset: string | null): BandSurvival | undefined => {
  if (!row) return undefined;
  if (preset && typeof row.byPreset[preset] === "number") {
    return { low: row.byPreset[preset], high: row.byPreset[preset] };
  }
  return { low: row.low, high: row.high };
};
/** How the survival figures are phrased, one preset or a range across them. */
export const survivalText = (s: BandSurvival | undefined) =>
  s === undefined ? "" : s.low === s.high ? `${s.low.toFixed(0)}%` : `${s.low.toFixed(0)}\u2013${s.high.toFixed(0)}%`;

export type PreviewBreakdown = { weight: number; expectedNet: number; pricedNet?: number };
export type Preview = {
  trueRating: number;
  basis: string;
  band?: BandName;
  priced?: { band: BandName; perMatch: number; worstMatch: number };
  roster: number;
  breakdown: PreviewBreakdown[];
};
export type AgentView = {
  agentId?: string;
  id?: string;
  name: string;
  presetName: string | null;
  /** The agent's own emoji. */
  mark?: string | null;
  brief?: string | null;
  matchesPlayed?: number;
  cumulativeNet?: number;
  /** Player-versus-player only: what the ladder counts. */
  rankedMatches?: number;
  rankedNet?: number;
  recentForm?: number;
  balance?: number;
  band?: BandName;
  /** The most this band's matches can move. */
  worstMatch?: number;
  /** False when the balance no longer covers this band. */
  canPlay?: boolean;
  affordable?: BandName[];
  /** The best band still open when the current one is not. */
  fallback?: BandName | null;
  bands?: {
    name: BandName;
    stakes: { ante: number; baseBet: number; raisedBet: number };
    worstMatch: number;
    affordable: boolean;
    survival: BandSurvival;
    medianHours: number | null;
  }[];
  survivalBasis?: { hours: number; paceMinutes: number; seedBalance: number };
  retired?: boolean;
  trueRating?: number | null;
  trueRatingBasis?: string;
};
export type LadderRow = {
  agentId: string;
  name: string;
  presetName: string | null;
  /** The agent's own emoji. */
  mark?: string | null;
  /** Player-versus-player only: what the ladder ranks on. */
  matchesPlayed: number;
  cumulativeNet: number;
  netPerMatch?: number;
  rankedStaked?: number;
  /** Every staked match, house opponents included. Shown, never ranked. */
  totalMatches?: number;
  totalNet?: number;
  recentForm: number;
  balance: number;
  retired: boolean;
};
export type PlayResult = {
  matchId: string;
  opponent: { id: string; name: string; presetName?: string | null; mark?: string | null };
  matchmaking: { path: string; candidates: number; ratingGap: number | null };
  stake: number;
  result: { winner: "A" | "B" | null; net: number; opponentNet: number; rounds: number; uncappedNet: number };
  balance: number;
  retired: boolean;
  /** False when the opponent was a house agent: settled for money, not ranked. */
  ranked?: boolean;
};

/** Mirrors src/db/autoplay.ts. `held` clears itself; `paused` needs the owner. */
export type AutoplayState = "off" | "on" | "waiting" | "held" | "paused";
export type AutoplayStatus = {
  enabled: boolean;
  floor: number | null;
  state: AutoplayState;
  message: string | null;
  action: string | null;
  stop: { reason: "floor" | "insolvent" | "retired" | "withdrawal" | "season"; hold: boolean } | null;
  lastMatchAt: string | null;
  nextMatchAt: string | null;
  waitingSince: string | null;
  today: { matches: number; net: number };
  intervalMs: number;
};
export type SinceYouLeft = {
  since: string;
  matches: number;
  net: number;
  bestHand: { matchId: string; net: number; headline: string | null; createdAt: string } | null;
};

/** One match as the public feed shows it. Mirrors the API's FeedItem. */
export type FeedItem = {
  id: string;
  seq: number;
  createdAt: string;
  a: { id: string; name: string; presetName: string | null; mark: string | null };
  b: { id: string; name: string; presetName: string | null; mark: string | null };
  winner: "A" | "B" | null;
  netA: number;
  netB: number;
  stake: number;
  rounds: number;
  headline: string | null;
  /** Both sides player-rented. Staked but unranked means a house opponent. */
  ranked?: boolean;
  beat: string | null;
  beatSeat: "A" | "B" | null;
  /** House agents playing each other: nothing was staked or settled. */
  exhibition: boolean;
};
export type Feed = { matches: FeedItem[]; bluff: FeedItem | null };
export type AgentRecord = { wins: number; losses: number; level: number };

/** Which matches a ladder counts: today in UTC, the season in play, or everything. */
export type LadderPeriod = "day" | "season" | "all";

/** The season in play. Mirrors GET /season. */
export type SeasonInfo = { key: string; number: number; startsAt: string; endsAt: string };

/** Where an agent's rental stands. Mirrors src/db/seasons.ts. */
export type RentalStatus = {
  state: "active" | "renewed" | "expired" | "lapsed" | "retired" | "house";
  season: { key: string; number: number; endsAt: string };
  endsAt: string | null;
  graceEndsAt: string | null;
  canRenew: boolean;
  remind: boolean;
};

/** What an owner can take from an agent's vault now, and what's locked while matches settle. */
export type Withdrawable = {
  balance: number;
  withdrawable: number;
  locked: number;
  maxPartial: number;
  minStake: number;
  reason: string | null;
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

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      // Only with a body: on a plain GET it would force a CORS preflight, doubling every request.
      ...(rest.body !== undefined ? { "content-type": "application/json" } : {}),
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
  /** Who you are signed in as, and every agent that wallet owns - on any device. */
  me: (token: string | null) => request<{ ownerId: string; agents: AgentView[] }>("/auth/me", { token }),
  previewTable: (token: string | null, policyTable: unknown, band: BandName = DEFAULT_BAND) =>
    request<{ preview: Preview }>("/preview", { method: "POST", token, body: JSON.stringify({ policyTable, band }) }),
  previewBrief: (token: string | null, brief: string, band: BandName = DEFAULT_BAND) =>
    request<{ preview: Preview; policyTable: unknown; elicitation: { free: boolean } | null }>("/preview", {
      method: "POST",
      token,
      body: JSON.stringify({ brief, band }),
    }),
  rent: (token: string | null, input: { name: string; presetName?: string; brief?: string; band?: BandName }) =>
    request<{ agent: AgentView; elicitation: { free: boolean } | null }>("/agents", {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
  setBand: (token: string | null, id: string, band: BandName) =>
    request<{ band: BandName }>(`/agents/${id}/band`, { method: "POST", token, body: JSON.stringify({ band }) }),
  agent: (token: string | null, id: string) =>
    request<{ agent: AgentView; view: string; autoplay?: AutoplayStatus; sinceYouLeft?: SinceYouLeft | null; rental?: RentalStatus }>(
      `/agents/${id}`,
      { token },
    ),
  setAutoplay: (token: string | null, id: string, input: { enabled: boolean; floor?: number | null }) =>
    request<{ autoplay: AutoplayStatus }>(`/agents/${id}/autoplay`, { method: "POST", token, body: JSON.stringify(input) }),
  renew: (token: string | null, id: string) => request<{ rental: RentalStatus }>(`/agents/${id}/renew`, { method: "POST", token }),
  markSeen: (token: string | null, id: string) => request<{ ok: true }>(`/agents/${id}/seen`, { method: "POST", token }),
  play: (token: string | null, id: string) => request<PlayResult>(`/agents/${id}/play`, { method: "POST", token }),
  match: (id: string) => request<{ transcript: string }>(`/matches/${id}`),
  roster: (band?: string) =>
    request<{
      agents: RosterAgent[];
      counts?: Record<string, number>;
      bands?: { name: BandName; worstMatch: number; survival: BandSurvivalRow }[];
      survivalBasis?: { hours: number; paceMinutes: number; seedBalance: number };
    }>(band ? `/roster?band=${band}` : "/roster"),
  withdrawable: (token: string | null, id: string) => request<{ withdrawable: Withdrawable }>(`/agents/${id}/withdrawable`, { token }),
  prepareWithdrawal: (token: string | null, id: string, amount: number | "all") =>
    request<{ withdrawal: { withdrawalId: string; amount: number; remaining: number; retire: boolean; transaction: string } }>(
      `/agents/${id}/withdrawals`,
      { method: "POST", token, body: JSON.stringify({ amount }) },
    ),
  submitWithdrawal: (token: string | null, withdrawalId: string, transaction: string) =>
    request<{ withdrawal: { status: "submitted" | "confirmed" | "expired"; signature: string | null } }>(
      `/withdrawals/${withdrawalId}/submit`,
      { method: "POST", token, body: JSON.stringify({ transaction }) },
    ),
  withdrawal: (token: string | null, withdrawalId: string) =>
    request<{ withdrawal: { status: "prepared" | "submitted" | "confirmed" | "expired"; signature: string | null; error: string | null } }>(
      `/withdrawals/${withdrawalId}`,
      { token },
    ),
  feed: (limit = 12, before?: number) =>
    request<Feed>(`/matches?limit=${limit}${before === undefined ? "" : `&before=${before}`}`),
  season: () => request<{ season: SeasonInfo; graceHours: number; reminderHours: number }>("/season"),
  ladder: (sort: "winnings" | "per-match", limit = 25, period: LadderPeriod = "season") =>
    request<{ rows: LadderRow[]; season?: SeasonInfo & { current: boolean } }>(`/ladder?sort=${sort}&limit=${limit}&period=${period}`),
};
