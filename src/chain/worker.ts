import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { SeedOpenVaultInput } from "./seed-settlement.js";
import type { ChainExit } from "./settlement.js";
import { balancesOf, record } from "../db/ledger.js";
import { agents, chainOps, deposits, exits, rentals, withdrawals, type ChainOpRow } from "../db/schema.js";
import type { Funding } from "../chips.js";
import { expireWithdrawal, markWithdrawn } from "../db/withdrawals.js";
import { ingestExits, type ExitPass } from "../db/exits.js";

/**
 * Drains the outbox into the settlement program, in order.
 *
 * There are two programs while the funding flows run side by side, and an op
 * has to reach the one that holds its agent's vault. A vault is a token account
 * for one mint under one program, so sending a deposit-funded agent's op to the
 * seed program would not merely fail - it would be asking the wrong program
 * about an account it has never heard of. Which one an op belongs to is decided
 * by the flow its agent was rented under (`agents.funding`), read alongside the
 * op rather than stored on it, because an agent never changes flow.
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

/**
 * The clients to route between, by funding flow. Passing a single ChainPort is
 * shorthand for "everything is the seed flow", which is what every test and
 * every deployment does until the deposit program is live.
 */
export type ChainPorts = { seed: ChainPort; deposit?: ChainPort };

/** Normalises either shape into a lookup, and says when a flow has no client. */
function portsOf(chain: ChainPort | ChainPorts): ChainPorts {
  return "seed" in chain ? chain : { seed: chain };
}

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
  /**
   * An agent's exit as the chain has it. Absent on the seed program, which has
   * no exits: a port without this simply never explains a shortfall, which is
   * the right answer there.
   */
  exitOf?(agentId: string): Promise<ChainExit | null>;
  /** Every exit the program holds. Absent on the seed program, for the same reason. */
  exits?(): Promise<ChainExit[]>;
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

/**
 * The funding flow behind each op, keyed by op id.
 *
 * An op names its agent in one of three columns depending on its kind, so this
 * resolves whichever is set. A settle names two agents, but both are always on
 * the same flow: they share a band and a mint, and a match between different
 * mints could not be staked in the first place - so the paying side decides.
 *
 * An op whose agent cannot be found falls back to the seed flow, which is what
 * every op written before flows existed is.
 */
async function fundingOf(db: Db, ops: readonly ChainOpRow[]): Promise<Map<string, Funding>> {
  const wanted = new Map<string, string>();
  for (const op of ops) {
    const agentId = op.agentId ?? op.fromAgent ?? op.toAgent;
    if (agentId) wanted.set(op.id, agentId);
  }
  const ids = [...new Set(wanted.values())];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: agents.id, funding: agents.funding }).from(agents).where(inArray(agents.id, ids));
  const byAgent = new Map(rows.map((r) => [r.id, r.funding]));
  const byOp = new Map<string, Funding>();
  for (const [opId, agentId] of wanted) byOp.set(opId, byAgent.get(agentId) ?? "seed");
  return byOp;
}

/**
 * How long the oldest unsent op has been waiting, in milliseconds. Null when
 * the outbox is empty.
 *
 * This exists because the failure it measures is invisible otherwise. A worker
 * that cannot reach a chain logs exactly what a worker with nothing to do logs
 * - "0 confirmed" - so an RPC whose key had been revoked went unnoticed for 28
 * hours on 2026-09-23, and the fix for it went unnoticed again because it had
 * been set in the wrong place. Both would have shown here within a minute.
 *
 * It measures age, not count: a backlog of two ops that have sat for a day is
 * the emergency, and a hundred that arrived this second is a busy Tuesday.
 */
export async function settlementLag(db: Db, now = new Date()): Promise<number | null> {
  const [row] = await db
    .select({ oldest: sql<string | null>`min(${chainOps.createdAt})` })
    .from(chainOps)
    .where(eq(chainOps.status, "pending"));
  if (!row?.oldest) return null;
  return Math.max(0, now.getTime() - new Date(row.oldest).getTime());
}

/**
 * How long an op may wait before something is wrong. Generous next to the
 * worker's five-second pass and the program's ten-minute outflow window, so a
 * throttled vault waiting its turn never trips it.
 */
export const SETTLEMENT_LAG_ALARM_MS = 15 * 60 * 1000;

/**
 * The least SOL a settler should be left with.
 *
 * The settler pays the account rent for every vault, settlement, withdrawal and
 * rental record, and the fee for every transaction it builds - so a player
 * needs no SOL at all, and the settler running dry stops the whole system
 * without anything else looking wrong. It was at 0.001 on 2026-09-25 and
 * nothing had said so.
 */
export const SETTLER_SOL_FLOOR = 1;

export type SolWatch = { stop: () => void };

/**
 * Watches a settler's SOL and says so when it runs low - once when it crosses,
 * and once when it is topped up, never on every check. Takes a reader rather
 * than a connection so that what it decides can be tested without a chain.
 */
export function watchSettlerSol(
  read: () => Promise<number>,
  options: { floorSol?: number; intervalMs?: number; onLow: (sol: number) => void; onRecovered: (sol: number) => void; onError?: (e: unknown) => void },
): SolWatch {
  const floor = options.floorSol ?? SETTLER_SOL_FLOOR;
  const every = options.intervalMs ?? 5 * 60_000;
  let low = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    if (stopped) return;
    try {
      const sol = await read();
      if (sol < floor && !low) {
        low = true;
        options.onLow(sol);
      } else if (sol >= floor && low) {
        low = false;
        options.onRecovered(sol);
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void check(), every);
  };
  void check();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export type DriftWatch = { stop: () => void };

/**
 * Watches for vaults holding *less* than the ledger says, and says so.
 *
 * This is the direction that means something is wrong: the ledger is
 * authoritative, so a vault that cannot cover what the ledger credits is either
 * a bug or somebody moving money that was not theirs to move. A settler key
 * can settle between any two vaults it likes, so a stolen one drains vaults at
 * whatever rate the outflow cap allows - slowly, and completely silently,
 * because nothing else in the system looks at a vault once its ops are done.
 *
 * Said once when drift appears and once when it clears, like the other alarms
 * here: repeating it every pass would make it noise. Surpluses are not drift
 * and are handled by `creditSurplus`.
 */
export function watchDrift(
  db: Db,
  chain: ChainPort | ChainPorts,
  options: {
    intervalMs?: number;
    onDrift: (mismatches: Mismatch[]) => void;
    onCleared: () => void;
    onError?: (e: unknown) => void;
  },
): DriftWatch {
  const every = options.intervalMs ?? 5 * 60_000;
  let drifting = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    if (stopped) return;
    try {
      const { mismatches } = await reconcile(db, chain);
      if (mismatches.length > 0 && !drifting) {
        drifting = true;
        options.onDrift(mismatches);
      } else if (mismatches.length === 0 && drifting) {
        drifting = false;
        options.onCleared();
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void check(), every);
  };
  void check();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
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

export async function drainChainOps(
  db: Db,
  chain: ChainPort | ChainPorts,
  options: { limit?: number } = {},
): Promise<DrainResult> {
  const ports = portsOf(chain);
  const pending = await db
    .select()
    .from(chainOps)
    .where(eq(chainOps.status, "pending"))
    .orderBy(asc(chainOps.seq))
    .limit(options.limit ?? 100);
  // The flow of every agent these ops touch, in one query rather than one per op.
  const flows = await fundingOf(db, pending);

  const vaultless = await vaultlessAgents(db);
  const result: DrainResult = { confirmed: 0, alreadyOnChain: 0, deferred: 0, stoppedAt: null, error: null };
  for (const op of pending) {
    try {
      const funding = flows.get(op.id) ?? "seed";
      const chain = ports[funding];
      if (!chain) {
        // No client for this flow: defer rather than send it to the other
        // program, which holds none of this agent's accounts.
        const why = `no ${funding} settlement client is configured on this server`;
        await db.update(chainOps).set({ lastError: why, updatedAt: new Date() }).where(eq(chainOps.id, op.id));
        result.error ??= why;
        result.deferred++;
        continue;
      }
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
 * A vault holding more than the ledger says. Not a disagreement: a vault is an
 * ordinary token account, so anyone can transfer into one without the program
 * being involved at all, and a deposit whose confirmation was lost looks the
 * same from here. Either way the money is the agent's and the ledger is behind.
 */
/**
 * A vault holding less than the ledger says, where the difference is exactly
 * an exit the owner claimed and the ledger has not yet absorbed.
 *
 * Not a mismatch. An exit is owner-signed and needs nobody here, so the chain
 * moves first and the ledger follows - the one place in this system where that
 * is the correct order rather than a bug.
 */
export type Explained = {
  agentId: string;
  name: string;
  ledger: number;
  chain: number;
  /** What the claim took, from the chain's own record of it. */
  claimed: number;
  claimedSlot: number;
  funding: Funding;
};

export type Surplus = {
  agentId: string;
  name: string;
  ledger: number;
  chain: number;
  surplus: number;
  /** Which program holds this vault, which decides whether the surplus is money. */
  funding: Funding;
};

/**
 * Compares each agent's vault with its ledger balance, for agents whose ops
 * have all been confirmed. The ledger is authoritative; a mismatch is a bug to
 * investigate, never something to "fix" by overwriting either side.
 */
export async function reconcile(
  db: Db,
  chain: ChainPort | ChainPorts,
): Promise<{ checked: number; mismatches: Mismatch[]; surpluses: Surplus[]; explained: Explained[] }> {
  const ports = portsOf(chain);
  const involved = await db
    .select({ id: agents.id, name: agents.name, funding: agents.funding })
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
  const surpluses: Surplus[] = [];
  const explained: Explained[] = [];
  for (const agent of involved) {
    const port = ports[agent.funding];
    // An agent whose program this server cannot reach is not a disagreement:
    // nothing has been compared, so nothing can be said about it.
    if (!port) continue;
    const onChain = await port.vaultBalance(agent.id);
    const ledger = balances.get(agent.id) ?? 0;
    if (onChain === ledger) continue;
    // More on chain than in the ledger is money that arrived: the ledger is
    // behind, not wrong. Less is the serious direction - the ledger says an
    // agent owns something its vault cannot pay - and that is a bug to look at.
    if (onChain !== null && onChain > ledger) {
      surpluses.push({
        agentId: agent.id,
        name: agent.name,
        ledger,
        chain: onChain,
        surplus: onChain - ledger,
        funding: agent.funding,
      });
      continue;
    }

    // Short. Before calling it a disagreement, ask the chain whether the owner
    // took it themselves. The evidence is the Exit account, not a row this
    // server wrote when it thought it saw a claim: a server that missed the
    // request entirely still reconciles correctly.
    const claim = onChain === null ? null : await claimedExit(db, port, agent.id);
    if (claim !== null && onChain !== null) {
      const unexplained = ledger - onChain - claim.claimedAmount;
      if (unexplained === 0) {
        explained.push({
          agentId: agent.id,
          name: agent.name,
          ledger,
          chain: onChain,
          claimed: claim.claimedAmount,
          claimedSlot: claim.claimedSlot,
          funding: agent.funding,
        });
        continue;
      }
      // A claim does not excuse the rest. Reporting the shortfall as though the
      // exit explained all of it is how this design would hide the very bug it
      // exists to expose, so what is reported is what the exit does not cover.
      if (unexplained > 0) {
        mismatches.push({ agentId: agent.id, name: agent.name, ledger: ledger - claim.claimedAmount, chain: onChain });
        continue;
      }
      // Less short than the claim accounts for: money arrived after it.
      surpluses.push({
        agentId: agent.id,
        name: agent.name,
        ledger: ledger - claim.claimedAmount,
        chain: onChain,
        surplus: -unexplained,
        funding: agent.funding,
      });
      continue;
    }
    mismatches.push({ agentId: agent.id, name: agent.name, ledger, chain: onChain });
  }
  return { checked: involved.length, mismatches, surpluses, explained };
}

export type Solvency = {
  /** Base units the ledger says players own, across every agent with a vault. */
  ledger: number;
  /** Base units those vaults actually hold. Null for a flow this server cannot reach. */
  chain: number;
  /** chain - ledger. Negative is the direction that matters. */
  difference: number;
  /** Agents counted, and agents skipped because their program is unreachable. */
  counted: number;
  unreachable: number;
  /**
   * Base units queued to move but not yet on chain. A settlement in the outbox
   * has already been taken off one ledger balance and added to another, while
   * the vaults still hold the old amounts - so it moves no total, and the
   * difference above should not be read as explained by it. It is here because
   * an operator looking at a non-zero difference will ask.
   */
  inFlight: number;
};

/**
 * The solvency line: what the ledger says players own against what the vaults
 * actually hold.
 *
 * Every other check here is per agent. This is the one that answers the
 * question an operator actually has, which is whether the whole thing adds up.
 * A settlement moves money between two vaults and nets to nothing, so in a
 * healthy system these two figures are equal at every instant, whatever is
 * queued.
 *
 * Unlike `reconcile` this counts agents with ops in flight too, because
 * leaving them out would mean the total quietly excluded exactly the agents
 * something is happening to.
 */
export async function solvency(db: Db, chain: ChainPort | ChainPorts): Promise<Solvency> {
  const ports = portsOf(chain);
  const withVaults = await db
    .select({ id: agents.id, funding: agents.funding })
    .from(agents)
    .where(
      sql`exists (select 1 from ${chainOps} where ${chainOps.agentId} = ${agents.id} and ${chainOps.kind} = 'open_vault' and ${chainOps.status} = 'confirmed')`,
    );
  const balances = await balancesOf(
    db,
    withVaults.map((a) => a.id),
  );

  let ledger = 0;
  let onChain = 0;
  let counted = 0;
  let unreachable = 0;
  for (const agent of withVaults) {
    const port = ports[agent.funding];
    if (!port) {
      unreachable++;
      continue;
    }
    const vault = await port.vaultBalance(agent.id);
    if (vault === null) {
      unreachable++;
      continue;
    }
    ledger += balances.get(agent.id) ?? 0;
    onChain += vault;
    counted++;
  }

  const [flight] = await db
    .select({ amount: sql<number>`coalesce(sum(${chainOps.amount}) filter (where ${chainOps.kind} = 'settle'), 0)::bigint` })
    .from(chainOps)
    .where(eq(chainOps.status, "pending"));

  return {
    ledger,
    chain: onChain,
    difference: onChain - ledger,
    counted,
    unreachable,
    inFlight: Number(flight?.amount ?? 0),
  };
}

/**
 * An exit this agent claimed on chain that the ledger has not yet absorbed, or
 * null.
 *
 * Two conditions, and both matter. The chain must say it was claimed, which is
 * the evidence. And this server must not already have written the debit for
 * *that* claim - otherwise a claim absorbed weeks ago would go on explaining
 * every later shortfall, and a genuinely drained vault would read as fine. The
 * slot is what ties the local record to the chain's, because an agent's second
 * exit reuses the same address as its first.
 */
async function claimedExit(
  db: Db,
  port: ChainPort,
  agentId: string,
): Promise<{ claimedSlot: number; claimedAmount: number } | null> {
  if (!port.exitOf) return null;
  const onChain = await port.exitOf(agentId);
  if (!onChain || onChain.claimedSlot === 0) return null;
  const [row] = await db.select().from(exits).where(eq(exits.agentId, agentId)).limit(1);
  const absorbed = row?.ingestedAt !== null && row?.ingestedAt !== undefined && row.claimedSlot === onChain.claimedSlot;
  if (absorbed) return null;
  return { claimedSlot: onChain.claimedSlot, claimedAmount: onChain.claimedAmount };
}

/**
 * Credits money that reached a vault without the ledger hearing about it.
 *
 * The program cannot stop a plain transfer into a vault, so `deposit` exists to
 * make one attributable rather than to make it the only way in. Whatever the
 * route, the tokens are in the agent's vault and are its owner's; refusing to
 * count them would leave money nobody could play with or withdraw.
 *
 * **Only on the deposit flow.** That programme's token has no mint authority,
 * so a surplus there can only be tokens somebody already held - real money,
 * arriving by a route this server did not build. The seed programme is the
 * opposite: its settler can mint, and that key is known to be exposed, so a
 * surplus in a seed vault may be tokens conjured by whoever holds it. Crediting
 * those would put invented money into balances, and from there into who can
 * play which band, how much is staked, and what the ladder and the rewards are
 * computed from. They are reported instead, and the ledger stays the only thing
 * that says what a seed agent owns.
 *
 * An agent with a rental or top-up still in flight is left alone either way.
 * Its surplus is most likely that very transaction, and crediting it here as
 * well as when it confirms would count it twice.
 */
export async function creditSurplus(
  db: Db,
  chain: ChainPort | ChainPorts,
): Promise<{ credited: { agentId: string; amount: number }[]; refused: Surplus[] }> {
  const { surpluses } = await reconcile(db, chain);
  const credited: { agentId: string; amount: number }[] = [];
  const refused: Surplus[] = [];
  for (const s of surpluses) {
    if (s.funding !== "deposit") {
      refused.push(s);
      continue;
    }
    const inFlight = await db
      .select({ id: rentals.id })
      .from(rentals)
      .where(and(eq(rentals.agentId, s.agentId), inArray(rentals.status, ["prepared", "submitted"])))
      .limit(1);
    if (inFlight.length > 0) continue;
    const topping = await db
      .select({ id: deposits.id })
      .from(deposits)
      .where(and(eq(deposits.agentId, s.agentId), inArray(deposits.status, ["prepared", "submitted"])))
      .limit(1);
    if (topping.length > 0) continue;
    await record(db, [{ agentId: s.agentId, amount: s.surplus, reason: "deposit" }]);
    credited.push({ agentId: s.agentId, amount: s.surplus });
  }
  return { credited, refused };
}

/**
 * Keeps draining the outbox on an interval. One drain at a time: a slow chain
 * delays the next pass rather than stacking overlapping ones.
 */
export function startChainWorker(
  db: Db,
  chain: ChainPort | ChainPorts,
  options: {
    intervalMs?: number;
    onPass?: (result: DrainResult) => void;
    /**
     * The outbox has been stuck for too long, or has started moving again.
     * Called once when it starts and once when it clears, never on every pass:
     * an alarm that repeats every five seconds is one nobody reads.
     */
    onLag?: (state: { stalled: boolean; lagMs: number }) => void;
    lagAlarmMs?: number;
    /**
     * How often to read the exits off chain. Less often than the outbox
     * because it is one call for every exit in existence, and the clock it
     * serves is thirty minutes long - but not so seldom that an agent keeps
     * playing for minutes after its owner asked to leave.
     */
    exitIntervalMs?: number;
    onExits?: (pass: ExitPass) => void;
  } = {},
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alarming = false;
  const alarmAfter = options.lagAlarmMs ?? SETTLEMENT_LAG_ALARM_MS;
  const pass = async () => {
    if (stopped) return;
    try {
      const result = await drainChainOps(db, chain);
      options.onPass?.(result);
    } catch (error) {
      options.onPass?.({ confirmed: 0, alreadyOnChain: 0, deferred: 0, stoppedAt: null, error: String(error) });
    }
    try {
      const lagMs = (await settlementLag(db)) ?? 0;
      const stalled = lagMs >= alarmAfter;
      if (stalled !== alarming) {
        alarming = stalled;
        options.onLag?.({ stalled, lagMs });
      }
    } catch {
      // A lag check that itself fails must not stop the worker draining.
    }
    if (!stopped) timer = setTimeout(() => void pass(), options.intervalMs ?? 5_000);
  };

  // Exits are read on a clock of their own. Nothing in the outbox knows about
  // them: an exit is owner-signed, so it reaches this server only by being
  // looked for.
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const exitPass = async () => {
    if (stopped) return;
    try {
      const ports = portsOf(chain);
      if (ports.deposit?.exits) {
        const result = await ingestExits(db, await ports.deposit.exits());
        if (result.frozen.length || result.ingested.length || result.cleared.length) options.onExits?.(result);
      }
    } catch {
      // An exit pass that fails must not stop the outbox draining; the next
      // one picks up everything this one missed, because it reads the chain
      // rather than a queue.
    }
    if (!stopped) exitTimer = setTimeout(() => void exitPass(), options.exitIntervalMs ?? 30_000);
  };

  void pass();
  void exitPass();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
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
