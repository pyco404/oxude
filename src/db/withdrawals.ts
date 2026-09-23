import { Transaction } from "@solana/web3.js";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { PreparedWithdrawal } from "../chain/common.js";
import type { Db } from "./client.js";
import { balanceOf, record } from "./ledger.js";
import { agents, chainOps, STAKE_BANDS, withdrawals, type WithdrawalStatus } from "./schema.js";

/**
 * The least a vault can be left with and still be worth keeping: the cheapest
 * band's worst match. Below this no band is affordable, which is exactly the
 * point at which an agent retires, so leaving less would strand it holding
 * money it can never play. Comfortably above the program's own MIN_STAKE of 10,
 * which only asks that a vault be left empty or non-trivial.
 */
const MIN_TO_KEEP_PLAYING = Math.min(...STAKE_BANDS.map((b) => b.worstMatch));

/**
 * Withdrawals from an agent's vault to its owner.
 *
 * The ledger stays authoritative. A withdrawal is prepared (the server builds
 * the transaction and the settler co-signs it), signed by the owner, and only
 * then recorded: the ledger row, the outbox row and, for the lot, the agent's
 * retirement, in one database transaction. The program checks everything that
 * matters again on chain - the owner, the co-signature, that the vault matches
 * the ledger, that it's left empty or playable, and that the withdrawal pays
 * once.
 */

/** What the server needs from the chain to prepare and send a withdrawal. */
export type WithdrawalChain = {
  prepareWithdrawal(input: {
    withdrawalId: string;
    agentId: string;
    owner: string;
    amount: number;
    remaining: number;
  }): Promise<PreparedWithdrawal>;
  submitWithdrawal(raw: Uint8Array, lastValidBlockHeight: number): Promise<string>;
};

export class WithdrawalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Ops that touch this agent and haven't landed on chain yet. */
async function unsettledOps(db: Db, agentId: string) {
  return db
    .select({ kind: chainOps.kind, amount: chainOps.amount, fromAgent: chainOps.fromAgent, toAgent: chainOps.toAgent })
    .from(chainOps)
    .where(
      and(
        eq(chainOps.status, "pending"),
        or(eq(chainOps.agentId, agentId), eq(chainOps.fromAgent, agentId), eq(chainOps.toAgent, agentId)),
      ),
    );
}

/** A withdrawal submitted and not yet landed or expired: the agent is spoken for until it resolves. */
export async function openWithdrawal(db: Db, agentId: string) {
  const [row] = await db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.agentId, agentId), eq(withdrawals.status, "submitted")))
    .limit(1);
  return row ?? null;
}

/** Its owner is on chain: recorded as its vault opened, or, for agents from before that, on its own. */
async function ownerRegistered(db: Db, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chainOps.id })
    .from(chainOps)
    .where(
      and(
        eq(chainOps.agentId, agentId),
        eq(chainOps.status, "confirmed"),
        or(and(eq(chainOps.kind, "open_vault"), isNotNull(chainOps.owner)), eq(chainOps.kind, "register_owner")),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export type Withdrawable = {
  balance: number;
  /** What can be taken right now. */
  withdrawable: number;
  /** Chips still moving on chain in settlements, and so not yet withdrawable. */
  locked: number;
  /** The largest partial withdrawal, leaving the minimum stake to play on. */
  maxPartial: number;
  minStake: number;
  /** Why nothing can be taken right now, if so. */
  reason: string | null;
};

/** What the owner can take now, and what is locked while matches settle. */
export async function withdrawable(db: Db, agentId: string): Promise<Withdrawable> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw new WithdrawalError(404, "no such agent");
  const balance = await balanceOf(db, agentId);
  const pending = await unsettledOps(db, agentId);
  const locked = pending.filter((op) => op.kind === "settle").reduce((sum, op) => sum + op.amount, 0);
  let reason: string | null = null;
  // A lapsed agent retired because its rental ran out, not because its money
  // did: the balance is still the owner's, and taking all of it is the one
  // thing left to do with it.
  const lapsed = agent.retiredReason === "lapsed";
  if (agent.retiredAt !== null && !lapsed) reason = "this agent is retired";
  else if (!agent.ownerId) reason = "house agents have no owner";
  else if (await openWithdrawal(db, agentId)) reason = "a withdrawal is already on its way";
  else if (pending.some((op) => op.kind === "settle")) reason = "a match is still settling on chain";
  else if (pending.length > 0 || !(await ownerRegistered(db, agentId))) reason = "the vault is still being set up on chain";
  else if (balance <= 0) reason = "nothing to withdraw";
  const available = reason ? 0 : balance;
  return {
    balance,
    withdrawable: available,
    locked,
    // A lapsed agent cannot play again, so there is nothing to keep playing on: all or nothing.
    maxPartial: !lapsed && available >= MIN_TO_KEEP_PLAYING ? available - MIN_TO_KEEP_PLAYING : 0,
    minStake: MIN_TO_KEEP_PLAYING,
    reason,
  };
}

/**
 * Builds a withdrawal for the owner to sign. `amount: "all"` takes the lot and
 * retires the agent; otherwise it must leave at least the minimum stake.
 */
export async function prepareWithdrawal(
  db: Db,
  chain: WithdrawalChain,
  input: { agentId: string; ownerId: string; amount: number | "all" },
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  if (!agent) throw new WithdrawalError(404, "no such agent");
  if (agent.ownerId !== input.ownerId) throw new WithdrawalError(403, "that agent belongs to someone else");
  const state = await withdrawable(db, input.agentId);
  if (state.reason) throw new WithdrawalError(409, `can't withdraw now: ${state.reason}`);

  const amount: number = input.amount === "all" ? state.balance : input.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new WithdrawalError(400, "amount must be a whole number above zero");
  if (amount > state.balance) throw new WithdrawalError(400, `only ${state.balance} to withdraw`);
  const remaining = state.balance - amount;
  if (remaining !== 0 && agent.retiredReason === "lapsed") {
    throw new WithdrawalError(400, "this agent's rental has lapsed: withdraw the whole balance");
  }
  if (remaining !== 0 && remaining < MIN_TO_KEEP_PLAYING) {
    throw new WithdrawalError(
      400,
      `that would leave ${remaining}, too little to play a match in any band: take it all and retire, or leave at least ${MIN_TO_KEEP_PLAYING}`,
    );
  }

  const [row] = await db
    .insert(withdrawals)
    .values({
      agentId: input.agentId,
      ownerId: input.ownerId,
      amount,
      remaining,
      retire: remaining === 0,
      preparedTx: "",
      lastValidBlockHeight: 0,
    })
    .returning();
  const prepared = await chain.prepareWithdrawal({
    withdrawalId: row!.id,
    agentId: input.agentId,
    owner: input.ownerId,
    amount,
    remaining,
  });
  const preparedTx = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  await db
    .update(withdrawals)
    .set({ preparedTx, lastValidBlockHeight: prepared.lastValidBlockHeight, updatedAt: new Date() })
    .where(eq(withdrawals.id, row!.id));
  return { withdrawalId: row!.id, amount, remaining, retire: remaining === 0, transaction: preparedTx };
}

/**
 * Takes the owner-signed transaction, checks it is exactly what was prepared
 * and properly signed, records it, and sends it. The ledger row, the outbox
 * row and any retirement are written together; the chain follows.
 */
export async function submitWithdrawal(
  db: Db,
  chain: WithdrawalChain,
  input: { withdrawalId: string; ownerId: string; signedTx: string },
): Promise<{ status: WithdrawalStatus; signature: string | null }> {
  const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
  if (!w) throw new WithdrawalError(404, "no such withdrawal");
  if (w.ownerId !== input.ownerId) throw new WithdrawalError(403, "that withdrawal belongs to someone else");
  if (w.status !== "prepared") throw new WithdrawalError(409, `this withdrawal is already ${w.status}`);

  let signed: Transaction;
  try {
    signed = Transaction.from(Buffer.from(input.signedTx, "base64"));
  } catch {
    throw new WithdrawalError(400, "not a transaction");
  }
  const prepared = Transaction.from(Buffer.from(w.preparedTx, "base64"));
  // Exactly what was prepared - same instructions, accounts, amount, blockhash - and every signature valid.
  if (!signed.serializeMessage().equals(prepared.serializeMessage())) {
    throw new WithdrawalError(400, "that transaction isn't the one prepared for this withdrawal");
  }
  if (!signed.verifySignatures()) throw new WithdrawalError(400, "the transaction isn't fully signed");

  await db.transaction(async (tx) => {
    // Claim it: of two submissions of the same withdrawal, only one gets past here.
    const claimed = await tx
      .update(withdrawals)
      .set({ status: "submitted", signedTx: input.signedTx, updatedAt: new Date() })
      .where(and(eq(withdrawals.id, w.id), eq(withdrawals.status, "prepared")))
      .returning({ id: withdrawals.id });
    if (claimed.length === 0) throw new WithdrawalError(409, "this withdrawal was already submitted");
    // Serialise against matches for this agent: nothing moves its balance while this runs.
    await tx.execute(sql`select id from ${agents} where ${agents.id} = ${w.agentId} for update`);
    const balance = await balanceOf(tx as unknown as Db, w.agentId);
    if (balance !== w.amount + w.remaining) {
      throw new WithdrawalError(409, "the balance changed since this was prepared: prepare it again");
    }
    const pending = await unsettledOps(tx as unknown as Db, w.agentId);
    if (pending.length > 0) throw new WithdrawalError(409, "can't withdraw now: a match is still settling on chain");
    const [agent] = await tx
      .select({ retiredAt: agents.retiredAt, retiredReason: agents.retiredReason })
      .from(agents)
      .where(eq(agents.id, w.agentId));
    // A lapsed agent may still be emptied; any other retirement is final.
    if (agent?.retiredAt && agent.retiredReason !== "lapsed") throw new WithdrawalError(409, "this agent is retired");

    await record(tx, [{ agentId: w.agentId, amount: -w.amount, reason: "withdrawal", withdrawalId: w.id }]);
    await tx.insert(chainOps).values({ kind: "withdraw", agentId: w.agentId, amount: w.amount, withdrawalId: w.id });
    // Taking the lot retires it, unless it already retired by lapsing, which
    // stays the reason: the rental ended first, the money followed.
    if (w.retire && !agent?.retiredAt) {
      await tx.update(agents).set({ retiredAt: new Date(), retiredReason: "withdrawn" }).where(eq(agents.id, w.agentId));
    }
  });

  // Send now rather than wait for the worker: the transaction only lives for a minute or two.
  try {
    const signature = await chain.submitWithdrawal(Buffer.from(input.signedTx, "base64"), w.lastValidBlockHeight);
    await markWithdrawn(db, w.id, signature);
    return { status: "confirmed", signature };
  } catch {
    // Not lost: the outbox has it, and the worker either lands it or, once it can never land, puts the ledger back.
    return { status: "submitted", signature: null };
  }
}

/** A withdrawal landed: the withdrawal and its outbox op are done. */
export async function markWithdrawn(db: Db, withdrawalId: string, signature: string | null) {
  await db.transaction(async (tx) => {
    await tx
      .update(withdrawals)
      .set({ status: "confirmed", signature, updatedAt: new Date() })
      .where(and(eq(withdrawals.id, withdrawalId), inArray(withdrawals.status, ["submitted", "confirmed"])));
    await tx
      .update(chainOps)
      .set({ status: "confirmed", signature, updatedAt: new Date() })
      .where(and(eq(chainOps.withdrawalId, withdrawalId), eq(chainOps.kind, "withdraw")));
  });
}

/**
 * A withdrawal that can never land (its blockhash expired unsent, or the
 * program refused it): the ledger is put back and a retirement it caused is
 * undone, in one transaction, so ledger and vault agree again.
 */
export async function expireWithdrawal(db: Db, withdrawalId: string, why: string) {
  await db.transaction(async (tx) => {
    const [w] = await tx.select().from(withdrawals).where(eq(withdrawals.id, withdrawalId)).limit(1);
    if (!w || w.status !== "submitted") return;
    await record(tx, [{ agentId: w.agentId, amount: w.amount, reason: "withdrawal-reversed", withdrawalId: w.id }]);
    // Undo only a retirement this withdrawal caused. If the agent lapsed while
    // the withdrawal was in flight, it stays lapsed: the money coming back does
    // not bring the rental back.
    if (w.retire) {
      await tx
        .update(agents)
        .set({ retiredAt: null, retiredReason: null })
        .where(and(eq(agents.id, w.agentId), eq(agents.retiredReason, "withdrawn")));
    }
    await tx
      .update(withdrawals)
      .set({ status: "expired", error: why.slice(0, 2000), updatedAt: new Date() })
      .where(eq(withdrawals.id, w.id));
    await tx
      .update(chainOps)
      .set({ status: "failed", lastError: why.slice(0, 2000), updatedAt: new Date() })
      .where(and(eq(chainOps.withdrawalId, w.id), eq(chainOps.kind, "withdraw")));
  });
}
