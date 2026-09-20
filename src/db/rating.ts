import { eq, isNull, sql } from "drizzle-orm";
import { policyAgent, type Policy } from "../agents/policy.js";
import { seatAveragedNet } from "../exact.js";
import { OXUDE_RULES } from "../round.js";
import type { Agent } from "../types.js";
import type { Db } from "./client.js";
import { agents, bandByName, type BandName } from "./schema.js";

/**
 * Exact ratings. A decision table's expected net against the roster is
 * computable without playing anything, so this is a private tool for writing a
 * brief - never the ladder. The ladder ranks what agents actually won.
 */

export type RosterProfile = {
  /** Distinct tables on the roster, with how many agents play each. */
  entries: { table: Policy; weight: number }[];
  /** Changes whenever the mix changes; recompute ratings when it does. */
  fingerprint: string;
  agentCount: number;
};

const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/** Groups the active roster by distinct table, so a rating costs one evaluation per distinct opponent. */
export async function rosterProfile(db: Db): Promise<RosterProfile> {
  const rows = await db
    .select({ table: agents.policyTable, n: sql<number>`count(*)::int` })
    .from(agents)
    .where(isNull(agents.retiredAt))
    .groupBy(agents.policyTable);

  const entries = rows
    .filter((r): r is { table: Policy; n: number } => r.table !== null)
    .map((r) => ({ table: r.table, weight: Number(r.n) }))
    .sort((a, b) => JSON.stringify(a.table).localeCompare(JSON.stringify(b.table)));
  const agentCount = entries.reduce((s, e) => s + e.weight, 0);
  return {
    entries,
    agentCount,
    // The prefix versions how ratings are computed: bump it and every stored rating goes stale.
    fingerprint: hash(`v2-self-excluded|${entries.map((e) => `${e.weight}:${JSON.stringify(e.table)}`).join("|")}`),
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
 * What a table is worth against today's roster, rated on band B's scale and
 * priced in the band the player is actually considering.
 *
 * The rating is deliberately band-neutral: it is always computed at OXUDE_RULES,
 * so two agents are comparable however they play. The money is not - a band C
 * player wants to know what a match is worth to them, not to a band B player -
 * so `priced` scales the same figures by the band's factor. Both come from one
 * calculation, because a band is only a scale.
 */
export function previewPolicy(table: Policy, profile: RosterProfile, band: BandName = "B") {
  const agent = policyAgent(table);
  const factor = bandByName(band).factor;
  const rating = trueRatingAgainst(agent, profile);
  return {
    /** Normalised onto band B, and so comparable with every other agent. */
    trueRating: rating,
    basis: "against the roster as it stands today",
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
 * Recomputes true ratings for agents whose stored rating predates the current
 * roster. Cheap: one exact evaluation per distinct table on the roster.
 */
export async function refreshTrueRatings(db: Db, options: { force?: boolean } = {}): Promise<number> {
  const profile = await rosterProfile(db);
  const rows = await db
    .select({ id: agents.id, table: agents.policyTable, roster: agents.trueRatingRoster })
    .from(agents)
    .where(isNull(agents.retiredAt));

  let updated = 0;
  for (const row of rows) {
    if (row.table === null) continue;
    if (!options.force && row.roster === profile.fingerprint) continue;
    const rating = trueRatingAgainst(policyAgent(row.table), rosterWithout(profile, row.table));
    await db
      .update(agents)
      .set({ trueRating: rating, trueRatingRoster: profile.fingerprint })
      .where(eq(agents.id, row.id));
    updated++;
  }
  return updated;
}
