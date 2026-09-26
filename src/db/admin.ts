import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agents, chainOps, deposits, matches, rentals, withdrawals } from "./schema.js";
import { chips, DEVNET_CHIP_RATE } from "../chips.js";

/**
 * The numbers an operator needs, read from where they already live.
 *
 * Nothing here measures anything new. The settlement lag, the reconciler and
 * the season statement each already know their piece; this is the query layer
 * for the parts that were only ever reachable from a worker pass or a log
 * line, so that one page can show them together.
 */

/** An op worth looking at: it failed, or it has been waiting long enough to be stuck. */
export type OpTrouble = {
  id: string;
  seq: number;
  kind: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  amount: number;
  attempts: number;
  lastError: string | null;
  ageMs: number;
  createdAt: Date;
};

/**
 * Ops that failed, and ops still pending past `stuckAfterMs`.
 *
 * The two are different problems and the page shows them apart. A failed op
 * has been given up on: the worker decided it can never land, and somebody has
 * to decide what to do about it. A stuck one is still being retried, which
 * usually means the program keeps refusing it - a throttled vault, or a
 * settlement the vault can no longer cover.
 */
export async function troubledOps(db: Db, stuckAfterMs = 15 * 60_000, now = new Date()): Promise<{
  failed: OpTrouble[];
  stuck: OpTrouble[];
}> {
  const cutoff = new Date(now.getTime() - stuckAfterMs);
  const rows = await db
    .select({
      id: chainOps.id,
      seq: chainOps.seq,
      kind: chainOps.kind,
      status: chainOps.status,
      agentId: chainOps.agentId,
      fromAgent: chainOps.fromAgent,
      amount: chainOps.amount,
      attempts: chainOps.attempts,
      lastError: chainOps.lastError,
      createdAt: chainOps.createdAt,
      name: agents.name,
    })
    .from(chainOps)
    .leftJoin(agents, eq(agents.id, sql`coalesce(${chainOps.agentId}, ${chainOps.fromAgent})`))
    .where(
      sql`${chainOps.status} = 'failed' or (${chainOps.status} = 'pending' and ${chainOps.createdAt} < ${cutoff})`,
    )
    .orderBy(desc(chainOps.createdAt))
    .limit(100);

  const shape = (r: (typeof rows)[number]): OpTrouble => ({
    id: r.id,
    seq: Number(r.seq),
    kind: r.kind,
    status: r.status,
    agentId: r.agentId ?? r.fromAgent,
    agentName: r.name,
    amount: Number(r.amount),
    attempts: r.attempts,
    lastError: r.lastError,
    ageMs: now.getTime() - r.createdAt.getTime(),
    createdAt: r.createdAt,
  });
  return {
    failed: rows.filter((r) => r.status === "failed").map(shape),
    stuck: rows.filter((r) => r.status === "pending").map(shape),
  };
}

/** The oldest op still waiting, which is what the lag figure is measuring. */
export async function oldestPending(db: Db, now = new Date()): Promise<OpTrouble | null> {
  const [r] = await db
    .select({
      id: chainOps.id,
      seq: chainOps.seq,
      kind: chainOps.kind,
      status: chainOps.status,
      agentId: chainOps.agentId,
      fromAgent: chainOps.fromAgent,
      amount: chainOps.amount,
      attempts: chainOps.attempts,
      lastError: chainOps.lastError,
      createdAt: chainOps.createdAt,
      name: agents.name,
    })
    .from(chainOps)
    .leftJoin(agents, eq(agents.id, sql`coalesce(${chainOps.agentId}, ${chainOps.fromAgent})`))
    .where(eq(chainOps.status, "pending"))
    .orderBy(chainOps.createdAt)
    .limit(1);
  if (!r) return null;
  return {
    id: r.id,
    seq: Number(r.seq),
    kind: r.kind,
    status: r.status,
    agentId: r.agentId ?? r.fromAgent,
    agentName: r.name,
    amount: Number(r.amount),
    attempts: r.attempts,
    lastError: r.lastError,
    ageMs: now.getTime() - r.createdAt.getTime(),
    createdAt: r.createdAt,
  };
}

export type Volume = {
  agents: { active: number; retired: number; house: number };
  deposits: { confirmed: number; chips: number; pending: number };
  withdrawals: { confirmed: number; chips: number; pending: number };
  rentals: { confirmed: number; burnedChips: number; pending: number };
  matches: { staked: number; ranked: number; exhibitions: number; last24h: number };
};

/**
 * The volume numbers, under the health ones because they are the ones you read
 * when nothing is wrong.
 *
 * Amounts are converted to chips at the deposit rate: rentals, deposits and
 * withdrawals all belong to the deposit flow, which is the only flow that ever
 * charged rent or took a deposit.
 */
export async function volume(db: Db, now = new Date()): Promise<Volume> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const [a] = await db
    .select({
      active: sql<number>`count(*) filter (where ${agents.ownerId} is not null and ${agents.retiredAt} is null)::int`,
      retired: sql<number>`count(*) filter (where ${agents.retiredAt} is not null)::int`,
      house: sql<number>`count(*) filter (where ${agents.ownerId} is null)::int`,
    })
    .from(agents);

  const [d] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${deposits.status} = 'confirmed')::int`,
      amount: sql<number>`coalesce(sum(${deposits.amount}) filter (where ${deposits.status} = 'confirmed'), 0)::bigint`,
      pending: sql<number>`count(*) filter (where ${deposits.status} in ('prepared', 'submitted'))::int`,
    })
    .from(deposits);

  const [w] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${withdrawals.status} = 'confirmed')::int`,
      amount: sql<number>`coalesce(sum(${withdrawals.amount}) filter (where ${withdrawals.status} = 'confirmed'), 0)::bigint`,
      pending: sql<number>`count(*) filter (where ${withdrawals.status} in ('prepared', 'submitted'))::int`,
    })
    .from(withdrawals);

  const [r] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${rentals.status} = 'confirmed')::int`,
      fee: sql<number>`coalesce(sum(${rentals.fee}) filter (where ${rentals.status} = 'confirmed'), 0)::bigint`,
      pending: sql<number>`count(*) filter (where ${rentals.status} in ('prepared', 'submitted'))::int`,
    })
    .from(rentals);

  const [m] = await db
    .select({
      staked: sql<number>`count(*) filter (where not ${matches.exhibition})::int`,
      ranked: sql<number>`count(*) filter (where ${matches.ranked})::int`,
      exhibitions: sql<number>`count(*) filter (where ${matches.exhibition})::int`,
      last24h: sql<number>`count(*) filter (where ${matches.createdAt} >= ${dayAgo})::int`,
    })
    .from(matches);

  const rate = DEVNET_CHIP_RATE;
  return {
    agents: { active: Number(a?.active ?? 0), retired: Number(a?.retired ?? 0), house: Number(a?.house ?? 0) },
    deposits: {
      confirmed: Number(d?.confirmed ?? 0),
      chips: chips(Number(d?.amount ?? 0), rate),
      pending: Number(d?.pending ?? 0),
    },
    withdrawals: {
      confirmed: Number(w?.confirmed ?? 0),
      chips: chips(Number(w?.amount ?? 0), rate),
      pending: Number(w?.pending ?? 0),
    },
    rentals: {
      confirmed: Number(r?.confirmed ?? 0),
      burnedChips: chips(Number(r?.fee ?? 0), rate),
      pending: Number(r?.pending ?? 0),
    },
    matches: {
      staked: Number(m?.staked ?? 0),
      ranked: Number(m?.ranked ?? 0),
      exhibitions: Number(m?.exhibitions ?? 0),
      last24h: Number(m?.last24h ?? 0),
    },
  };
}
