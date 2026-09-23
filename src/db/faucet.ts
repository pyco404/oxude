import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { faucetGrants, FAUCET_GRANT_CHIPS, FAUCET_INTERVAL_MS } from "./schema.js";

/**
 * The devnet faucet: stake tokens handed out so somebody can try the game
 * without buying anything.
 *
 * It exists only because devnet's stake token has no market. On mainnet there
 * is no equivalent and there cannot be one: the supply is fixed, every token
 * has an owner, and nothing in the program can make more. The gate that keeps
 * this off mainnet is not here but in what builds the chain side of it
 * (src/chain/faucet.ts), which refuses any cluster but devnet.
 *
 * One grant per wallet per FAUCET_INTERVAL_MS. The row is written before the
 * transfer, under a lock on the wallet, so two requests arriving together
 * cannot both pass the check; and it is marked failed if the transfer never
 * lands, so a grant that did not arrive does not use up the wallet's turn.
 */

/** What the faucet needs from the chain. The treasury signs; the program is not involved. */
export type FaucetChain = {
  /** Sends base units from the treasury to this wallet's token account. */
  payOut(wallet: string, amount: number): Promise<string>;
  /** What the treasury has left, in base units. */
  treasuryBalance(): Promise<number>;
};

export class FaucetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FaucetStatus = {
  /** Base units a grant hands out. */
  amount: number;
  /** The same in chips, which is what the screen says. */
  chips: number;
  available: boolean;
  /** When this wallet may ask again. Null when it may now. */
  nextAt: Date | null;
};

/** The wallet's most recent grant that still counts against the wait. */
async function lastGrant(db: Db, wallet: string, now: Date) {
  const since = new Date(now.getTime() - FAUCET_INTERVAL_MS);
  const [row] = await db
    .select()
    .from(faucetGrants)
    .where(
      and(
        eq(faucetGrants.wallet, wallet),
        inArray(faucetGrants.status, ["pending", "sent"]),
        gte(faucetGrants.createdAt, since),
      ),
    )
    .orderBy(desc(faucetGrants.createdAt))
    .limit(1);
  return row ?? null;
}

export async function faucetStatus(db: Db, wallet: string, chipRate: number, now = new Date()): Promise<FaucetStatus> {
  const last = await lastGrant(db, wallet, now);
  return {
    amount: FAUCET_GRANT_CHIPS * chipRate,
    chips: FAUCET_GRANT_CHIPS,
    available: last === null,
    nextAt: last ? new Date(last.createdAt.getTime() + FAUCET_INTERVAL_MS) : null,
  };
}

/**
 * Hands one grant to a wallet. The claim and the payment are deliberately not
 * one step: the claim is a database row and the payment is a transaction on a
 * chain, and nothing can make those atomic. So the claim goes first and is
 * released if the payment fails, which errs towards handing out too little.
 */
export async function grantFaucet(
  db: Db,
  chain: FaucetChain,
  wallet: string,
  chipRate: number,
  now = new Date(),
): Promise<{ amount: number; chips: number; signature: string }> {
  const amount = FAUCET_GRANT_CHIPS * chipRate;
  const treasury = await chain.treasuryBalance();
  if (treasury < amount) {
    throw new FaucetError(503, "the faucet is empty; it needs topping up before it can hand out any more");
  }

  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`faucet:${wallet}`}, 0))`);
    const last = await lastGrant(tx as unknown as Db, wallet, now);
    if (last) {
      const nextAt = new Date(last.createdAt.getTime() + FAUCET_INTERVAL_MS);
      const hours = Math.ceil((nextAt.getTime() - now.getTime()) / 3_600_000);
      throw new FaucetError(429, `this wallet has already been topped up; it can ask again in about ${hours} hour${hours === 1 ? "" : "s"}`);
    }
    // Stamped with the clock this was called with, not the database's own now:
    // the wait is measured from this column, so a caller's clock has to reach it
    // or the two disagree.
    const [row] = await tx.insert(faucetGrants).values({ wallet, amount, createdAt: now }).returning();
    return row!;
  });

  try {
    const signature = await chain.payOut(wallet, amount);
    await db.update(faucetGrants).set({ status: "sent", signature }).where(eq(faucetGrants.id, claim.id));
    return { amount, chips: FAUCET_GRANT_CHIPS, signature };
  } catch (error) {
    // The turn goes back: a failed row counts against nothing.
    await db
      .update(faucetGrants)
      .set({ status: "failed", error: String(error).slice(0, 2000) })
      .where(eq(faucetGrants.id, claim.id));
    throw new FaucetError(503, "the faucet could not send the tokens; try again in a moment");
  }
}
