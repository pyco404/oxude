import { and, asc, desc, eq, gt, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { beatsFor, headlineBeat, type Beat } from "../transcript.js";
import type { Action, MatchLog, RoundOutcome, Seat } from "../types.js";
import type { Db } from "./client.js";
import { dayStart } from "../season.js";
import { agents, matches } from "./schema.js";

/**
 * What the public can see of recent play: who met whom, who won what, and the
 * one beat worth reading. Everything here is already public on match pages;
 * nothing about an agent's brief or table is.
 */
export type FeedItem = {
  id: string;
  seq: number;
  createdAt: Date;
  /** presetName is null for an agent rented from a brief. */
  a: { id: string; name: string; presetName: string | null; mark: string | null };
  b: { id: string; name: string; presetName: string | null; mark: string | null };
  winner: Seat | null;
  netA: number;
  netB: number;
  stake: number;
  rounds: number;
  headline: string | null;
  /** The kind of beat the headline describes, e.g. "bluff-worked". */
  beat: string | null;
  /** Which seat the headline is about. */
  beatSeat: Seat | null;
  /** House agents playing each other: nothing was staked or settled. */
  exhibition: boolean;
  /**
   * Both sides player-rented, so it counts toward the ladder. A staked match
   * that is not ranked was played against a house agent: it settled for money
   * like any other, and earned no ranking.
   */
  ranked: boolean;
};

const agentA = alias(agents, "agent_a_row");
const agentB = alias(agents, "agent_b_row");

/**
 * Newest first. `before` pages by seq; `agentId` limits to one agent's matches;
 * `stakedOnly` drops exhibitions.
 *
 * The house plays an exhibition every thirty seconds, so a hundred unfiltered
 * rows reach back less than an hour and a real match is buried within minutes.
 * Staked-only is what the feed is usually asked for.
 */
export async function recentMatches(
  db: Db,
  options: { limit?: number; before?: number; agentId?: string; stakedOnly?: boolean } = {},
): Promise<FeedItem[]> {
  const conditions: SQL[] = [];
  if (options.before !== undefined) conditions.push(lt(matches.seq, options.before));
  if (options.agentId !== undefined) conditions.push(or(eq(matches.agentA, options.agentId), eq(matches.agentB, options.agentId))!);
  if (options.stakedOnly) conditions.push(eq(matches.exhibition, false));

  const rows = await feedRows(db, conditions, "newest", Math.min(Math.max(options.limit ?? 20, 1), 100));
  return rows.map(({ item }) => item);
}

/** One round as the live feed plays it out: both hands, the actions, what it settled. */
export type PlayRound = {
  roundNumber: number;
  /** Who acted first; null when both chose at once. */
  leader: Seat | null;
  edges: { A: number; B: number };
  /** Decisions in the order they were made. */
  sequence: { seat: Seat; action: Action }[];
  outcome: RoundOutcome;
  /** What changed hands: the ante on a fold, the bet on a flip, nothing if both folded. */
  bet: number;
  /** The chance A had of winning the flip; null when there was no flip. */
  chanceA: number | null;
  winner: Seat | null;
  /** Running totals after the round. */
  nets: { A: number; B: number };
  roundsWon: { A: number; B: number };
  /** The moments the transcript calls out in this round, e.g. "bluff-worked". */
  beats: Beat["kind"][];
};

/** A new match for the live stream: the feed row, plus the rounds to play it out with. */
export type LiveMatch = FeedItem & { play: PlayRound[] };

/** The rounds of a match, with nothing a transcript would not also show. */
export function playRounds(log: MatchLog): PlayRound[] {
  return log.rounds.map((r, i) => ({
    roundNumber: r.roundNumber,
    leader: r.leader,
    edges: r.edges,
    sequence: r.sequence,
    outcome: r.outcome,
    bet: r.bet,
    chanceA: r.flip?.probabilityAWins ?? null,
    winner: r.winner,
    nets: r.nets,
    roundsWon: r.roundsWon,
    beats: beatsFor(log, i).map((b) => b.kind),
  }));
}

/**
 * Every match recorded after `seq`, oldest first, exhibitions included: what
 * the live stream tails. Bounded, so a long gap is caught up over several reads.
 */
export async function matchesAfter(db: Db, seq: number, limit = 50): Promise<LiveMatch[]> {
  const rows = await feedRows(db, [gt(matches.seq, seq)], "oldest", limit);
  return rows.map(({ item, log }) => ({ ...item, play: playRounds(log) }));
}

/** The newest match seq, or 0 before the first: where a live tail starts. */
export async function latestSeq(db: Db): Promise<number> {
  const [row] = await db.select({ seq: matches.seq }).from(matches).orderBy(desc(matches.seq)).limit(1);
  return row?.seq ?? 0;
}

async function feedRows(
  db: Db,
  conditions: SQL[],
  order: "newest" | "oldest",
  limit: number,
): Promise<{ item: FeedItem; log: MatchLog }[]> {
  const rows = await db
    .select({
      id: matches.id,
      seq: matches.seq,
      createdAt: matches.createdAt,
      aId: matches.agentA,
      bId: matches.agentB,
      aName: agentA.name,
      bName: agentB.name,
      aPreset: agentA.presetName,
      bPreset: agentB.presetName,
      aMark: agentA.mark,
      bMark: agentB.mark,
      winner: matches.winner,
      netA: matches.netA,
      netB: matches.netB,
      stake: matches.stake,
      log: matches.log,
      exhibition: matches.exhibition,
      ranked: matches.ranked,
    })
    .from(matches)
    .innerJoin(agentA, eq(agentA.id, matches.agentA))
    .innerJoin(agentB, eq(agentB.id, matches.agentB))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(order === "newest" ? desc(matches.seq) : asc(matches.seq))
    .limit(limit);

  return rows.map((r) => {
    const names = { A: r.aName, B: r.bName };
    const beat = headlineBeat(r.log, names);
    const item: FeedItem = {
      id: r.id,
      seq: r.seq,
      createdAt: r.createdAt,
      a: { id: r.aId, name: r.aName, presetName: r.aPreset, mark: r.aMark },
      b: { id: r.bId, name: r.bName, presetName: r.bPreset, mark: r.bMark },
      winner: r.winner,
      netA: r.netA,
      netB: r.netB,
      stake: r.stake,
      rounds: r.log.rounds.length,
      headline: beat?.text ?? null,
      beat: beat?.kind ?? null,
      beatSeat: beat?.seat ?? null,
      exhibition: r.exhibition,
      ranked: r.ranked,
    };
    return { item, log: r.log };
  });
}

/**
 * The most recent match, from the last `scan`, whose headline is a bluff that
 * worked and whose bluffer also came out ahead on the match: the clearest
 * picture of the game for someone arriving cold.
 */
export async function latestBluff(db: Db, scan = 100): Promise<FeedItem | null> {
  const bluffs = (await recentMatches(db, { limit: scan })).filter((m) => m.beat === "bluff-worked");
  const paid = bluffs.find((m) => (m.beatSeat === "B" ? m.netB : m.netA) > 0);
  return paid ?? bluffs[0] ?? null;
}

/**
 * Wins, losses and level matches over an agent's staked history, by money: a
 * win is a match it finished ahead. Round wins can disagree (two small rounds
 * against one big one), and everything else in the product counts money.
 */
export async function agentRecord(db: Db, agentId: string): Promise<{ wins: number; losses: number; level: number }> {
  const [row] = await db
    .select({
      wins: sql<number>`count(*) filter (where (${matches.agentA} = ${agentId} and ${matches.netA} > 0) or (${matches.agentB} = ${agentId} and ${matches.netB} > 0))::int`,
      losses: sql<number>`count(*) filter (where (${matches.agentA} = ${agentId} and ${matches.netA} < 0) or (${matches.agentB} = ${agentId} and ${matches.netB} < 0))::int`,
      level: sql<number>`count(*) filter (where ${matches.netA} = 0)::int`,
    })
    .from(matches)
    // Staked matches only: an exhibition wins or loses nothing.
    .where(and(or(eq(matches.agentA, agentId), eq(matches.agentB, agentId)), eq(matches.exhibition, false)));
  return { wins: Number(row?.wins ?? 0), losses: Number(row?.losses ?? 0), level: Number(row?.level ?? 0) };
}

/**
 * Platform-wide match activity, staked matches only (exhibitions stake nothing).
 * Stakes are zero-sum between agents, so there is no platform take to report.
 */
export async function matchActivity(db: Db): Promise<{
  stakedMatches: number;
  /** Chips put at risk, both sides counted. */
  totalStaked: number;
  /** The most chips that changed hands in one match. */
  largestPot: number;
  exhibitions: number;
}> {
  const [row] = await db
    .select({
      staked: sql<number>`count(*) filter (where not ${matches.exhibition})::int`,
      totalStaked: sql<number>`coalesce(sum(${matches.stake} * 2) filter (where not ${matches.exhibition}), 0)::bigint`,
      largest: sql<number>`coalesce(max(abs(${matches.netA})) filter (where not ${matches.exhibition}), 0)::int`,
      exhibitions: sql<number>`count(*) filter (where ${matches.exhibition})::int`,
    })
    .from(matches);
  return {
    stakedMatches: Number(row?.staked ?? 0),
    totalStaked: Number(row?.totalStaked ?? 0),
    largestPot: Number(row?.largest ?? 0),
    exhibitions: Number(row?.exhibitions ?? 0),
  };
}

/**
 * The two counters the live feed ticks up: staked matches since 00:00 UTC, and
 * chips staked across every staked match ever, both sides counted as
 * matchActivity counts them. Exhibitions stake nothing and count toward neither.
 */
export async function liveCounters(db: Db, now: Date): Promise<{ matchesToday: number; totalStaked: number }> {
  const [row] = await db
    .select({
      today: sql<number>`count(*) filter (where ${gte(matches.createdAt, dayStart(now))})::int`,
      totalStaked: sql<number>`coalesce(sum(${matches.stake} * 2), 0)::bigint`,
    })
    .from(matches)
    .where(eq(matches.exhibition, false));
  return { matchesToday: Number(row?.today ?? 0), totalStaked: Number(row?.totalStaked ?? 0) };
}
