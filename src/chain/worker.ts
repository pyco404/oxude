import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { balancesOf } from "../db/ledger.js";
import { agents, chainOps, type ChainOpRow } from "../db/schema.js";

/**
 * Drains the outbox into the settlement program, strictly in order.
 *
 * Order matters: an agent's vault must open before its first settlement, and
 * settlements must land in the order the ledger recorded them or a vault could
 * briefly be asked to pay money it has not received yet. So the worker stops at
 * the first op it cannot complete and tries again from there next time, rather
 * than skipping ahead.
 *
 * Every op is idempotent against the chain: if a previous attempt landed but
 * its confirmation was lost, the vault or the settlement record already exists,
 * and the op is marked confirmed instead of being sent again.
 */

export type ChainPort = {
  openVault(agentId: string, amount: number): Promise<string>;
  settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }): Promise<string>;
  hasVault(agentId: string): Promise<boolean>;
  isSettled(matchId: string): Promise<boolean>;
  vaultBalance(agentId: string): Promise<number | null>;
};

export type DrainResult = { confirmed: number; alreadyOnChain: number; stoppedAt: ChainOpRow | null; error: string | null };

async function alreadyDone(chain: ChainPort, op: ChainOpRow): Promise<boolean> {
  if (op.kind === "open_vault") return chain.hasVault(op.agentId!);
  return chain.isSettled(op.matchId!);
}

async function submit(chain: ChainPort, op: ChainOpRow): Promise<string> {
  if (op.kind === "open_vault") return chain.openVault(op.agentId!, op.amount);
  return chain.settle({ matchId: op.matchId!, fromAgent: op.fromAgent!, toAgent: op.toAgent!, amount: op.amount });
}

export async function drainChainOps(db: Db, chain: ChainPort, options: { limit?: number } = {}): Promise<DrainResult> {
  const pending = await db
    .select()
    .from(chainOps)
    .where(eq(chainOps.status, "pending"))
    .orderBy(asc(chainOps.seq))
    .limit(options.limit ?? 100);

  const result: DrainResult = { confirmed: 0, alreadyOnChain: 0, stoppedAt: null, error: null };
  for (const op of pending) {
    try {
      if (await alreadyDone(chain, op)) {
        await db
          .update(chainOps)
          .set({ status: "confirmed", updatedAt: new Date() })
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
      result.stoppedAt = op;
      result.error = message;
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
      options.onPass?.({ confirmed: 0, alreadyOnChain: 0, stoppedAt: null, error: String(error) });
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
