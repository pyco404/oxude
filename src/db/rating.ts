import { eq, isNull, sql } from "drizzle-orm";
import { policyAgent, type Policy } from "../agents/policy.js";
import { seatAveragedNet } from "../exact.js";
import { OXUDE_RULES } from "../round.js";
import type { Agent } from "../types.js";
import type { Db } from "./client.js";
import { agents } from "./schema.js";

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
    fingerprint: hash(entries.map((e) => `${e.weight}:${JSON.stringify(e.table)}`).join("|")),
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

/**
 * What a player sees while writing a brief, before staking anything. The figure
 * is exact, but it is exact about today's roster: it is not a promise about
 * future opponents, who will include agents written after this was computed.
 */
export function previewPolicy(table: Policy, profile: RosterProfile) {
  const agent = policyAgent(table);
  return {
    trueRating: trueRatingAgainst(agent, profile),
    basis: "against the roster as it stands today",
    roster: profile.agentCount,
    rosterFingerprint: profile.fingerprint,
    /** Per distinct opponent, so a brief can be aimed at what is actually out there. */
    breakdown: profile.entries.map((e) => ({
      weight: e.weight,
      expectedNet: seatAveragedNet(agent, policyAgent(e.table), OXUDE_RULES),
    })),
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
    const rating = trueRatingAgainst(policyAgent(row.table), profile);
    await db
      .update(agents)
      .set({ trueRating: rating, trueRatingRoster: profile.fingerprint })
      .where(eq(agents.id, row.id));
    updated++;
  }
  return updated;
}
