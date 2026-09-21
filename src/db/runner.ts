import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { firstFreeMark } from "../marks.js";
import { newAgentId } from "../agent-id.js";
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
  STAKE_BANDS,
  DEFAULT_BAND,
  affordableBands,
  bandByName,
  bandStakes,
  canAffordBand,
  normaliseNet,
  outflowBudget,
  OUTFLOW_WINDOW_MS,
  MIN_STAKE,
  RATING_WINDOW,
  STARTING_BALANCE,
  type BandName,
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
 * Whether one set of stakes is the other at a different scale: every amount
 * multiplied by the same factor. A table prices decisions in ratios - what a
 * fold costs against what the pot pays - and those ratios are untouched by a
 * uniform scale, so the same table is correct at every band. That is precisely
 * why bands are money scales and not arbitrary price lists: change one amount
 * without the others and the table really would be mispriced.
 */
export function sameShape(a: Stakes, b: Stakes): boolean {
  if (a.ante <= 0 || b.ante <= 0) return sameStakes(a, b);
  const factor = b.ante / a.ante;
  return b.baseBet === a.baseBet * factor && b.raisedBet === a.raisedBet * factor;
}

/**
 * A stored table encodes decisions taken at particular prices. Playing it at
 * stakes of a different shape would silently misprice every fold, so refuse
 * instead. A different band is not a different shape: it is the same prices,
 * scaled, so an agent may change band without re-eliciting its table.
 */
export function assertStakesMatch(row: Pick<AgentRow, "name" | "policyStakes">, stakes: Stakes): void {
  const built = row.policyStakes ?? DEFAULT_RULES.stakes;
  if (!sameShape(built, stakes)) {
    throw new Error(
      `agent ${row.name} has a table built for ante ${built.ante}/${built.baseBet}/${built.raisedBet}, ` +
        `but this match is at ante ${stakes.ante}/${stakes.baseBet}/${stakes.raisedBet}, which is not the ` +
        `same prices at a different scale; re-elicit or re-snapshot the table for these stakes`,
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
  /** The money scale to play at. Defaults to DEFAULT_BAND. */
  band?: BandName;
  /** Balance to seed. Defaults to STARTING_BALANCE. */
  startingBalance?: number;
};

/** The rules a band is played under: the shipped rules at that band's scale. */
export function bandRules(band: BandName): RulesConfig {
  return { ...DEFAULT_RULES, stakes: bandStakes(band) };
}

/** Writes an agent with its table snapshotted, a ratings row, and a seeded balance. */
export async function createAgent(db: Db, input: CreateAgentInput) {
  const table = input.policyTable ?? (input.presetName ? snapshotPreset(input.presetName) : undefined);
  if (!table) throw new Error(`agent ${input.name} needs a preset name or a policy table`);
  const seed = input.startingBalance ?? STARTING_BALANCE;
  // The agent, its seeded balance and the chain op that funds its vault land
  // together, so a vault can never be owed without an agent or vice versa.
  // Its id is bound to its owner (src/agent-id.ts): the chain records that owner and no other.
  const { id, salt } = newAgentId(input.ownerId ?? null);
  return db.transaction(async (tx) => {
  const [row] = await tx
    .insert(agents)
    .values({
      id,
      name: input.name,
      presetName: input.presetName ?? null,
      brief: input.brief ?? null,
      ownerId: input.ownerId ?? null,
      policyTable: table,
      policyStakes: input.policyStakes ?? DEFAULT_RULES.stakes,
      band: input.band ?? DEFAULT_BAND,
    })
    .returning();
  await tx.insert(ratings).values({ agentId: row!.id });
  // Renting seeds the balance: the first movement in this agent's ledger.
  await record(tx, [{ agentId: row!.id, amount: seed, reason: "rental-seed" }]);
  // Opening the vault records a player's agent's owner too: that's who can withdraw.
  await tx.insert(chainOps).values({ kind: "open_vault", agentId: row!.id, owner: row!.ownerId, salt, amount: seed });
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
  // Both agents must be on the same money scale, or the match has two prices.
  if (rowA.band !== rowB.band) {
    throw new StakeError(`${rowA.name} plays band ${rowA.band} and ${rowB.name} band ${rowB.band}`);
  }
  const band = rowA.band;
  const rules = options.rules ?? bandRules(band);
  assertStakesMatch(rowA, rules.stakes);
  assertStakesMatch(rowB, rules.stakes);
  for (const row of [rowA, rowB]) {
    if (row.retiredAt !== null) throw new StakeError(`${row.name} is retired`);
  }

  // The band's worst match, which both sides must be able to cover outright.
  const balances = await balancesOf(db, [rowA.id, rowB.id]);
  const stake = stakeBetween(
    { name: rowA.name, balance: balances.get(rowA.id) ?? 0 },
    { name: rowB.name, balance: balances.get(rowB.id) ?? 0 },
    band,
  );
  const seed = options.seed ?? newSeed();
  // No display names in the log: the match row references both agents, and a
  // name-free log is exactly what a replay reproduces.
  const log = playMatch(resolveAgent(rowA), resolveAgent(rowB), { seed, ...rules });

  // One transaction: a recorded match and the ratings derived from it move together.
  // Nothing is capped: the engine cannot produce more than the band's worst
  // match, and both sides were checked against that above.
  const settledA = settle(log.nets.A);
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
        band,
        // Both sides player-rented, decided here and stored, so a later sale
        // cannot change what this match counted for.
        ranked: rowA.ownerId !== null && rowB.ownerId !== null,
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
  if (rowA.band !== rowB.band) {
    throw new StakeError(`${rowA.name} plays band ${rowA.band} and ${rowB.name} band ${rowB.band}`);
  }
  const band = rowA.band;
  const rules = bandRules(band);
  const balances = await balancesOf(db, [rowA.id, rowB.id]);
  const stake = stakeBetween(
    { name: rowA.name, balance: balances.get(rowA.id) ?? 0 },
    { name: rowB.name, balance: balances.get(rowB.id) ?? 0 },
    band,
  );
  const seed = options.seed ?? newSeed();
  const log = playMatch(resolveAgent(rowA), resolveAgent(rowB), { seed, ...rules });
  const settledA = settle(log.nets.A);
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
      band,
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
  const raw = sql<number>`case when ${matches.agentA} = ${agentId} then ${matches.netA} else ${matches.netB} end`;
  // Normalised onto band B's scale by dividing out the band's factor, so an
  // agent's record means the same thing whichever band it earned it in: a band
  // C win of 30 is a band B win of 20, and a band A win of 10 is too. Only what
  // the ladder compares is normalised (the ranked figures and recent form);
  // cumulativeNet is the money the agent actually won, so it sums `raw`.
  // The factors are inlined rather than bound: a bare parameter in a CASE result
  // has no type Postgres can infer. They are this module's own constants.
  const factor = sql<number>`(case ${sql.join(
    STAKE_BANDS.map((b) => sql`when ${matches.band} = ${b.name} then ${sql.raw(b.factor.toFixed(4))}`),
    sql` `,
  )} else 1 end)::double precision`;
  const mine = sql<number>`((${raw})::double precision / ${factor})`;
  // Exhibitions stake nothing, so they say nothing about how an agent does for money.
  const played = and(or(eq(matches.agentA, agentId), eq(matches.agentB, agentId)), eq(matches.exhibition, false));

  // seq is monotonic, so "the last RATING_WINDOW" is unambiguous even when many
  // matches share a timestamp.
  const recent = await db.select({ net: mine }).from(matches).where(played).orderBy(desc(matches.seq)).limit(RATING_WINDOW);
  const totals = await db
    .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${raw}), 0)::int` })
    .from(matches)
    .where(played);

  // The ladder's figures: player-versus-player matches only, normalised so
  // agents in different bands rank against each other. Kept apart rather than replacing the totals above, because
  // an owner who beat the house still earned that money and should be able to
  // see it - what they did not earn is a place on the ladder for it.
  const rankedOnly = and(played, eq(matches.ranked, true));
  const ranked = await db
    .select({
      n: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${mine}), 0)::int`,
      // Stake is the money at risk, not normalised: it is what the ladder's
      // net-per-chip-staked figure divides by, and both sides risked the same.
      staked: sql<number>`coalesce(sum(${matches.stake}), 0)::int`,
    })
    .from(matches)
    .where(rankedOnly);

  const window = recent.map((r) => Number(r.net));
  const rolling = window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0;
  const set = {
    matchesPlayed: totals[0]?.n ?? 0,
    cumulativeNet: Number(totals[0]?.total ?? 0),
    rankedMatches: ranked[0]?.n ?? 0,
    rankedNet: Number(ranked[0]?.total ?? 0),
    rankedStaked: Number(ranked[0]?.staked ?? 0),
    rollingNet50: rolling,
    updatedAt: new Date(),
  };
  await db.insert(ratings).values({ agentId, ...set }).onConflictDoUpdate({ target: ratings.agentId, set });
}

export type OpponentPick = {
  opponentId: string;
  /** The stake band both agents are in. */
  band?: BandName;
  /** Which path matchmaking took, for the log. */
  path: "closest-rating" | "preset-fallback";
  candidates: number;
  ratingGap: number | null;
};

/**
 * How many agents are ready to play in each band, from this agent's point of
 * view: in the band, not retired, solvent for that band's worst match, not the
 * agent itself and not one of its owner's. Used to name a band worth trying
 * when the agent's own has nobody in it.
 */
export async function playableBands(
  db: Db,
  agentId: string,
  ownerId: string | null,
): Promise<{ band: BandName; count: number }[]> {
  // Joined rather than correlated: a subquery grouped by agent is the pattern
  // the rest of this file uses, and it is the one that actually correlates.
  const balances = db
    .select({ agentId: ledger.agentId, balance: sql<number>`sum(${ledger.amount})::int`.as("balance") })
    .from(ledger)
    .groupBy(ledger.agentId)
    .as("balances");
  const rows = await db
    .select({ band: agents.band, balance: balances.balance })
    .from(agents)
    .innerJoin(balances, eq(balances.agentId, agents.id))
    .where(
      and(
        ne(agents.id, agentId),
        isNull(agents.retiredAt),
        ownerId === null ? sql`true` : or(isNull(agents.ownerId), ne(agents.ownerId, ownerId)),
      ),
    );
  return STAKE_BANDS.map((b) => ({
    band: b.name,
    count: rows.filter((r) => r.band === b.name && Number(r.balance) >= b.worstMatch).length,
  }));
}

export type PickOpponentOptions = {
  /** Below this many candidates, fall back to a preset agent. Default 4. */
  minCandidates?: number;
  onLog?: (pick: OpponentPick & { agentId: string }) => void;
  /**
   * Prefer opponents this agent has not just played. Autoplay sets this: it
   * picks by closest rating, which is deterministic, so without it the same
   * pairing would repeat every ten minutes and pile onto one vault's window.
   */
  spread?: boolean;
};

/** How many recent matches the spread penalty looks back over. */
const RECENT_OPPONENTS = 6;
/**
 * What one recent meeting costs an opponent in rating distance. Large enough
 * to break a tie between similarly rated agents, small enough that it never
 * pairs a cautious agent with the boldest on the roster to avoid a repeat.
 */
const RECENT_OPPONENT_PENALTY = 0.05;

/** Who this agent has played lately, and how often, most recent matches first. */
async function recentOpponents(db: Db, agentId: string, limit: number): Promise<Map<string, number>> {
  const rows = await db
    .select({ a: matches.agentA, b: matches.agentB })
    .from(matches)
    .where(and(or(eq(matches.agentA, agentId), eq(matches.agentB, agentId)), eq(matches.exhibition, false)))
    .orderBy(desc(matches.seq))
    .limit(limit);
  const met = new Map<string, number>();
  for (const r of rows) {
    const other = r.a === agentId ? r.b : r.a;
    met.set(other, (met.get(other) ?? 0) + 1);
  }
  return met;
}

/**
 * What a vault has already committed to pay out inside the chain's current
 * window, as SQL: settlements queued against it in the trailing window,
 * whatever became of them.
 *
 * Pending and confirmed both count. A pending op is money the chain has not
 * been asked for yet but will be, and a failed one is money it refused, which
 * is the situation this is here to avoid rather than a reason to try again.
 */
const committedOutflow = (agentId: unknown) => sql<number>`coalesce((
  select sum(${chainOps.amount})::int from ${chainOps}
  where ${chainOps.kind} = 'settle'
    and ${chainOps.fromAgent} = ${agentId}
    and ${chainOps.status} <> 'failed'
    and ${chainOps.createdAt} > now() - interval '${sql.raw(String(Math.round(OUTFLOW_WINDOW_MS / 1000)))} seconds'
), 0)`;

/**
 * Whether this agent could lose `worstMatch` without pushing its vault past
 * what the chain will let it pay out in one window.
 *
 * The program caps a vault's outflow per window and re-reads the cap from the
 * balance before each transfer, so the cap falls as the vault pays. If several
 * autoplayers all pick the same popular opponent inside one window and it
 * loses, the ledger records every loss and the chain refuses the ones past the
 * cap: the money is still right, but the ledger and the chain stop agreeing
 * and the reconciler has to report it.
 *
 * So the ledger declines the pairing first. This is a smoothing measure, not a
 * safety one - the program's cap is the guarantee, and this only keeps us from
 * walking into it.
 */
export async function hasOutflowRoom(db: Db, agentId: string, worstMatch: number): Promise<boolean> {
  const [row] = await db
    .select({ balance: sql<number>`coalesce(sum(${ledger.amount})::int, 0)`, spent: committedOutflow(agentId) })
    .from(ledger)
    .where(eq(ledger.agentId, agentId));
  const balance = Number(row?.balance ?? 0);
  const spent = Number(row?.spent ?? 0);
  return spent + worstMatch <= outflowBudget(balance);
}

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
    .having(sql`sum(${ledger.amount}) >= ${bandByName(me.band).worstMatch}`)
    .as("solvent");

  // Same band: a match has one money scale, so both agents must be on it.
  const band = me.band;
  const inBand = eq(agents.band, band);

  const worstMatch = bandByName(band).worstMatch;
  const all = await db
    .select({
      id: agents.id,
      ownerId: agents.ownerId,
      presetName: agents.presetName,
      rating: agents.trueRating,
      balance: solvent.balance,
      spent: committedOutflow(agents.id),
    })
    .from(agents)
    .innerJoin(solvent, eq(solvent.agentId, agents.id))
    .where(
      and(
        ne(agents.id, agentId),
        isNull(agents.retiredAt),
        inBand,
        // Two agents with no owner are not the same owner.
        me.ownerId === null ? sql`true` : or(isNull(agents.ownerId), ne(agents.ownerId, me.ownerId)),
        // Not one with a withdrawal on its way: it can't play until that lands.
        sql`not exists (select 1 from ${withdrawals} where ${withdrawals.agentId} = ${agents.id} and ${withdrawals.status} = 'submitted')`,
      ),
    );

  // Drop anyone whose vault could not pay a full loss inside the chain's
  // window. Both sides are checked: this agent can lose too, and its own vault
  // is under exactly the same cap.
  const candidates = all.filter((c) => Number(c.spent) + worstMatch <= outflowBudget(Number(c.balance)));
  if (!(await hasOutflowRoom(db, agentId, worstMatch))) {
    throw new StakeError(
      `${me.name} has settled as much as its vault can pay out in one window. It plays again within fifteen minutes.`,
    );
  }

  if (candidates.length >= minCandidates) {
    // Closest rating is the signal. With `spread`, an opponent met in the last
    // few matches is pushed down it, so a timer that fires every ten minutes
    // does not keep serving the same pairing - and does not keep charging the
    // same vault's window.
    const recent = options.spread ? await recentOpponents(db, agentId, RECENT_OPPONENTS) : new Map<string, number>();
    const distance = (c: (typeof candidates)[number]) =>
      Math.abs((c.rating ?? 0) - mine) + (recent.get(c.id) ?? 0) * RECENT_OPPONENT_PENALTY;
    const best = candidates.reduce((closest, c) => (distance(c) < distance(closest) ? c : closest));
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
  //
  // Drawn from `candidates`, not from a query of its own. An earlier version
  // ran a separate, looser query here that checked neither a pending
  // withdrawal nor the vault's window - so the one path meant to guarantee an
  // opponent was the one path that could pair into a settlement the chain
  // would refuse. Everything in `candidates` has already passed every check
  // above, including the owner check, so reusing it cannot reintroduce any.
  const presets = candidates.filter((c) => c.presetName !== null);
  const preset = presets.length ? presets[randomInt(presets.length)] : undefined;
  if (!preset) {
    // Nobody here. Point at a band that does have opponents rather than leaving
    // the owner to guess which one to try.
    const elsewhere = await playableBands(db, agentId, me.ownerId);
    const best = elsewhere.filter((b) => b.band !== band && b.count > 0).sort((x, y) => y.count - x.count)[0];
    throw new StakeError(
      best
        ? `no opponent in the ${band} band right now. Band ${best.band} has ${best.count} ${
            best.count === 1 ? "agent" : "agents"
          } ready to play - move there, or try again later.`
        : `no opponent in the ${band} band right now, and no other band has one either. Try again later.`,
    );
  }
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
  // Ranked figures only. Every number the ladder sorts by is player-versus-
  // player; the totals ride along beside them so an owner can see that their
  // winnings against the house are still there and simply do not count.
  const netPerMatch = sql<number>`case when ${ratings.rankedMatches} = 0 then 0
    else ${ratings.rankedNet}::double precision / ${ratings.rankedMatches} end`;
  const balance = sql<number>`coalesce((select sum(${ledger.amount})::int from ${ledger} where ${ledger.agentId} = ${agents.id}), 0)`;
  const rows = db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      mark: agents.mark,
      // What the ladder ranks on.
      matchesPlayed: ratings.rankedMatches,
      cumulativeNet: ratings.rankedNet,
      netPerMatch,
      rankedStaked: ratings.rankedStaked,
      // Every staked match, house included: shown, never ranked.
      totalMatches: ratings.matchesPlayed,
      totalNet: ratings.cumulativeNet,
      recentForm: ratings.rollingNet50,
      balance,
      // Retired agents stay on the ladder, marked: a record is history, not hidden.
      retired: sql<boolean>`${agents.retiredAt} is not null`,
    })
    .from(ratings)
    .innerJoin(agents, eq(agents.id, ratings.agentId));

  // Players only. A house agent can never rank - every match it plays is
  // against a player and so unranked, or against the house and an exhibition -
  // so listing one would only put a permanent zero between real players.
  const players = isNotNull(agents.ownerId);
  // "Per match" needs a match to divide by; that is arithmetic, not a skill bar.
  return tab === "winnings"
    ? rows.where(players).orderBy(desc(ratings.rankedNet)).limit(limit)
    : rows.where(and(players, gt(ratings.rankedMatches, 0))).orderBy(desc(netPerMatch)).limit(limit);
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
/** The columns every public view of an agent shows. */
const publicAgentColumns = {
  agentId: agents.id,
  name: agents.name,
  presetName: agents.presetName,
  mark: agents.mark,
  createdAt: agents.createdAt,
  retiredAt: agents.retiredAt,
  // Every staked match: the agent's money.
  matchesPlayed: ratings.matchesPlayed,
  cumulativeNet: ratings.cumulativeNet,
  // Player-versus-player only: what the ladder counts. Already public there.
  rankedMatches: ratings.rankedMatches,
  rankedNet: ratings.rankedNet,
  recentForm: ratings.rollingNet50,
  band: agents.band,
  balance: sql<number>`coalesce((select sum(${ledger.amount})::int from ${ledger} where ${ledger.agentId} = ${agents.id}), 0)`,
  retired: sql<boolean>`${agents.retiredAt} is not null`,
  /** A house agent: unowned, seeded so a first player has someone to meet. */
  house: sql<boolean>`${agents.ownerId} is null`,
};

export async function publicAgent(db: Db, agentId: string) {
  const [row] = await db
    .select(publicAgentColumns)
    .from(agents)
    .leftJoin(ratings, eq(ratings.agentId, agents.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  return row;
}

/**
 * Every agent this wallet owns, the ones still playing first and the newest of
 * those first. An owner holds one active agent at a time, but they keep their
 * retired ones: a record is the point of renting, and it outlives the agent.
 */
export async function agentsOf(db: Db, ownerId: string) {
  return db
    .select(publicAgentColumns)
    .from(agents)
    .leftJoin(ratings, eq(ratings.agentId, agents.id))
    .where(eq(agents.ownerId, ownerId))
    .orderBy(sql`${agents.retiredAt} is not null`, desc(agents.createdAt));
}

/** The agents this wallet still has in play. */
export async function activeAgentsOf(db: Db, ownerId: string) {
  return db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), isNull(agents.retiredAt)));
}

/** The owner's own view, which does include the private rating. */
export async function ownerAgent(db: Db, agentId: string, ownerId: string | null) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!row) return undefined;
  if ((row.ownerId ?? null) !== ownerId) throw new Error("agent belongs to another owner");
  return row;
}

/** Who is available to play, optionally inside one stake band. */
export async function roster(db: Db, options: { band?: BandName; limit?: number } = {}) {
  const inBand = options.band === undefined ? sql`true` : eq(agents.band, options.band);

  const balance = sql<number>`coalesce((select sum(${ledger.amount})::int from ${ledger} where ${ledger.agentId} = ${agents.id}), 0)`;
  return db
    .select({
      agentId: agents.id,
      name: agents.name,
      presetName: agents.presetName,
      mark: agents.mark,
      band: agents.band,
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

/** Active agents in each stake band, so a newcomer can be pointed at the busiest. */
export async function bandCounts(db: Db): Promise<Record<BandName, number>> {
  const rows = await db
    .select({ band: agents.band, n: sql<number>`count(*)::int` })
    .from(agents)
    .where(isNull(agents.retiredAt))
    .groupBy(agents.band);
  const counts = Object.fromEntries(STAKE_BANDS.map((b) => [b.name, 0])) as Record<BandName, number>;
  for (const r of rows) if (r.band in counts) counts[r.band] = Number(r.n);
  return counts;
}

/**
 * The owner's band, changed after renting. Refused when the balance cannot
 * cover that band's worst match: the agent would be unable to play the moment
 * it moved. The table itself needs no re-elicitation - a band is the same
 * prices at a different scale.
 */
export async function setBand(db: Db, agentId: string, ownerId: string | null, band: BandName) {
  const row = await ownerAgent(db, agentId, ownerId);
  if (!row) throw new Error(`no agent ${agentId}`);
  const balance = await balanceOf(db, agentId);
  if (!canAffordBand(balance, band)) {
    throw new StakeError(
      `${row.name} holds ${balance} and cannot cover a band ${band} match, which can move ${bandByName(band).worstMatch}`,
    );
  }
  await db.update(agents).set({ band }).where(eq(agents.id, agentId));
  return band;
}

export {
  affordableBands,
  balanceOf,
  bandByName,
  bandStakes,
  canAffordBand,
  connect,
  normaliseNet,
  MIN_STAKE,
  RATING_WINDOW,
  STAKE_BANDS,
  StakeError,
};
