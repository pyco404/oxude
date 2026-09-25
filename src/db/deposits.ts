import { Transaction } from "@solana/web3.js";
import { and, eq, inArray } from "drizzle-orm";
import type { PreparedWithdrawal } from "../chain/common.js";
import type { Db } from "./client.js";
import { balanceOf, record } from "./ledger.js";
import { agents, deposits, type RentalPaymentStatus } from "./schema.js";

/**
 * Topping up an agent's vault with its owner's own money.
 *
 * This is what the seed flow had no answer for: an agent that played itself
 * down below its band's cover was stuck there, because the only money that ever
 * entered a vault was the seed it was born with. Now its owner can put more in.
 *
 * Simpler than renting or withdrawing, because a deposit only adds. Nothing is
 * at risk if one lands twice as far as the program is concerned - it would
 * simply be two deposits - so the care here is only that the *ledger* counts
 * each one once, which the record is for. A deposit made outside the app is
 * still the agent's money; the reconciler credits it rather than calling it a
 * disagreement.
 */

export type DepositChain = {
  prepareDeposit(input: { agentId: string; owner: string; amount: number }): Promise<PreparedWithdrawal>;
  submitWithdrawal(raw: Uint8Array, lastValidBlockHeight: number): Promise<string>;
  blockHeightPassed(lastValidBlockHeight: number): Promise<boolean>;
  vaultBalance(agentId: string): Promise<number | null>;
};

export class DepositError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Builds a top-up for the owner to sign. */
export async function prepareDeposit(
  db: Db,
  chain: DepositChain,
  input: { agentId: string; ownerId: string; amount: number },
) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new DepositError(400, "the amount must be a whole number of base units above zero");
  }
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  if (!agent) throw new DepositError(404, "no such agent");
  if (agent.ownerId !== input.ownerId) throw new DepositError(403, "that agent belongs to someone else");
  // A seed agent's vault is a token account for the frozen program's mint, and
  // this deposit is denominated in the other one. There is nowhere to put it.
  if (agent.funding !== "deposit") {
    throw new DepositError(409, "this agent was rented before deposits and cannot be topped up");
  }
  if (agent.retiredAt !== null) throw new DepositError(409, "this agent is retired");

  const [row] = await db
    .insert(deposits)
    .values({ agentId: input.agentId, ownerId: input.ownerId, amount: input.amount, preparedTx: "", lastValidBlockHeight: 0 })
    .returning();
  const prepared = await chain.prepareDeposit({
    agentId: input.agentId,
    owner: input.ownerId,
    amount: input.amount,
  });
  const preparedTx = prepared.transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  await db
    .update(deposits)
    .set({ preparedTx, lastValidBlockHeight: prepared.lastValidBlockHeight, updatedAt: new Date() })
    .where(eq(deposits.id, row!.id));
  return { depositId: row!.id, amount: input.amount, transaction: preparedTx };
}

/** Sends the owner-signed top-up and records it once it lands. */
export async function submitDeposit(
  db: Db,
  chain: DepositChain,
  input: { depositId: string; ownerId: string; signedTx: string },
): Promise<{ status: RentalPaymentStatus; signature: string | null }> {
  const [d] = await db.select().from(deposits).where(eq(deposits.id, input.depositId)).limit(1);
  if (!d) throw new DepositError(404, "no such deposit");
  if (d.ownerId !== input.ownerId) throw new DepositError(403, "that deposit belongs to someone else");
  if (d.status !== "prepared") throw new DepositError(409, `this deposit is already ${d.status}`);

  let signed: Transaction;
  try {
    signed = Transaction.from(Buffer.from(input.signedTx, "base64"));
  } catch {
    throw new DepositError(400, "not a transaction");
  }
  const prepared = Transaction.from(Buffer.from(d.preparedTx, "base64"));
  if (!signed.serializeMessage().equals(prepared.serializeMessage())) {
    throw new DepositError(400, "that transaction isn't the one prepared for this deposit");
  }
  if (!signed.verifySignatures()) throw new DepositError(400, "the transaction isn't fully signed");

  const claimed = await db
    .update(deposits)
    .set({ status: "submitted", signedTx: input.signedTx, updatedAt: new Date() })
    .where(and(eq(deposits.id, d.id), eq(deposits.status, "prepared")))
    .returning({ id: deposits.id });
  if (claimed.length === 0) throw new DepositError(409, "this deposit was already submitted");

  try {
    const signature = await chain.submitWithdrawal(Buffer.from(input.signedTx, "base64"), d.lastValidBlockHeight);
    await confirmDeposit(db, d.id, signature);
    return { status: "confirmed", signature };
  } catch {
    // Either it landed and the confirmation was lost, or it never will. The
    // sweep asks the vault which, rather than guessing here.
    return { status: "submitted", signature: null };
  }
}

/** The money arrived: one ledger row, once, however often this is called. */
export async function confirmDeposit(db: Db, depositId: string, signature: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [d] = await tx.select().from(deposits).where(eq(deposits.id, depositId)).for("update");
    if (!d || d.status === "confirmed") return;
    await record(tx, [{ agentId: d.agentId, amount: d.amount, reason: "deposit" }]);
    await tx.update(deposits).set({ status: "confirmed", signature, updatedAt: new Date() }).where(eq(deposits.id, d.id));
  });
}

/** A top-up that can never land. Nothing is reversed, because nothing was recorded. */
export async function expireDeposit(db: Db, depositId: string, why: string): Promise<void> {
  await db
    .update(deposits)
    .set({ status: "expired", error: why.slice(0, 2000), updatedAt: new Date() })
    .where(and(eq(deposits.id, depositId), inArray(deposits.status, ["prepared", "submitted"])));
}

export type DepositSweep = { confirmed: string[]; expired: string[] };

/**
 * Resolves top-ups whose transaction can no longer land.
 *
 * A vault holding more than the ledger says is the evidence that one arrived:
 * nothing else puts money in. Comparing the two is how a lost confirmation is
 * told from a transaction that never happened, and getting it the wrong way
 * round would either lose the owner's money or credit them twice.
 */
export async function sweepDeposits(db: Db, chain: DepositChain): Promise<DepositSweep> {
  const waiting = await db.select().from(deposits).where(eq(deposits.status, "submitted"));
  const result: DepositSweep = { confirmed: [], expired: [] };
  for (const d of waiting) {
    const onChain = await chain.vaultBalance(d.agentId);
    const ledger = await balanceOf(db, d.agentId);
    if (onChain !== null && onChain - ledger >= d.amount) {
      await confirmDeposit(db, d.id, d.signature);
      result.confirmed.push(d.id);
      continue;
    }
    if (!(await chain.blockHeightPassed(d.lastValidBlockHeight))) continue;
    await expireDeposit(db, d.id, "the transaction never landed");
    result.expired.push(d.id);
  }
  return result;
}
