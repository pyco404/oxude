import { Transaction } from "@solana/web3.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PreparedWithdrawal } from "../chain/common.js";
import type { Db } from "./client.js";
import { record } from "./ledger.js";
import { createAgent, type CreateAgentInput } from "./runner.js";
import { agents, chainOps, rentals, type RentalPaymentStatus } from "./schema.js";

/**
 * Renting on the deposit flow: the fee and the first deposit, as one
 * transaction the owner signs.
 *
 * The order is forced by the chain. An agent's vault address derives from its
 * id, so the agent row has to exist before the transaction can be built - which
 * means a row exists for a rental that has not been paid for yet. That agent
 * has no balance and no vault; it holds its owner's one-agent slot and nothing
 * else, and `sweepRentals` retires it if the transaction never lands.
 *
 * Nothing about the money can come apart on chain: the three instructions
 * succeed or fail together. What can come apart is the chain and the ledger, in
 * one direction only - the transaction lands and the server dies before
 * recording it. That is why `confirmRental` is written to be safe to call
 * again, and why the reconciler credits a vault it finds funded.
 */

/** What renting needs from the chain. The settler co-signs; the owner signs. */
export type RentalChain = {
  prepareRental(input: {
    rentalId: string;
    agentId: string;
    owner: string;
    salt: string;
    fee: number;
    deposit: number;
  }): Promise<PreparedWithdrawal>;
  submitRental(raw: Uint8Array, lastValidBlockHeight: number): Promise<string>;
  blockHeightPassed(lastValidBlockHeight: number): Promise<boolean>;
  /** The vault's balance, to tell a landed transaction from a lost one. */
  vaultBalance(agentId: string): Promise<number | null>;
};

export class RentalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A rental of this agent's that is still waiting on its transaction. */
export async function openRental(db: Db, agentId: string) {
  const [row] = await db
    .select()
    .from(rentals)
    .where(and(eq(rentals.agentId, agentId), inArray(rentals.status, ["prepared", "submitted"])))
    .limit(1);
  return row ?? null;
}

/**
 * Creates the agent and builds the transaction that pays for it. The agent is
 * real from here on but cannot play: it has no money until the transaction
 * lands.
 */
export async function prepareRental(
  db: Db,
  chain: RentalChain,
  input: CreateAgentInput & { ownerId: string; fee: number; deposit: number },
) {
  if (!Number.isSafeInteger(input.deposit) || input.deposit <= 0) {
    throw new RentalError(400, "the deposit must be a whole number of base units above zero");
  }
  if (!Number.isSafeInteger(input.fee) || input.fee <= 0) {
    throw new RentalError(400, "the rental fee must be a whole number of base units above zero");
  }

  const agent = await createAgent(db, { ...input, funding: "deposit" });
  const [row] = await db
    .insert(rentals)
    .values({
      agentId: agent.id,
      ownerId: input.ownerId,
      fee: input.fee,
      deposit: input.deposit,
      salt: agent.salt,
      preparedTx: "",
      lastValidBlockHeight: 0,
    })
    .returning();

  const prepared = await chain.prepareRental({
    rentalId: row!.id,
    agentId: agent.id,
    owner: input.ownerId,
    salt: agent.salt,
    fee: input.fee,
    deposit: input.deposit,
  });
  const preparedTx = prepared.transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  await db
    .update(rentals)
    .set({ preparedTx, lastValidBlockHeight: prepared.lastValidBlockHeight, updatedAt: new Date() })
    .where(eq(rentals.id, row!.id));
  return { rentalId: row!.id, agent, fee: input.fee, deposit: input.deposit, transaction: preparedTx };
}

/**
 * Takes the owner-signed transaction, checks it is exactly what was prepared,
 * sends it, and records what it did. Nothing is written to the ledger before
 * the transaction lands: an agent that was never paid for must never look like
 * one that was.
 */
export async function submitRental(
  db: Db,
  chain: RentalChain,
  input: { rentalId: string; ownerId: string; signedTx: string },
): Promise<{ status: RentalPaymentStatus; signature: string | null }> {
  const [r] = await db.select().from(rentals).where(eq(rentals.id, input.rentalId)).limit(1);
  if (!r) throw new RentalError(404, "no such rental");
  if (r.ownerId !== input.ownerId) throw new RentalError(403, "that rental belongs to someone else");
  if (r.status !== "prepared") throw new RentalError(409, `this rental is already ${r.status}`);

  let signed: Transaction;
  try {
    signed = Transaction.from(Buffer.from(input.signedTx, "base64"));
  } catch {
    throw new RentalError(400, "not a transaction");
  }
  const prepared = Transaction.from(Buffer.from(r.preparedTx, "base64"));
  // Exactly what was prepared: same instructions, same accounts, same amounts,
  // same blockhash. Anything else is a different rental than the one priced.
  if (!signed.serializeMessage().equals(prepared.serializeMessage())) {
    throw new RentalError(400, "that transaction isn't the one prepared for this rental");
  }
  if (!signed.verifySignatures()) throw new RentalError(400, "the transaction isn't fully signed");

  // Claim it: of two submissions of the same rental, only one gets past here.
  const claimed = await db
    .update(rentals)
    .set({ status: "submitted", signedTx: input.signedTx, updatedAt: new Date() })
    .where(and(eq(rentals.id, r.id), eq(rentals.status, "prepared")))
    .returning({ id: rentals.id });
  if (claimed.length === 0) throw new RentalError(409, "this rental was already submitted");

  try {
    const signature = await chain.submitRental(Buffer.from(input.signedTx, "base64"), r.lastValidBlockHeight);
    await confirmRental(db, r.id, signature);
    return { status: "confirmed", signature };
  } catch {
    // Not lost. Either it landed and the confirmation went missing, or it never
    // will; the sweep asks the chain which, rather than guessing here.
    return { status: "submitted", signature: null };
  }
}

/**
 * The rental landed: the deposit becomes the agent's opening balance, and the
 * vault is recorded as opened so the reconciler and withdrawals can see it.
 *
 * Safe to call twice. The vault record and the ledger row are written only if
 * they are not there already, so a confirmation arriving late - from the sweep,
 * after the request that sent it died - adds nothing a second time.
 */
export async function confirmRental(db: Db, rentalId: string, signature: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(rentals).where(eq(rentals.id, rentalId)).for("update");
    if (!r || r.status === "confirmed") return;
    const already = await tx
      .select({ id: chainOps.id })
      .from(chainOps)
      .where(and(eq(chainOps.agentId, r.agentId), eq(chainOps.kind, "open_vault")))
      .limit(1);
    if (already.length === 0) {
      await record(tx, [{ agentId: r.agentId, amount: r.deposit, reason: "deposit" }]);
      // A record of what the owner's transaction did, not an instruction to
      // send: it is confirmed the moment it is written, so the worker skips it.
      await tx.insert(chainOps).values({
        kind: "open_vault",
        agentId: r.agentId,
        owner: r.ownerId,
        salt: r.salt,
        amount: r.deposit,
        status: "confirmed",
        signature,
      });
    }
    await tx.update(rentals).set({ status: "confirmed", signature, updatedAt: new Date() }).where(eq(rentals.id, r.id));
  });
}

/**
 * A rental whose transaction can never land: the agent is retired and the
 * owner's slot comes back. Nothing is reversed, because nothing was ever
 * recorded - no fee was charged and no balance was written.
 */
export async function expireRental(db: Db, rentalId: string, why: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(rentals).where(eq(rentals.id, rentalId)).for("update");
    if (!r || r.status === "confirmed" || r.status === "expired") return;
    await tx.update(rentals).set({ status: "expired", error: why.slice(0, 2000), updatedAt: new Date() }).where(eq(rentals.id, r.id));
    await tx
      .update(agents)
      .set({ retiredAt: new Date(), retiredReason: "unpaid" })
      .where(and(eq(agents.id, r.agentId), sql`${agents.retiredAt} is null`));
  });
}

export type SweepResult = { confirmed: string[]; expired: string[] };

/**
 * Resolves every rental still waiting on a transaction that can no longer land.
 *
 * It asks the chain rather than assuming. A transaction whose block height has
 * passed either landed - and the vault holds the deposit, in which case the
 * confirmation was simply lost - or it never will. Guessing the second would
 * retire an agent its owner had paid for.
 */
export async function sweepRentals(db: Db, chain: RentalChain, now = new Date()): Promise<SweepResult> {
  // A prepared rental nobody ever signed is given a while before it is swept,
  // so a slow wallet does not lose the agent out from under it.
  const stale = new Date(now.getTime() - PREPARED_GRACE_MS);
  const waiting = await db
    .select()
    .from(rentals)
    .where(
      and(
        inArray(rentals.status, ["prepared", "submitted"]),
        sql`(${rentals.status} = 'submitted' or ${rentals.createdAt} < ${stale.toISOString()})`,
      ),
    );
  const result: SweepResult = { confirmed: [], expired: [] };
  for (const r of waiting) {
    const landed = (await chain.vaultBalance(r.agentId)) !== null;
    if (landed) {
      await confirmRental(db, r.id, r.signature);
      result.confirmed.push(r.id);
      continue;
    }
    if (r.lastValidBlockHeight > 0 && !(await chain.blockHeightPassed(r.lastValidBlockHeight))) continue;
    await expireRental(db, r.id, r.status === "submitted" ? "the transaction never landed" : "never signed");
    result.expired.push(r.id);
  }
  return result;
}

/** How long a prepared rental waits for a signature before it is given up on. */
export const PREPARED_GRACE_MS = 15 * 60 * 1000;

