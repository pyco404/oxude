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
    totalMatches: Number(r.totalMatches),
    totalNet: Number(r.totalNet),
  }));
}
