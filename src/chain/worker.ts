import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { SeedOpenVaultInput } from "./seed-settlement.js";
import { balancesOf } from "../db/ledger.js";
import { agents, chainOps, withdrawals, type ChainOpRow } from "../db/schema.js";
import { expireWithdrawal, markWithdrawn } from "../db/withdrawals.js";

/**
 * Drains the outbox into the settlement program, in order.
 *
 * Order matters: an agent's vault must open before its first settlement, and
 * settlements should land in the order the ledger recorded them. The worker
 * sends ops in that order. When the chain is unreachable it stops at the first
 * op it cannot send and starts from there next time. When the program refuses
 * an op - a vault that has paid out its limit for this window, or one that
 * can't yet cover a payment still queued behind that - the op waits for the
 * next pass and the rest carry on, so one throttled vault doesn't hold up
 * everyone else. That is safe because the program checks every balance itself:
 * an op that overtook one it depends on is refused too, and lands later.
 *
 * Every op is idempotent against the chain: if a previous attempt landed but
 * its confirmation was lost, the vault or the settlement record already exists,
 * and the op is marked confirmed instead of being sent again.
 */

export type ChainPort = {
  openVault(input: SeedOpenVaultInput): Promise<string>;
  settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }): Promise<string>;
  hasVault(agentId: string): Promise<boolean>;
  isSettled(matchId: string): Promise<boolean>;
  vaultBalance(agentId: string): Promise<number | null>;
  ownerOf(agentId: string): Promise<string | null>;
  submitWithdrawal(raw: Uint8Array, lastValidBlockHeight: number): Promise<string>;
  isWithdrawn(withdrawalId: string): Promise<boolean>;
  /** True once no transaction with this last valid block height can land any more. */
  blockHeightPassed(lastValidBlockHeight: number): Promise<boolean>;
  /** Recovers the signature of a settlement that landed while its confirmation was lost. */
  settlementSignature?(matchId: string): Promise<string | null>;
};

export type DrainResult = {
  confirmed: number;
  alreadyOnChain: number;
  /** Refused by the program this pass (a rate limit, say); tried again next pass. */
  deferred: number;
  stoppedAt: ChainOpRow | null;
  error: string | null;
};

async function alreadyDone(chain: ChainPort, op: ChainOpRow): Promise<boolean> {
  if (op.kind === "open_vault") return chain.hasVault(op.agentId!);
  if (op.kind === "register_owner") return (await chain.ownerOf(op.agentId!)) !== null;
  return chain.isSettled(op.matchId!);
}

async function submit(chain: ChainPort, op: ChainOpRow): Promise<string> {
  if (op.kind === "open_vault") return chain.openVault({ agentId: op.agentId!, owner: op.owner, salt: op.salt!, amount: op.amount });
  return chain.settle({ matchId: op.matchId!, fromAgent: op.fromAgent!, toAgent: op.toAgent!, amount: op.amount });
}

/**
 * Why this op can never be sent, if so.
 *
 * The first two are ops queued by an older version of the server: the program
 * now opens vaults only under an id derived from an owner and salt, and records
 * the owner as it does, so there is no instruction left to send them to. The
 * third follows from the first: a settlement needs both vaults, and a vault
 * whose op has failed can never be opened, because its agent's id does not
 * derive from anything the program would accept.
 *
 * They are marked failed rather than retried for ever, so they neither hold up
 * the queue nor churn against the chain on every pass. The ledger is
 * unaffected - it is authoritative - and `reconcile` reports the agents whose
 * vaults now disagree with it.
 */
function unsendable(op: ChainOpRow, vaultless: ReadonlySet<string>): string | null {
  if (op.kind === "open_vault" && !op.salt) return "queued before ids were derived from owners: it has no salt, so no vault can be opened under it";
  if (op.kind === "register_owner") return "owners are recorded as their vault opens; register_owner is no longer an instruction";
  if (op.kind === "settle") {
    const missing = [op.fromAgent, op.toAgent].filter((id) => id && vaultless.has(id));
    if (missing.length > 0) return `its vault${missing.length > 1 ? "s" : ""} can never open, so this can never settle on chain`;
  }
  return null;
}

/** Agents whose vault op failed for good: nothing involving them can reach the chain. */
async function vaultlessAgents(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ agentId: chainOps.agentId })
    .from(chainOps)
    .where(and(eq(chainOps.kind, "open_vault"), eq(chainOps.status, "failed")));
  return new Set(rows.map((r) => r.agentId!).filter(Boolean));
}

/** A refusal the program will give again on any retry: retrying is pointless. */
const refusedByProgram = (message: string) => /Error Code:|custom program error/i.test(message);

/**
 * A withdrawal's op: send the owner-signed transaction (the same bytes as ever,
 * so sending twice is harmless, and the program pays a withdrawal once). Done
 * when its record exists on chain. If it can never land - the blockhash has
 * expired unsent, or the program refused it - the ledger is put back, and the
 * queue moves on rather than blocking every settlement behind it.
 */
async function settleWithdrawal(db: Db, chain: ChainPort, op: ChainOpRow): Promise<"done" | "expired" | "retry"> {
  const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, op.withdrawalId!)).limit(1);
  if (!w || !w.signedTx) {
    await expireWithdrawal(db, op.withdrawalId!, "no signed transaction on record");
    return "expired";
  }
  if (await chain.isWithdrawn(w.id)) {
    await markWithdrawn(db, w.id, w.signature);
    return "done";
  }
  try {
    const signature = await chain.submitWithdrawal(Buffer.from(w.signedTx, "base64"), w.lastValidBlockHeight);
    await markWithdrawn(db, w.id, signature);
    return "done";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await chain.isWithdrawn(w.id)) {
      await markWithdrawn(db, w.id, null);
      return "done";
    }
    if (refusedByProgram(message) || (await chain.blockHeightPassed(w.lastValidBlockHeight))) {
      await expireWithdrawal(db, w.id, message);
      return "expired";
    }
    throw error;
  }
}

export async function drainChainOps(db: Db, chain: ChainPort, options: { limit?: number } = {}): Promise<DrainResult> {
  const pending = await db
    .select()
    .from(chainOps)
    .where(eq(chainOps.status, "pending"))
    .orderBy(asc(chainOps.seq))
    .limit(options.limit ?? 100);

  const vaultless = await vaultlessAgents(db);
  const result: DrainResult = { confirmed: 0, alreadyOnChain: 0, deferred: 0, stoppedAt: null, error: null };
  for (const op of pending) {
    try {
      if (op.kind === "withdraw") {
        const outcome = await settleWithdrawal(db, chain, op);
        if (outcome === "done") result.confirmed++;
        continue;
      }
      const dead = unsendable(op, vaultless);
      if (dead && !(await alreadyDone(chain, op))) {
        await db.update(chainOps).set({ status: "failed", lastError: dead, updatedAt: new Date() }).where(eq(chainOps.id, op.id));
        // A vault that never opened makes every later settlement for that agent dead too.
        if (op.kind === "open_vault") vaultless.add(op.agentId!);
        result.error ??= dead;
        result.deferred++;
        continue;
      }
      if (await alreadyDone(chain, op)) {
        // Without the signature the match page cannot link the transaction.
        const signature =
          op.kind === "settle" && chain.settlementSignature ? await chain.settlementSignature(op.matchId!) : null;
        await db
          .update(chainOps)
          .set({ status: "confirmed", signature, updatedAt: new Date() })
          .where(eq(chainOps.id, op.id));
        result.alreadyOnChain++;
        continue;
      }
      const signature = await submit(chain, op);
      await db
        .update(chainOps)
        .set({ status: "confirmed", signature, attempts: op.attempts + 1, lastError: null, updatedAt: new Date() })
        .where(eq(chainOps.id, op.id));
      result.confirmed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(chainOps)
        .set({ attempts: op.attempts + 1, lastError: message.slice(0, 2000), updatedAt: new Date() })
        .where(eq(chainOps.id, op.id));
      result.error ??= message;
      if (refusedByProgram(message)) {
        result.deferred++;
        continue;
      }
      result.stoppedAt = op;
      break;
    }
  }
  return result;
}

export type Mismatch = { agentId: string; name: string; ledger: number; chain: number | null };

/**
 * Compares each agent's vault with its ledger balance, for agents whose ops
 * have all been confirmed. The ledger is authoritative; a mismatch is a bug to
 * investigate, never something to "fix" by overwriting either side.
 */
export async function reconcile(db: Db, chain: ChainPort): Promise<{ checked: number; mismatches: Mismatch[] }> {
  const involved = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        sql`exists (select 1 from ${chainOps} where ${chainOps.agentId} = ${agents.id} and ${chainOps.kind} = 'open_vault' and ${chainOps.status} = 'confirmed')`,
        sql`not exists (select 1 from ${chainOps} where ${chainOps.status} <> 'confirmed' and (${chainOps.agentId} = ${agents.id} or ${chainOps.fromAgent} = ${agents.id} or ${chainOps.toAgent} = ${agents.id}))`,
      ),
    );

  const balances = await balancesOf(
    db,
    involved.map((a) => a.id),
  );
  const mismatches: Mismatch[] = [];
  for (const agent of involved) {
    const onChain = await chain.vaultBalance(agent.id);
    const ledger = balances.get(agent.id) ?? 0;
    if (onChain !== ledger) mismatches.push({ agentId: agent.id, name: agent.name, ledger, chain: onChain });
  }
  return { checked: involved.length, mismatches };
}

/**
 * Keeps draining the outbox on an interval. One drain at a time: a slow chain
 * delays the next pass rather than stacking overlapping ones.
 */
export function startChainWorker(
  db: Db,
  chain: ChainPort,
  options: { intervalMs?: number; onPass?: (result: DrainResult) => void } = {},
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async () => {
    if (stopped) return;
    try {
      const result = await drainChainOps(db, chain);
      options.onPass?.(result);
    } catch (error) {
      options.onPass?.({ confirmed: 0, alreadyOnChain: 0, deferred: 0, stoppedAt: null, error: String(error) });
    }
    if (!stopped) timer = setTimeout(() => void pass(), options.intervalMs ?? 5_000);
  };
  void pass();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** What the chain has recorded for one match, for the transcript and share page. */
export async function settlementStatus(db: Db, matchId: string) {
  const [op] = await db
    .select({ status: chainOps.status, signature: chainOps.signature, amount: chainOps.amount })
    .from(chainOps)
    .where(and(eq(chainOps.kind, "settle"), eq(chainOps.matchId, matchId)))
    .limit(1);
  return op ?? null;
}
