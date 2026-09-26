import { and, eq, gte, isNotNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.js";
import { agents, matches, STAKE_BANDS } from "./schema.js";

/**
 * A match's net divided by its band's factor: onto band B's scale, so a band C
 * win of 30 and a band A win of 10 both count as 20. Everything the ladder
 * ranks goes through this; money never does.
 *
 * The factors are inlined rather than bound: a bare parameter in a CASE result
 * has no type Postgres can infer.
 */
export const bandFactor = (band: SQL | typeof matches.band) =>
  sql<number>`(case ${sql.join(
    STAKE_BANDS.map((b) => sql`when ${band} = ${b.name} then ${sql.raw(b.factor.toFixed(4))}`),
    sql` `,
  )} else 1 end)::double precision`;

export type Standing = {
  agentId: string;
  name: string;
  presetName: string | null;
  mark: string | null;
  retired: boolean;
  /** Player-versus-player only, normalised onto band B: what ranks. */
  rankedMatches: number;
  rankedNet: number;
  rankedStaked: number;
  /** The same ranked matches in the chips actually moved, un-normalised: what prizes divide. */
  rankedNetReal: number;
  /** Every staked match, house included, in real money: shown, never ranked. */
  totalMatches: number;
  totalNet: number;
};

export type StandingsWindow = { season: string } | { since: Date };

/**
 * Every player agent that played a staked match in the window, with the same
 * figures the all-time ladder keeps in `ratings` - the same ranked flag, the
 * same normalisation - counted over that window only. Summed over every
 * season, and the matches from before seasons, these are the all-time figures.
 *
 * Sorted by ranked net won. House agents are left out, as on every ladder:
 * they can never rank.
 */
export async function standings(db: Db, window: StandingsWindow): Promise<Standing[]> {
  const inWindow = "season" in window ? eq(matches.season, window.season) : gte(matches.createdAt, window.since);
  // Each match twice, once from each side, so one GROUP BY covers both seats.
  const side = (agent: typeof matches.agentA | typeof matches.agentB, net: typeof matches.netA | typeof matches.netB) =>
    db
      .select({
        agentId: sql<string>`${agent}`.as("agent_id"),
        net: sql<number>`${net}`.as("net"),
        normalised: sql<number>`${net}::double precision / ${bandFactor(matches.band)}`.as("normalised"),
        stake: sql<number>`${matches.stake}`.as("stake"),
        ranked: sql<boolean>`${matches.ranked}`.as("ranked"),
      })
      .from(matches)
      .where(and(inWindow, eq(matches.exhibition, false)));
  const sides = side(matches.agentA, matches.netA).unionAll(side(matches.agentB, matches.netB)).as("sides");

  const rankedNet = sql<number>`coalesce(sum(${sides.normalised}) filter (where ${sides.ranked}), 0)::int`;
  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      mark: agents.mark,
      retired: sql<boolean>`${agents.retiredAt} is not null`,
      rankedMatches: sql<number>`count(*) filter (where ${sides.ranked})::int`,
      rankedNet,
      rankedStaked: sql<number>`coalesce(sum(${sides.stake}) filter (where ${sides.ranked}), 0)::int`,
      rankedNetReal: sql<number>`coalesce(sum(${sides.net}) filter (where ${sides.ranked}), 0)::int`,
      totalMatches: sql<number>`count(*)::int`,
      totalNet: sql<number>`coalesce(sum(${sides.net}), 0)::int`,
    })
    .from(sides)
    .innerJoin(agents, eq(agents.id, sides.agentId))
    .where(isNotNull(agents.ownerId))
    .groupBy(agents.id)
    // Ties go to fewer matches (the same net from less exposure), then to id, so a rank is never arbitrary.
    .orderBy(sql`${rankedNet} desc`, sql`count(*) filter (where ${sides.ranked}) asc`, agents.id);
  return rows.map((r) => ({
    ...r,
    rankedMatches: Number(r.rankedMatches),
    rankedNet: Number(r.rankedNet),
    rankedStaked: Number(r.rankedStaked),
    rankedNetReal: Number(r.rankedNetReal),
    totalMatches: Number(r.totalMatches),
    totalNet: Number(r.totalNet),
  }));
}

/**
 * How many ranked matches an agent must have played before it can be placed
 * for prizes.
 *
 * Net per chip staked is a rate, and a rate from four matches is mostly luck:
 * a match can move at most its own stake, so one clean sweep is a per-chip of
 * 1.0, which would top any table however briefly it was earned. The minimum is
 * the only thing standing between the prize order and whoever got lucky late
 * on a Sunday. It is a parameter everywhere it is used, because the right
 * number depends on how much play a season actually sees, and a season's
 * worth of autoplay is several hundred matches - twenty is a low bar for
 * anyone genuinely playing and an impossible one for a drive-by.
 */
export const MIN_RANKED_MATCHES_FOR_PRIZE = 20;

export type PrizeStanding = Standing & {
  /**
   * Ranked net per chip staked, in [-1, 1]: a match cannot move more than its
   * own stake. Null when nothing was staked.
   */
  perChip: number | null;
  /** 1 is first. Null when the agent is short of the minimum. */
  prizeRank: number | null;
  /** How many more ranked matches this agent needs to be placed. 0 once it is. */
  shortBy: number;
};

/** Ranked net per chip staked: what prizes rank on. Null with nothing staked. */
export function perChip(s: Pick<Standing, "rankedNetReal" | "rankedStaked">): number | null {
  return s.rankedStaked === 0 ? null : s.rankedNetReal / s.rankedStaked;
}

/**
 * The prize order: every agent by ranked net per chip staked, best first.
 *
 * Deliberately not `rankedNet`, which the ladder uses. `rankedNet` is
 * normalised onto band B so that totals from different bands can be compared;
 * dividing by chips staked does the same job, and doing both would apply the
 * correction twice and hand the cheapest band a standing advantage over the
 * dearest. So this divides the chips actually moved by the chips actually
 * risked, and the bands fall out of it on their own.
 *
 * Derived from the same rows the ladder is built from rather than queried
 * again. Two queries could disagree - a match landing between them is all it
 * would take - and "the ladder and the prize table were computed from
 * different matches" is not a sentence anyone wants to write about money.
 *
 * Agents short of `minMatches` are kept, in order, after everyone placed, with
 * a null rank and the number of matches they still need. They are not hidden:
 * an owner who is four matches away should be able to see that they are four
 * matches away.
 */
export function prizeOrder(table: Standing[], minMatches = MIN_RANKED_MATCHES_FOR_PRIZE): PrizeStanding[] {
  const scored = table.map((s) => ({ ...s, perChip: perChip(s), shortBy: Math.max(0, minMatches - s.rankedMatches) }));
  const placed = scored.filter((s) => s.shortBy === 0 && s.perChip !== null);
  const rest = scored.filter((s) => !(s.shortBy === 0 && s.perChip !== null));
  // Ties go to MORE ranked matches - the opposite of the ladder, on purpose.
  // For a total, the same net from less exposure is the better result; for a
  // rate, the same rate held over more matches is the better evidence.
  placed.sort((a, b) => b.perChip! - a.perChip! || b.rankedMatches - a.rankedMatches || (a.agentId < b.agentId ? -1 : 1));
  rest.sort((a, b) => b.rankedMatches - a.rankedMatches || (a.agentId < b.agentId ? -1 : 1));
  return [
    ...placed.map((s, i) => ({ ...s, prizeRank: i + 1 })),
    ...rest.map((s) => ({ ...s, prizeRank: null, shortBy: Math.max(s.shortBy, s.perChip === null ? minMatches : 0) })),
  ];
}
