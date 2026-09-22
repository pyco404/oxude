import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { policyAgent, type Policy } from "../agents/policy.js";
import { seatAveragedNet } from "../exact.js";
import { OXUDE_RULES } from "../round.js";
import type { Agent } from "../types.js";
import type { Db } from "./client.js";
import { agents, bandByName, matches, STAKE_BANDS, type BandName } from "./schema.js";
import { rentalOpenSql } from "./rental.js";

/**
 * Exact ratings. A decision table's expected net against the roster is
 * computable without playing anything, so this is a private tool for writing a
 * brief - never the ladder. The ladder ranks what agents actually won.
 */

export type RosterProfile = {
  /** The band this roster is: matchmaking never pairs across bands, so neither does a rating. */
  band: BandName;
  /** Distinct tables on the roster, with how many agents play each. */
  entries: { table: Policy; weight: number }[];
  /** Changes whenever the mix changes; recompute ratings when it does. */
  fingerprint: string;
  agentCount: number;
  /** Who was counted, so an agent left out as idle is not also subtracted from it. */
  members: Set<string>;
};

const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/**
 * How long a player's agent may go without a staked match and still count as
 * part of the roster a rating is measured against.
 */
export const ROSTER_ACTIVE_DAYS = 7;

/**
 * Groups one band's active roster by distinct table, so a rating costs one
 * evaluation per distinct opponent. One band only: an agent can only ever be
 * matched inside its own band, so agents in the others are not opponents and
 * rating against them describes a roster nobody plays.
 *
 * "Active" also leaves out player agents that have sat idle for
 * ROSTER_ACTIVE_DAYS - rented, never switched on, never played - because a
 * pile of dormant rentals of one preset would otherwise decide every figure
 * on the rent screen. They stay matchable; this is only about what a rating
 * is measured against. House agents always count: they are always in play.
 */
export async function rosterProfile(db: Db, band: BandName, now = new Date()): Promise<RosterProfile> {
  const since = new Date(now.getTime() - ROSTER_ACTIVE_DAYS * 24 * 60 * 60 * 1000);
  const active = or(
    isNull(agents.ownerId),
    gt(agents.createdAt, since),
    sql`exists (select 1 from ${matches} where (${matches.agentA} = ${agents.id} or ${matches.agentB} = ${agents.id}) and ${matches.exhibition} = false and ${matches.createdAt} > ${since.toISOString()})`,
  );
  const rows = await db
    .select({ id: agents.id, table: agents.policyTable })
    .from(agents)
    // Expired agents are left out too: they cannot be matched until renewed.
    .where(and(isNull(agents.retiredAt), eq(agents.band, band), rentalOpenSql(now), active));

  const members = new Set<string>();
  const byTable = new Map<string, { table: Policy; weight: number }>();
  for (const r of rows) {
    if (r.table === null) continue;
    members.add(r.id);
    const key = canonical(r.table);
    const entry = byTable.get(key);
    if (entry) entry.weight++;
    else byTable.set(key, { table: r.table, weight: 1 });
  }
  const entries = [...byTable.values()].sort((a, b) => JSON.stringify(a.table).localeCompare(JSON.stringify(b.table)));
  const agentCount = entries.reduce((s, e) => s + e.weight, 0);
  return {
    band,
    entries,
    agentCount,
    members,
    // The prefix versions how ratings are computed: bump it and every stored rating goes stale.
    fingerprint: hash(`v3-per-band|${band}|${entries.map((e) => `${e.weight}:${JSON.stringify(e.table)}`).join("|")}`),
  };
}

/** Exact expected net per match against the roster as a whole. No sampling. */
export function trueRatingAgainst(agent: Agent, profile: RosterProfile): number {
  if (profile.agentCount === 0) return 0;
  let total = 0;
  for (const { table, weight } of profile.entries) {
    total += weight * seatAveragedNet(agent, policyAgent(table), OXUDE_RULES);
  }
  return total / profile.agentCount;
}

/** Key order can differ between a table as written and as stored, so compare canonically. */
const canonical = (value: unknown): string =>
  value !== null && typeof value === "object"
    ? `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
        .join(",")}}`
    : JSON.stringify(value);

/**
 * The roster as one of its own agents faces it: everyone but itself. Other
 * agents playing the same table still count; they are real opponents. This is
 * what makes an agent's rating after renting equal the preview it was rented
 * on, since the preview rated a table that was not yet on the roster.
 */
export function rosterWithout(profile: RosterProfile, table: Policy): RosterProfile {
  const key = canonical(table);
  const index = profile.entries.findIndex((e) => canonical(e.table) === key);
  if (index < 0) return profile;
  const entries = profile.entries
    .map((e, i) => (i === index ? { ...e, weight: e.weight - 1 } : e))
    .filter((e) => e.weight > 0);
  return { ...profile, entries, agentCount: profile.agentCount - 1 };
}

/**
 * What a player sees while writing a brief, before staking anything. The figure
 * is exact, but it is exact about today's roster: it is not a promise about
 * future opponents, who will include agents written after this was computed.
 */
/**
 * What a table is worth against one band's roster today, rated on band B's
 * scale and priced in that band's money.
 *
 * The opponents are the band's; the arithmetic is band-neutral. It is always
 * computed at OXUDE_RULES, so two agents are comparable whichever band they
 * play, and `priced` scales the same figures by the band's factor - a band C
 * player wants to know what a match is worth to them. Both come from one
 * calculation, because a band is only a scale.
 */
export function previewPolicy(table: Policy, profile: RosterProfile) {
  const agent = policyAgent(table);
  const band = profile.band;
  const factor = bandByName(band).factor;
  const rating = trueRatingAgainst(agent, profile);
  return {
    /** Normalised onto band B, and so comparable with every other agent. */
    trueRating: rating,
    basis: `against band ${band}'s roster as it stands today`,
    band,
    /** The same rating in the money this band actually moves. */
    priced: { band, perMatch: rating * factor, worstMatch: bandByName(band).worstMatch },
    roster: profile.agentCount,
    rosterFingerprint: profile.fingerprint,
    /** Per distinct opponent, so a brief can be aimed at what is actually out there. */
    breakdown: profile.entries.map((e) => {
      const net = seatAveragedNet(agent, policyAgent(e.table), OXUDE_RULES);
      return { weight: e.weight, expectedNet: net, pricedNet: net * factor };
    }),
  };
}

/**
 * Recomputes true ratings for agents whose stored rating predates their band's
 * current roster. Each agent is rated against its own band, the only opponents
 * it can meet. Cheap: one exact evaluation per distinct table on the roster.
 */
export async function refreshTrueRatings(db: Db, options: { force?: boolean } = {}): Promise<number> {
  const profiles = new Map<BandName, RosterProfile>();
  for (const b of STAKE_BANDS) profiles.set(b.name, await rosterProfile(db, b.name));
  const rows = await db
    .select({ id: agents.id, band: agents.band, table: agents.policyTable, roster: agents.trueRatingRoster })
    .from(agents)
    .where(isNull(agents.retiredAt));

  let updated = 0;
  for (const row of rows) {
    if (row.table === null) continue;
    const profile = profiles.get(row.band)!;
    if (!options.force && row.roster === profile.fingerprint) continue;
    // Everyone but itself - unless it was left out as idle, in which case it is not there to remove.
    const opponents = profile.members.has(row.id) ? rosterWithout(profile, row.table) : profile;
    const rating = trueRatingAgainst(policyAgent(row.table), opponents);
    await db
      .update(agents)
      .set({ trueRating: rating, trueRatingRoster: profile.fingerprint })
      .where(eq(agents.id, row.id));
    updated++;
  }
  return updated;
}
