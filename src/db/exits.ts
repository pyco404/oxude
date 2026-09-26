import { eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { recordEvent } from "./events.js";
import { balanceOf, record } from "./ledger.js";
import { agents, exits } from "./schema.js";
import type { ChainExit } from "../chain/settlement.js";

/**
 * Exits, as the server learns about them: from the chain, afterwards.
 *
 * Every other money path here writes the ledger first and lets the chain catch
 * up. This one cannot. An exit is signed by the owner alone and needs nothing
 * from this server, so the chain moves first and the ledger follows - and the
 * whole of the design is about surviving the gap between the two
 * (docs/non-custodial-exit.md).
 *
 * Two things arrive here. A **request** starts a thirty-minute clock and is
 * the moment the agent must stop playing: it moves no money, so nothing else
 * in this system would ever notice it. A **claim** takes the money, and the
 * ledger has to be told.
 */

/** An agent with a live exit: one requested, or claimed and not yet absorbed. */
export const exitingSql = sql`exists (select 1 from ${exits} where ${exits.agentId} = ${agents.id} and ${exits.ingestedAt} is null)`;

/**
 * Whether this agent is mid-exit and must not play.
 *
 * True from the moment a request is seen until the claim has been absorbed -
 * which is the same window the safety argument rests on. An agent frozen at
 * request time has not been matchable for half an hour by the time its claim
 * lands, so the gap between the claim and the ledger catching up is not a gap
 * anything can be staked in.
 */
export async function isExiting(db: Db, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: exits.agentId })
    .from(exits)
    .where(sql`${exits.agentId} = ${agentId} and ${exits.ingestedAt} is null`)
    .limit(1);
  return row !== undefined;
}

export type ExitPass = {
  /** Agents told to stop playing, because a request appeared. */
  frozen: string[];
  /** Claims the ledger has now absorbed. */
  ingested: { agentId: string; amount: number; retired: boolean }[];
  /** Exits that vanished from the chain: cancelled by their owner, or closed. */
  cleared: string[];
};

/**
 * One pass: read every exit the program holds and make the ledger agree with
 * it.
 *
 * Written so that running it late, running it twice, or dying halfway through
 * are all harmless, because it is the only thing standing between a claim and
 * a ledger that never hears about it. Each claim is absorbed inside one
 * transaction with the row that says it was, so a crash between the two is not
 * possible; and the row is keyed on the claim's own slot, so a second pass
 * over the same claim does nothing.
 */
export async function ingestExits(db: Db, onChain: ChainExit[], now = new Date()): Promise<ExitPass> {
  const pass: ExitPass = { frozen: [], ingested: [], cleared: [] };
  const local = await db.select().from(exits);
  const byAgent = new Map(local.map((r) => [r.agentId, r]));
  const seen = new Set<string>();

  for (const e of onChain) {
    seen.add(e.agentId);
    const [agent] = await db.select().from(agents).where(eq(agents.id, e.agentId)).limit(1);
    // An exit for an agent this server has never heard of. Possible: the id is
    // derived from the owner's key, so a wallet can open a vault we did not
    // rent. Nothing to freeze and nothing to debit.
    if (!agent) continue;
    const row = byAgent.get(e.agentId);

    // A new request, or a later one reusing the same address. Both mean: stop
    // playing, and forget whatever the old row said.
    const isNew = !row || row.requestedSlot !== e.requestedSlot;
    if (isNew) {
      await db
        .insert(exits)
        .values({
          agentId: e.agentId,
          requestedSlot: e.requestedSlot,
          unlockSlot: e.unlockSlot,
          amount: e.amount,
          claimedSlot: e.claimedSlot === 0 ? null : e.claimedSlot,
          claimedAmount: e.claimedSlot === 0 ? null : e.claimedAmount,
          ingestedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: exits.agentId,
          set: {
            requestedSlot: e.requestedSlot,
            unlockSlot: e.unlockSlot,
            amount: e.amount,
            claimedSlot: e.claimedSlot === 0 ? null : e.claimedSlot,
            claimedAmount: e.claimedSlot === 0 ? null : e.claimedAmount,
            ingestedAt: null,
            updatedAt: now,
          },
        });
      // Autoplay stops here rather than being left to fail every ten minutes.
      if (agent.autoplay) {
        await db
          .update(agents)
          .set({ autoplay: false, autoplayStoppedReason: "exit", autoplayStoppedAt: now })
          .where(eq(agents.id, e.agentId));
      }
      await recordEvent(db, e.agentId, "exit-requested", "exit", `unlocks at slot ${e.unlockSlot}`);
      pass.frozen.push(e.agentId);
    } else if (e.claimedSlot !== 0 && row.claimedSlot !== e.claimedSlot) {
      await db
        .update(exits)
        .set({ claimedSlot: e.claimedSlot, claimedAmount: e.claimedAmount, ingestedAt: null, updatedAt: now })
        .where(eq(exits.agentId, e.agentId));
    }

    // Absorb the claim, if there is one this server has not taken account of.
    const current = isNew ? null : row;
    const absorbed = current?.ingestedAt !== null && current?.claimedSlot === e.claimedSlot;
    if (e.claimedSlot !== 0 && !absorbed) {
      const outcome = await absorbClaim(db, e, now);
      if (outcome) pass.ingested.push(outcome);
    }
  }

  // Gone from the chain: cancelled before a claim, or closed after one. Either
  // way this server has nothing left to wait for, and the agent is free.
  for (const row of local) {
    if (seen.has(row.agentId)) continue;
    // Unless it was claimed and never absorbed - dropping that row would lose
    // the only record that the ledger still owes a debit.
    if (row.claimedSlot !== null && row.ingestedAt === null) continue;
    await db.delete(exits).where(eq(exits.agentId, row.agentId));
    if (row.claimedSlot === null) {
      await recordEvent(db, row.agentId, "exit-cancelled", "exit", "the exit was closed before it was claimed");
    }
    pass.cleared.push(row.agentId);
  }
  return pass;
}

/**
 * Takes a claim off the ledger, in one transaction with the record that says
 * it has been taken off.
 *
 * Setting `ingestedAt` is also what unfreezes the agent, which is why it
 * happens here and not at the claim: until this runs, the ledger still thinks
 * the money is there, and an agent let back in would stake against it.
 */
async function absorbClaim(
  db: Db,
  e: ChainExit,
  now: Date,
): Promise<{ agentId: string; amount: number; retired: boolean } | null> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // The agent's row is locked first, so nothing can record a match against
    // the balance this is about to reduce.
    await tx.execute(sql`select id from ${agents} where ${agents.id} = ${e.agentId} for update`);
    const [row] = await tx.select().from(exits).where(eq(exits.agentId, e.agentId)).limit(1);
    // Someone else's pass got here first.
    if (row?.ingestedAt !== null && row?.claimedSlot === e.claimedSlot) return null;

    const before = await balanceOf(t, e.agentId);
    // Never below zero. The chain paid what the vault held; if the ledger
    // somehow says less, the difference is a separate problem and the
    // reconciler is the thing that should be shouting about it, not this.
    const amount = Math.min(e.claimedAmount, Math.max(0, before));
    if (amount > 0) await record(t, [{ agentId: e.agentId, amount: -amount, reason: "exit" }]);

    const [agent] = await tx.select().from(agents).where(eq(agents.id, e.agentId)).limit(1);
    const emptied = before - amount <= 0;
    const retired = emptied && agent?.retiredAt === null;
    if (retired) {
      await tx.update(agents).set({ retiredAt: now, retiredReason: "withdrawn" }).where(eq(agents.id, e.agentId));
    }
    await recordEvent(
      t,
      e.agentId,
      "exit-claimed",
      "exit",
      `${amount} taken by its owner without the server co-signing${retired ? ", emptying the vault" : ""}`,
    );

    await tx
      .update(exits)
      .set({ claimedSlot: e.claimedSlot, claimedAmount: e.claimedAmount, ingestedAt: now, updatedAt: now })
      .where(eq(exits.agentId, e.agentId));
    return { agentId: e.agentId, amount, retired };
  });
}

/** Agents frozen by a live exit, for the views that need to say why. */
export async function exitingAgents(db: Db): Promise<string[]> {
  const rows = await db.select({ id: exits.agentId }).from(exits).where(isNull(exits.ingestedAt));
  return rows.map((r) => r.id);
}
