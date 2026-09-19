import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  agents,
  elicitations,
  ledger,
  FREE_ELICITATIONS,
  MAX_EXPOSURE,
  MIN_STAKE,
  type LedgerReason,
} from "./schema.js";

/**
 * Money. Balances are derived from the ledger, never accumulated in a column,
 * so a balance is always the sum of movements that actually happened.
 */

export type Movement = { agentId: string; amount: number; reason: LedgerReason; matchId?: string; withdrawalId?: string };

type Writable = Pick<Db, "insert" | "select" | "update">;

export async function record(db: Writable, movements: Movement[]): Promise<void> {
  if (movements.length === 0) return;
  await db.insert(ledger).values(
    movements.map((m) => ({
      agentId: m.agentId,
      amount: m.amount,
      reason: m.reason,
      ...(m.matchId ? { matchId: m.matchId } : {}),
      ...(m.withdrawalId ? { withdrawalId: m.withdrawalId } : {}),
    })),
  );
}

export async function balanceOf(db: Writable, agentId: string): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`coalesce(sum(${ledger.amount}), 0)::int` })
    .from(ledger)
    .where(eq(ledger.agentId, agentId));
  return Number(row?.balance ?? 0);
}

export async function balancesOf(db: Writable, agentIds: string[]): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({ agentId: ledger.agentId, balance: sql<number>`coalesce(sum(${ledger.amount}), 0)::int` })
    .from(ledger)
    .where(inArray(ledger.agentId, agentIds))
    .groupBy(ledger.agentId);
  return new Map(rows.map((r) => [r.agentId, Number(r.balance)]));
}

/** An agent's whole history of movements, newest first. */
export async function statement(db: Db, agentId: string, limit = 50) {
  return db
    .select({ amount: ledger.amount, reason: ledger.reason, matchId: ledger.matchId, at: ledger.createdAt })
    .from(ledger)
    .where(eq(ledger.agentId, agentId))
    .orderBy(sql`${ledger.seq} desc`)
    .limit(limit);
}

export class StakeError extends Error {}

/**
 * What a match between these two puts at risk: what both can actually cover,
 * and never more than one match can move. Ceilings do not enter this - they
 * decide who meets whom, not what a match is worth. Throws when either side
 * cannot cover the minimum.
 */
export function stakeBetween(
  a: { name: string; balance: number },
  b: { name: string; balance: number },
): number {
  for (const side of [a, b]) {
    if (side.balance < MIN_STAKE) {
      throw new StakeError(`${side.name} cannot cover a stake: balance ${side.balance}, minimum ${MIN_STAKE}`);
    }
  }
  return Math.min(a.balance, b.balance, MAX_EXPOSURE);
}

/** Nobody can lose money they do not have: the stake is what both could cover. */
export const settle = (net: number, stake: number): number => Math.max(-stake, Math.min(stake, net));

/**
 * An agent that can no longer cover a stake is retired: its record stops here.
 * The test is the minimum stake, not zero - a balance below it can never be
 * played again, so leaving it alive would just make an unplayable zombie.
 */
export async function retireIfBroke(db: Writable, agentId: string): Promise<boolean> {
  const balance = await balanceOf(db, agentId);
  if (balance >= MIN_STAKE) return false;
  await db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, agentId));
  return true;
}

/** How many model calls this owner has had, and whether the next one is free. */
export async function elicitationCount(db: Writable, ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(elicitations)
    .where(eq(elicitations.ownerId, ownerId));
  return Number(row?.n ?? 0);
}

export async function isFirstElicitationFree(db: Writable, ownerId: string): Promise<boolean> {
  return (await elicitationCount(db, ownerId)) < FREE_ELICITATIONS;
}

export async function recordElicitation(
  db: Writable,
  input: { ownerId: string; kind: "preview" | "rent"; free: boolean },
): Promise<void> {
  await db.insert(elicitations).values(input);
}

export { MAX_EXPOSURE, MIN_STAKE };
