import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { policyAgent, policyFromAgent, type Policy } from "../agents/policy.js";
import { OXUDE_RULES } from "../round.js";
import { playMatch } from "../engine.js";
import { PRESETS, PRESET_VERSION, type PresetName } from "../presets.js";
import type { Agent, MatchLog } from "../types.js";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm";
import { connect, type Db } from "./client.js";
import {
  agents,
  matches,
  ratings,
  RATING_WINDOW,
  type AgentRow,
  type MatchRow,
  type RulesConfig,
} from "./schema.js";

export const DEFAULT_RULES: RulesConfig = {
  turnOrder: OXUDE_RULES.turnOrder,
  deal: OXUDE_RULES.deal,
  stakes: { ...OXUDE_RULES.stakes },
  presetVersion: PRESET_VERSION,
};

/** The view an agent's table is snapshotted at: the rules it will be played under. */
const snapshotView = {
  myRoundsWon: 0,
  oppRoundsWon: 0,
  roundNumber: 1,
  oppRaiseCount: 0,
  stakes: DEFAULT_RULES.stakes,
  myNet: 0,
  myActionThisRound: null,
} as const;

/** A preset's table, frozen at the shipped stakes, so transcripts replay for good. */
export const snapshotPreset = (name: PresetName): Policy => policyFromAgent(PRESETS[name], snapshotView);

export type CreateAgentInput = {
  name: string;
  ownerId?: string | null;
  presetName?: PresetName;
  brief?: string;
  policyTable?: Policy;
};

/** Writes an agent with its table already snapshotted, and a ratings row. */
export async function createAgent(db: Db, input: CreateAgentInput) {
  const table = input.policyTable ?? (input.presetName ? snapshotPreset(input.presetName) : undefined);
  if (!table) throw new Error(`agent ${input.name} needs a preset name or a policy table`);
  const [row] = await db
    .insert(agents)
    .values({
      name: input.name,
      presetName: input.presetName ?? null,
      brief: input.brief ?? null,
      ownerId: input.ownerId ?? null,
      policyTable: table,
    })
    .returning();
  await db.insert(ratings).values({ agentId: row!.id });
  return row!;
}

/** A uint32, which is what the engine's PRNG takes. */
export const newSeed = () => randomInt(0, 4_294_967_296);

/**
 * Turns a stored agent into a playable function: a shipped preset by name, or
 * the table elicited when the agent was created. Never calls a model.
 */
export function resolveAgent(row: Pick<AgentRow, "presetName" | "policyTable" | "name">): Agent {
  // The stored table wins, for presets too: it is what the agent actually
  // played, so a retune of the shipped presets cannot rewrite old transcripts.
  if (row.policyTable !== null) return policyAgent(row.policyTable);
  if (row.presetName !== null) {
    const preset = PRESETS[row.presetName as PresetName];
    if (!preset) throw new Error(`agent ${row.name} names an unknown preset: ${row.presetName}`);
    return preset;
  }
  throw new Error(`agent ${row.name} has neither a preset nor a policy table`);
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
  const mine = sql<number>`case when ${matches.agentA} = ${agentId} then ${matches.netA} else ${matches.netB} end`;
  const played = or(eq(matches.agentA, agentId), eq(matches.agentB, agentId));

  // seq is monotonic, so "the last RATING_WINDOW" is unambiguous even when many
  // matches share a timestamp.
  const recent = await db.select({ net: mine }).from(matches).where(played).orderBy(desc(matches.seq)).limit(RATING_WINDOW);
  const totals = await db
    .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${mine}), 0)::int` })
    .from(matches)
    .where(played);

  const window = recent.map((r) => Number(r.net));
  const rolling = window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0;
  const set = {
    matchesPlayed: totals[0]?.n ?? 0,
    cumulativeNet: Number(totals[0]?.total ?? 0),
    rollingNet50: rolling,
    updatedAt: new Date(),
  };
  await db.insert(ratings).values({ agentId, ...set }).onConflictDoUpdate({ target: ratings.agentId, set });
}

export type OpponentPick = {
  opponentId: string;
  /** Which path matchmaking took, for the log. */
  path: "closest-rating" | "preset-fallback";
  candidates: number;
  ratingGap: number | null;
};

export type PickOpponentOptions = {
  /** Below this many candidates, fall back to a preset agent. Default 4. */
  minCandidates?: number;
  onLog?: (pick: OpponentPick & { agentId: string }) => void;
};

/**
 * Picks the closest-rated active opponent that has played recently and does not
 * share an owner. Falls back to a preset agent so a queue never stalls.
 */
export async function pickOpponent(db: Db, agentId: string, options: PickOpponentOptions = {}): Promise<OpponentPick> {
  const minCandidates = options.minCandidates ?? 4;
  const me = await loadAgent(db, agentId);
  const mine = me.trueRating ?? 0;

  // Paired on true rating: the only signal here that is not noise. No recency
  // gate, so a cold roster can bootstrap.
  const candidates = await db
    .select({ id: agents.id, ownerId: agents.ownerId, rating: agents.trueRating })
    .from(agents)
    .where(
      and(
        ne(agents.id, agentId),
        isNull(agents.retiredAt),
        // Two agents with no owner are not the same owner.
        me.ownerId === null ? sql`true` : or(isNull(agents.ownerId), ne(agents.ownerId, me.ownerId)),
      ),
    );

  if (candidates.length >= minCandidates) {
    const best = candidates.reduce((closest, c) =>
      Math.abs((c.rating ?? 0) - mine) < Math.abs((closest.rating ?? 0) - mine) ? c : closest,
    );
    const pick: OpponentPick = {
      opponentId: best.id,
      path: "closest-rating",
      candidates: candidates.length,
      ratingGap: Math.abs((best.rating ?? 0) - mine),
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

/**
 * Ranked on all-time net won: a fact, not an estimate, so every match counts and
 * there is no minimum. recentForm rides along for display and is not ranked on.
 * trueRating is deliberately absent: it is private to an agent's owner.
 */
export async function leaderboard(db: Db, limit = 50) {
  return db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      matchesPlayed: ratings.matchesPlayed,
      cumulativeNet: ratings.cumulativeNet,
      recentForm: ratings.rollingNet50,
    })
    .from(ratings)
    .innerJoin(agents, eq(agents.id, ratings.agentId))
    .where(isNull(agents.retiredAt))
    .orderBy(desc(ratings.cumulativeNet))
    .limit(limit);
}

/** What anyone may see about someone else's agent: no true rating, no brief. */
export async function publicAgent(db: Db, agentId: string) {
  const [row] = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      createdAt: agents.createdAt,
      retiredAt: agents.retiredAt,
      matchesPlayed: ratings.matchesPlayed,
      cumulativeNet: ratings.cumulativeNet,
      recentForm: ratings.rollingNet50,
    })
    .from(agents)
    .leftJoin(ratings, eq(ratings.agentId, agents.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  return row;
}

/** The owner's own view, which does include the private rating. */
export async function ownerAgent(db: Db, agentId: string, ownerId: string | null) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!row) return undefined;
  if ((row.ownerId ?? null) !== ownerId) throw new Error("agent belongs to another owner");
  return row;
}

export { connect, RATING_WINDOW };
