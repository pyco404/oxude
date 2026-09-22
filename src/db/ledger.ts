import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  agents,
  elicitations,
  ledger,
  FREE_ELICITATIONS,
  MIN_STAKE,
  affordableBands,
  bandByName,
  canAffordBand,
  type BandName,
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
 * What a match in this band puts at risk: the whole of the band's worst match,
 * every time. There is no clamp any more - a band is a money scale, and scaling
 * only works if both sides pay the scale in full - so both agents must be able
 * to cover it before the match is played at all.
 *
 * The old ceiling clamp is gone deliberately. It let a short balance drag a
 * stronger opponent's match down to it, which is what made the top two ceiling
 * bands play identically.
 */
export function stakeBetween(
  a: { name: string; balance: number },
  b: { name: string; balance: number },
  band: BandName,
): number {
  const worst = bandByName(band).worstMatch;
  for (const side of [a, b]) {
    if (!canAffordBand(side.balance, band)) {
      throw new StakeError(
        `${side.name} cannot cover a band ${band} match: balance ${side.balance}, needs ${worst}`,
      );
    }
  }
  return worst;
}

/**
 * A match's net, as the ledger will record it. Nothing is clamped: the engine
 * already cannot produce a net beyond the band's worst match, and both sides
 * were checked against that before playing.
 */
export const settle = (net: number): number => net;

/**
 * An agent is retired only when no band is open to it - below the cheapest
 * band's worst match, where the only thing left to do is withdraw. Falling
 * below its *own* band's cover is not retirement: the agent is simply barred
 * from that band until its owner moves it to one it can cover. The band is the
 * owner's choice, so nothing here spends it on their behalf.
 */
export async function retireIfBroke(db: Writable, agentId: string): Promise<boolean> {
  const balance = await balanceOf(db, agentId);
  if (affordableBands(balance).length > 0) return false;
  await db.update(agents).set({ retiredAt: new Date(), retiredReason: "broke" }).where(eq(agents.id, agentId));
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

export { MIN_STAKE };
