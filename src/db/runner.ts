import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { firstFreeMark } from "../marks.js";
import { randomInt } from "node:crypto";
import { policyAgent, policyFromAgent, type Policy } from "../agents/policy.js";
import { OXUDE_RULES, type Stakes } from "../round.js";
import { playMatch } from "../engine.js";
import { PRESETS, PRESET_VERSION, type PresetName } from "../presets.js";
import { renderTranscript } from "../transcript.js";
import type { Agent, MatchLog } from "../types.js";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm";
import { connect, type Db } from "./client.js";
import {
  agents,
  chainOps,
  ledger,
  matches,
  withdrawals,
  ratings,
  bandOf,
  CEILING_BANDS,
  MAX_EXPOSURE,
  MIN_STAKE,
  RATING_WINDOW,
  STARTING_BALANCE,
  type CeilingBand,
  type AgentRow,
  type MatchRow,
  type RulesConfig,
} from "./schema.js";
import { balanceOf, balancesOf, record, retireIfBroke, settle, stakeBetween, StakeError } from "./ledger.js";

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

const sameStakes = (a: Stakes, b: Stakes) =>
  a.ante === b.ante && a.baseBet === b.baseBet && a.raisedBet === b.raisedBet;

/**
 * A stored table encodes decisions taken at particular prices. Playing it at
 * other stakes would silently misprice every fold, so refuse instead.
 */
export function assertStakesMatch(row: Pick<AgentRow, "name" | "policyStakes">, stakes: Stakes): void {
  const built = row.policyStakes ?? DEFAULT_RULES.stakes;
  if (!sameStakes(built, stakes)) {
    throw new Error(
      `agent ${row.name} has a table built for ante ${built.ante}/${built.baseBet}/${built.raisedBet}, ` +
        `but this match is at ante ${stakes.ante}/${stakes.baseBet}/${stakes.raisedBet}; ` +
        `re-elicit or re-snapshot the table for these stakes`,
    );
  }
}

export type CreateAgentInput = {
  name: string;
  ownerId?: string | null;
  presetName?: PresetName;
  brief?: string;
  policyTable?: Policy;
  /** Defaults to the shipped stakes; must match the stakes matches are played at. */
  policyStakes?: Stakes;
  /** The owner's per-match ceiling. Defaults to a full match's exposure. */
  maxStake?: number;
  /** Balance to seed. Defaults to STARTING_BALANCE. */
  startingBalance?: number;
};

/** Clamped so an owner cannot set a ceiling no match could honour. */
export const clampCeiling = (value: number) => Math.max(MIN_STAKE, Math.min(MAX_EXPOSURE, Math.floor(value)));

/** Writes an agent with its table snapshotted, a ratings row, and a seeded balance. */
export async function createAgent(db: Db, input: CreateAgentInput) {
  const table = input.policyTable ?? (input.presetName ? snapshotPreset(input.presetName) : undefined);
  if (!table) throw new Error(`agent ${input.name} needs a preset name or a policy table`);
  const seed = input.startingBalance ?? STARTING_BALANCE;
  // The agent, its seeded balance and the chain op that funds its vault land
  // together, so a vault can never be owed without an agent or vice versa.
  return db.transaction(async (tx) => {
  const [row] = await tx
    .insert(agents)
    .values({
      name: input.name,
      presetName: input.presetName ?? null,
      brief: input.brief ?? null,
      ownerId: input.ownerId ?? null,
      policyTable: table,
      policyStakes: input.policyStakes ?? DEFAULT_RULES.stakes,
      maxStake: clampCeiling(input.maxStake ?? MAX_EXPOSURE),
    })
    .returning();
  await tx.insert(ratings).values({ agentId: row!.id });
  // Renting seeds the balance: the first movement in this agent's ledger.
  await record(tx, [{ agentId: row!.id, amount: seed, reason: "rental-seed" }]);
  await tx.insert(chainOps).values({ kind: "open_vault", agentId: row!.id, amount: seed });
  // A player's agent gets its owner recorded on chain too, after the vault: that's who can withdraw.
  if (row!.ownerId) await tx.insert(chainOps).values({ kind: "register_owner", agentId: row!.id, owner: row!.ownerId, amount: 0 });
  // Its emoji, unique across all agents, chosen with the agent.
  return { ...row!, mark: await assignMark(tx as unknown as Db, row!.id) };
  });
}

/**
 * Gives an agent the first mark its id leads to that no agent has yet
 * (src/marks.ts). A unique index backs it: if a concurrent rental takes the
 * same mark first, this one moves on to its next candidate.
 */
export async function assignMark(db: Db, agentId: string): Promise<string> {
  const taken = new Set(
    (await db.select({ mark: agents.mark }).from(agents).where(isNotNull(agents.mark))).map((r) => r.mark!),
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const mark = firstFreeMark(agentId, taken);
    try {
      // A savepoint, so a clash doesn't abort the surrounding transaction.
      await db.transaction(async (sp) => {
        await sp.update(agents).set({ mark }).where(eq(agents.id, agentId));
      });
      return mark;
    } catch (error) {
      if (!/agents_mark_unique|duplicate key|23505/.test(String((error as { cause?: unknown }).cause ?? error))) throw error;
      taken.add(mark);
    }
  }
  throw new Error(`could not give ${agentId} a unique mark`);
}

/** Marks every agent that has none, oldest first: the backfill, and harmless to run again. */
export async function assignMissingMarks(db: Db): Promise<number> {
  const missing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(isNull(agents.mark))
    .orderBy(agents.createdAt, agents.id);
  for (const { id } of missing) await assignMark(db, id);
  return missing.length;
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
  assertStakesMatch(rowA, rules.stakes);
  assertStakesMatch(rowB, rules.stakes);
  for (const row of [rowA, rowB]) {
    if (row.retiredAt !== null) throw new StakeError(`${row.name} is retired`);
  }

  // What both sides can cover, under both owners' ceilings.
  const balances = await balancesOf(db, [rowA.id, rowB.id]);
  const stake = stakeBetween(
    { name: rowA.name, balance: balances.get(rowA.id) ?? 0, ceiling: rowA.maxStake },
    { name: rowB.name, balance: balances.get(rowB.id) ?? 0, ceiling: rowB.maxStake },
  );
  const seed = options.seed ?? newSeed();
  // No display names in the log: the match row references both agents, and a
  // name-free log is exactly what a replay reproduces.
  const log = playMatch(resolveAgent(rowA), resolveAgent(rowB), { seed, ...rules });

  // One transaction: a recorded match and the ratings derived from it move together.
  // Capped by the stake: a match can never take more than was put at risk.
  const settledA = settle(log.nets.A, stake);
  const { match, retired } = await db.transaction(async (tx) => {
    // Lock both agents, then make sure neither has a withdrawal on its way: while one is
    // in flight the vault is spoken for, and a match would move money the chain isn't expecting.
    await tx.execute(sql`select id from ${agents} where ${agents.id} in (${rowA.id}, ${rowB.id}) for update`);
    const busy = await tx
      .select({ agentId: withdrawals.agentId })
      .from(withdrawals)
      .where(and(inArray(withdrawals.agentId, [rowA.id, rowB.id]), eq(withdrawals.status, "submitted")));
    if (busy.length > 0) {
      const name = busy[0]!.agentId === rowA.id ? rowA.name : rowB.name;
      throw new StakeError(`${name} has a withdrawal on its way; it can play again once that lands`);
    }
    const [inserted] = await tx
      .insert(matches)
      .values({
        agentA: rowA.id,
        agentB: rowB.id,
        seed,
        rulesConfig: rules,
        winner: log.winner,
        netA: settledA,
        netB: -settledA,
        stake,
        log,
      })
      .returning();
    await record(tx, [
      { agentId: rowA.id, amount: settledA, reason: "match-settlement", matchId: inserted!.id },
      { agentId: rowB.id, amount: -settledA, reason: "match-settlement", matchId: inserted!.id },
    ]);
    // Queue the same movement for the chain. A level match moves nothing.
    if (settledA !== 0) {
      const [loser, winner] = settledA > 0 ? [rowB.id, rowA.id] : [rowA.id, rowB.id];
      await tx.insert(chainOps).values({
        kind: "settle",
        matchId: inserted!.id,
        fromAgent: loser,
        toAgent: winner,
        amount: Math.abs(settledA),
      });
    }
    await updateRating(tx, rowA.id);
    await updateRating(tx, rowB.id);
    // An agent with nothing left stops here; its record freezes as it stands.
    const broke: string[] = [];
    for (const id of [rowA.id, rowB.id]) if (await retireIfBroke(tx, id)) broke.push(id);
    return { match: inserted!, retired: broke };
  });
  return { match, log, stake, settled: { A: settledA, B: -settledA }, retired };
}

/**
 * An exhibition between two house agents: played by the same engine and stored
 * as a match, with a transcript and a share page, but nothing moves. No ledger
 * rows, no chain op, no rating update. The stake is what the two could have
 * covered, so its numbers read like any match; the row is flagged so every
 * view can say it was an exhibition.
 */
export async function runExhibition(db: Db, agentAId: string, agentBId: string, options: { seed?: number } = {}) {
  const [rowA, rowB] = await Promise.all([loadAgent(db, agentAId), loadAgent(db, agentBId)]);
  for (const row of [rowA, rowB]) {
    if (row.ownerId !== null) throw new StakeError(`${row.name} is not a house agent`);
    if (row.retiredAt !== null) throw new StakeError(`${row.name} is retired`);
  }
  if (rowA.id === rowB.id) throw new StakeError("an agent cannot play itself");
  const rules = DEFAULT_RULES;
  const balances = await balancesOf(db, [rowA.id, rowB.id]);
  const stake = stakeBetween(
    { name: rowA.name, balance: balances.get(rowA.id) ?? 0, ceiling: rowA.maxStake },
    { name: rowB.name, balance: balances.get(rowB.id) ?? 0, ceiling: rowB.maxStake },
  );
  const seed = options.seed ?? newSeed();
  const log = playMatch(resolveAgent(rowA), resolveAgent(rowB), { seed, ...rules });
  const settledA = settle(log.nets.A, stake);
  const [match] = await db
    .insert(matches)
    .values({
      agentA: rowA.id,
      agentB: rowB.id,
      seed,
      rulesConfig: rules,
      winner: log.winner,
      netA: settledA,
      netB: -settledA,
      stake,
      log,
      exhibition: true,
    })
    .returning();
  return { match: match!, log };
}

/**
 * Recomputes an agent's rating from its own matches: the mean net over the last
 * RATING_WINDOW, and how many it has played. Derived, so it cannot drift.
 */
export async function updateRating(db: Db | PgTransaction<PgQueryResultHKT, Record<string, never>, TablesRelationalConfig>, agentId: string): Promise<void> {
  const mine = sql<number>`case when ${matches.agentA} = ${agentId} then ${matches.netA} else ${matches.netB} end`;
  // Exhibitions stake nothing, so they say nothing about how an agent does for money.
  const played = and(or(eq(matches.agentA, agentId), eq(matches.agentB, agentId)), eq(matches.exhibition, false));

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
  /** The ceiling band both agents are in. */
  band?: CeilingBand;
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
  const solvent = db
    .select({ agentId: ledger.agentId, balance: sql<number>`sum(${ledger.amount})::int`.as("balance") })
    .from(ledger)
    .groupBy(ledger.agentId)
    .having(sql`sum(${ledger.amount}) >= ${MIN_STAKE}`)
    .as("solvent");

  // Same band, and able to cover a stake. The band is what a ceiling buys:
  // who you meet, not what a match is worth.
  const band = bandOf(me.maxStake);
  const bounds = CEILING_BANDS.find((b) => b.name === band)!;
  const inBand =
    band === "10-20"
      ? lte(agents.maxStake, bounds.max)
      : band === "20-40"
        ? and(gt(agents.maxStake, 20), lte(agents.maxStake, 40))
        : gt(agents.maxStake, 40);

  const candidates = await db
    .select({ id: agents.id, ownerId: agents.ownerId, rating: agents.trueRating })
    .from(agents)
    .innerJoin(solvent, eq(solvent.agentId, agents.id))
    .where(
      and(
        ne(agents.id, agentId),
        isNull(agents.retiredAt),
        gte(agents.maxStake, MIN_STAKE),
        inBand,
        // Two agents with no owner are not the same owner.
        me.ownerId === null ? sql`true` : or(isNull(agents.ownerId), ne(agents.ownerId, me.ownerId)),
        // Not one with a withdrawal on its way: it can't play until that lands.
        sql`not exists (select 1 from ${withdrawals} where ${withdrawals.agentId} = ${agents.id} and ${withdrawals.status} = 'submitted')`,
      ),
    );

  if (candidates.length >= minCandidates) {
    const best = candidates.reduce((closest, c) =>
      Math.abs((c.rating ?? 0) - mine) < Math.abs((closest.rating ?? 0) - mine) ? c : closest,
    );
    const pick: OpponentPick = {
      opponentId: best.id,
      band,
      path: "closest-rating",
      candidates: candidates.length,
      ratingGap: Math.abs((best.rating ?? 0) - mine),
    };
    options.onLog?.({ ...pick, agentId });
    return pick;
  }

  // Fall back to a preset agent in the same band, so a thin queue does not
  // silently put a cautious agent in with the boldest on the roster.
  const [preset] = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(solvent, eq(solvent.agentId, agents.id))
    .where(and(ne(agents.id, agentId), isNull(agents.retiredAt), inBand, sql`${agents.presetName} is not null`))
    .orderBy(sql`random()`)
    .limit(1);
  if (!preset) throw new StakeError(`no opponent in the ${band} band can cover a stake right now`);
  const pick: OpponentPick = {
    opponentId: preset.id,
    band,
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
export type LadderTab = "winnings" | "per-match";

export async function leaderboard(db: Db, limit = 50, tab: LadderTab = "winnings") {
  const netPerMatch = sql<number>`case when ${ratings.matchesPlayed} = 0 then 0
    else ${ratings.cumulativeNet}::double precision / ${ratings.matchesPlayed} end`;
  const balance = sql<number>`coalesce((select sum(${ledger.amount})::int from ${ledger} where ${ledger.agentId} = ${agents.id}), 0)`;
  const rows = db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      mark: agents.mark,
      matchesPlayed: ratings.matchesPlayed,
      cumulativeNet: ratings.cumulativeNet,
      netPerMatch,
      recentForm: ratings.rollingNet50,
      balance,
      // Retired agents stay on the ladder, marked: a record is history, not hidden.
      retired: sql<boolean>`${agents.retiredAt} is not null`,
    })
    .from(ratings)
    .innerJoin(agents, eq(agents.id, ratings.agentId));

  // "Per match" needs a match to divide by; that is arithmetic, not a skill bar.
  return tab === "winnings"
    ? rows.orderBy(desc(ratings.cumulativeNet)).limit(limit)
    : rows.where(gt(ratings.matchesPlayed, 0)).orderBy(desc(netPerMatch)).limit(limit);
}

/**
 * A stored match as prose. Loads the log and the two names; the renderer sees
 * nothing else, so a transcript cannot leak a brief or a table.
 */
export async function renderStoredTranscript(db: Db, matchId: string): Promise<string> {
  const [row] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!row) throw new Error(`no match ${matchId}`);
  const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentA)).limit(1);
  const [b] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentB)).limit(1);
  return renderTranscript(row.log, { A: a?.name ?? "A", B: b?.name ?? "B" });
}

/** What anyone may see about someone else's agent: no true rating, no brief. */
export async function publicAgent(db: Db, agentId: string) {
  const [row] = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      mark: agents.mark,
      createdAt: agents.createdAt,
      retiredAt: agents.retiredAt,
      matchesPlayed: ratings.matchesPlayed,
      cumulativeNet: ratings.cumulativeNet,
      recentForm: ratings.rollingNet50,
      maxStake: agents.maxStake,
      balance: sql<number>`coalesce((select sum(${ledger.amount})::int from ${ledger} where ${ledger.agentId} = ${agents.id}), 0)`,
      retired: sql<boolean>`${agents.retiredAt} is not null`,
      /** A house agent: unowned, seeded so a first player has someone to meet. */
      house: sql<boolean>`${agents.ownerId} is null`,
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

/** Who is available to play, optionally inside one ceiling band. */
export async function roster(db: Db, options: { band?: CeilingBand; limit?: number } = {}) {
  const bounds = options.band;
  const inBand =
    bounds === undefined
      ? sql`true`
      : bounds === "10-20"
        ? lte(agents.maxStake, 20)
        : bounds === "20-40"
          ? and(gt(agents.maxStake, 20), lte(agents.maxStake, 40))
          : gt(agents.maxStake, 40);

  const balance = sql<number>`coalesce((select sum(${ledger.amount})::int from ${ledger} where ${ledger.agentId} = ${agents.id}), 0)`;
  return db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      mark: agents.mark,
      maxStake: agents.maxStake,
      matchesPlayed: ratings.matchesPlayed,
      cumulativeNet: ratings.cumulativeNet,
      recentForm: ratings.rollingNet50,
      balance,
    })
    .from(agents)
    .innerJoin(ratings, eq(ratings.agentId, agents.id))
    .where(and(isNull(agents.retiredAt), inBand))
    .orderBy(desc(ratings.matchesPlayed))
    .limit(options.limit ?? 24);
}

/** Active agents in each ceiling band, so a newcomer can be pointed at the busiest. */
export async function bandCounts(db: Db): Promise<Record<CeilingBand, number>> {
  const [row] = await db
    .select({
      low: sql<number>`count(*) filter (where ${agents.maxStake} <= 20)::int`,
      mid: sql<number>`count(*) filter (where ${agents.maxStake} > 20 and ${agents.maxStake} <= 40)::int`,
      high: sql<number>`count(*) filter (where ${agents.maxStake} > 40)::int`,
    })
    .from(agents)
    .where(isNull(agents.retiredAt));
  return { "10-20": Number(row?.low ?? 0), "20-40": Number(row?.mid ?? 0), "40-60": Number(row?.high ?? 0) };
}

/** The owner's ceiling, changed after renting. */
export async function setCeiling(db: Db, agentId: string, ownerId: string | null, ceiling: number) {
  const row = await ownerAgent(db, agentId, ownerId);
  if (!row) throw new Error(`no agent ${agentId}`);
  const maxStake = clampCeiling(ceiling);
  await db.update(agents).set({ maxStake }).where(eq(agents.id, agentId));
  return maxStake;
}

export { balanceOf, bandOf, CEILING_BANDS, connect, MAX_EXPOSURE, MIN_STAKE, RATING_WINDOW, StakeError };
