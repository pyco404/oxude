import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { policyAgent } from "../agents/policy.js";
import { OXUDE_RULES } from "../round.js";
import { playMatch } from "../engine.js";
import { PRESETS, type PresetName } from "../presets.js";
import type { Agent, MatchLog } from "../types.js";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm";
import { connect, type Db } from "./client.js";
import {
  agents,
  matches,
  ratings,
  MIN_RANKED_MATCHES,
  RATING_WINDOW,
  type AgentRow,
  type MatchRow,
  type RulesConfig,
} from "./schema.js";

export const DEFAULT_RULES: RulesConfig = {
  turnOrder: OXUDE_RULES.turnOrder,
  deal: OXUDE_RULES.deal,
  stakes: { ...OXUDE_RULES.stakes },
};

/** A uint32, which is what the engine's PRNG takes. */
export const newSeed = () => randomInt(0, 4_294_967_296);

/**
 * Turns a stored agent into a playable function: a shipped preset by name, or
 * the table elicited when the agent was created. Never calls a model.
 */
export function resolveAgent(row: Pick<AgentRow, "presetName" | "policyTable" | "name">): Agent {
  if (row.presetName !== null) {
    const preset = PRESETS[row.presetName as PresetName];
    if (!preset) throw new Error(`agent ${row.name} names an unknown preset: ${row.presetName}`);
    return preset;
  }
  if (row.policyTable === null) throw new Error(`agent ${row.name} has neither a preset nor a policy table`);
  return policyAgent(row.policyTable);
}

async function loadAgent(db: Db, id: string): Promise<AgentRow> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!row) throw new Error(`no agent ${id}`);
  return row;
}

/** Replays a stored match from its seed and rules; the log must come out identical. */
export function replayMatch(row: Pick<MatchRow, "seed" | "rulesConfig">, a: Agent, b: Agent): MatchLog {
  return playMatch(a, b, { seed: row.seed, ...row.rulesConfig });
}

export type RunMatchOptions = { seed?: number; rules?: RulesConfig };

/** Plays one match and records it, updating both ratings in the same transaction. */
export async function runMatch(db: Db, agentAId: string, agentBId: string, options: RunMatchOptions = {}) {
  const [rowA, rowB] = await Promise.all([loadAgent(db, agentAId), loadAgent(db, agentBId)]);
  const rules = options.rules ?? DEFAULT_RULES;
  const seed = options.seed ?? newSeed();
  // No display names in the log: the match row references both agents, and a
  // name-free log is exactly what a replay reproduces.
  const log = playMatch(resolveAgent(rowA), resolveAgent(rowB), { seed, ...rules });

  // One transaction: a recorded match and the ratings derived from it move together.
  const match = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(matches)
      .values({
        agentA: rowA.id,
        agentB: rowB.id,
        seed,
        rulesConfig: rules,
        winner: log.winner,
        netA: log.nets.A,
        netB: log.nets.B,
        log,
      })
      .returning();
    await updateRating(tx, rowA.id);
    await updateRating(tx, rowB.id);
    return inserted!;
  });
  return { match, log };
}

/**
 * Recomputes an agent's rating from its own matches: the mean net over the last
 * RATING_WINDOW, and how many it has played. Derived, so it cannot drift.
 */
export async function updateRating(db: Db | PgTransaction<PgQueryResultHKT, Record<string, never>, TablesRelationalConfig>, agentId: string): Promise<void> {
  const rows = await db
    .select({ net: sql<number>`case when ${matches.agentA} = ${agentId} then ${matches.netA} else ${matches.netB} end` })
    .from(matches)
    .where(or(eq(matches.agentA, agentId), eq(matches.agentB, agentId)))
    .orderBy(desc(matches.createdAt), desc(matches.id))
    .limit(RATING_WINDOW);

  const played = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matches)
    .where(or(eq(matches.agentA, agentId), eq(matches.agentB, agentId)));

  const window = rows.map((r) => Number(r.net));
  const rolling = window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0;
  await db
    .insert(ratings)
    .values({ agentId, matchesPlayed: played[0]?.n ?? 0, rollingNet50: rolling, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: ratings.agentId,
      set: { matchesPlayed: played[0]?.n ?? 0, rollingNet50: rolling, updatedAt: new Date() },
    });
}

export type OpponentPick = {
  opponentId: string;
  /** Which path matchmaking took, for the log. */
  path: "closest-rating" | "preset-fallback";
  candidates: number;
  ratingGap: number | null;
};

export type PickOpponentOptions = {
  /** How far back a candidate's last match may be. Default 7 days. */
  recentSince?: Date;
  /** Below this many candidates, fall back to a preset agent. Default 4. */
  minCandidates?: number;
  onLog?: (pick: OpponentPick & { agentId: string }) => void;
};

/**
 * Picks the closest-rated active opponent that has played recently and does not
 * share an owner. Falls back to a preset agent so a queue never stalls.
 */
export async function pickOpponent(db: Db, agentId: string, options: PickOpponentOptions = {}): Promise<OpponentPick> {
  const since = options.recentSince ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const minCandidates = options.minCandidates ?? 4;
  const me = await loadAgent(db, agentId);
  const [myRating] = await db.select().from(ratings).where(eq(ratings.agentId, agentId)).limit(1);
  const mine = myRating?.rollingNet50 ?? 0;

  const recent = db
    .select({ id: matches.agentA })
    .from(matches)
    .where(gte(matches.createdAt, since))
    .union(db.select({ id: matches.agentB }).from(matches).where(gte(matches.createdAt, since)));

  const candidates = await db
    .select({ id: agents.id, ownerId: agents.ownerId, rolling: ratings.rollingNet50 })
    .from(agents)
    .leftJoin(ratings, eq(ratings.agentId, agents.id))
    .where(
      and(
        ne(agents.id, agentId),
        isNull(agents.retiredAt),
        // Two agents with no owner are not the same owner.
        me.ownerId === null ? sql`true` : or(isNull(agents.ownerId), ne(agents.ownerId, me.ownerId)),
        inArray(agents.id, recent),
      ),
    );

  if (candidates.length >= minCandidates) {
    const best = candidates.reduce((closest, c) =>
      Math.abs((c.rolling ?? 0) - mine) < Math.abs((closest.rolling ?? 0) - mine) ? c : closest,
    );
    const pick: OpponentPick = {
      opponentId: best.id,
      path: "closest-rating",
      candidates: candidates.length,
      ratingGap: Math.abs((best.rolling ?? 0) - mine),
    };
    options.onLog?.({ ...pick, agentId });
    return pick;
  }

  const [preset] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(ne(agents.id, agentId), isNull(agents.retiredAt), sql`${agents.presetName} is not null`))
    .orderBy(sql`random()`)
    .limit(1);
  if (!preset) throw new Error("no preset agent available to fall back to");
  const pick: OpponentPick = {
    opponentId: preset.id,
    path: "preset-fallback",
    candidates: candidates.length,
    ratingGap: null,
  };
  options.onLog?.({ ...pick, agentId });
  return pick;
}

/** Ranked agents only: a rolling mean over fewer than MIN_RANKED_MATCHES is noise. */
export async function leaderboard(db: Db, limit = 50) {
  return db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      matchesPlayed: ratings.matchesPlayed,
      rollingNet50: ratings.rollingNet50,
    })
    .from(ratings)
    .innerJoin(agents, eq(agents.id, ratings.agentId))
    .where(and(gte(ratings.matchesPlayed, MIN_RANKED_MATCHES), isNull(agents.retiredAt)))
    .orderBy(desc(ratings.rollingNet50))
    .limit(limit);
}

export { connect, MIN_RANKED_MATCHES, RATING_WINDOW };
