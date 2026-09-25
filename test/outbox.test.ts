import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, chainOps, STARTING_BALANCE } from "../src/db/schema.js";
import { balanceOf } from "../src/db/ledger.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import {
  drainChainOps,
  reconcile,
  settlementLag,
  startChainWorker,
  SETTLEMENT_LAG_ALARM_MS,
  type ChainPort,
} from "../src/chain/worker.js";
import type { SeedOpenVaultInput } from "../src/chain/seed-settlement.js";
import { agentIdFor } from "../src/agent-id.js";
import { someWallet } from "./helpers.js";

/** An in-memory stand-in for the program, with the same guarantees it enforces. */
class FakeChain implements ChainPort {
  vaults = new Map<string, number>();
  settled = new Set<string>();
  calls: string[] = [];
  failNext: string | null = null;
  /** Agents whose vault has paid out its limit for this window: the program refuses, for now. */
  throttled = new Set<string>();
  /** Simulates a submission that landed but whose confirmation was lost. */
  landButThrow = false;

  async openVault({ agentId, owner, salt, amount }: SeedOpenVaultInput) {
    this.calls.push(`open ${agentId.slice(0, 4)}`);
    if (this.failNext) throw new Error(this.failNext);
    if (agentIdFor(owner, salt) !== agentId) throw new Error("Error Code: AgentIdMismatch");
    if (this.vaults.has(agentId)) throw new Error("vault already in use");
    this.vaults.set(agentId, amount);
    if (owner) this.owners.set(agentId, owner);
    if (this.landButThrow) throw new Error("timed out waiting for confirmation");
    return `sig-open-${agentId}`;
  }
  async settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }) {
    this.calls.push(`settle ${input.matchId.slice(0, 4)}`);
    if (this.failNext) throw new Error(this.failNext);
    if (this.settled.has(input.matchId)) throw new Error("settlement already in use");
    if (this.throttled.has(input.fromAgent)) throw new Error("Error Code: OutflowLimit");
    const from = this.vaults.get(input.fromAgent);
    const to = this.vaults.get(input.toAgent);
    if (from === undefined || to === undefined) throw new Error("Error Code: AccountNotInitialized");
    if (from < input.amount) throw new Error("Error Code: InsufficientVault");
    this.vaults.set(input.fromAgent, from - input.amount);
    this.vaults.set(input.toAgent, to + input.amount);
    this.settled.add(input.matchId);
    if (this.landButThrow) throw new Error("timed out waiting for confirmation");
    return `sig-settle-${input.matchId}`;
  }
  async hasVault(agentId: string) {
    return this.vaults.has(agentId);
  }
  async isSettled(matchId: string) {
    return this.settled.has(matchId);
  }
  async settlementSignature(matchId: string) {
    return this.settled.has(matchId) ? `sig-settle-${matchId}` : null;
  }
  async vaultBalance(agentId: string) {
    return this.vaults.get(agentId) ?? null;
  }
  owners = new Map<string, string>();
  async ownerOf(agentId: string) {
    return this.owners.get(agentId) ?? null;
  }
  // Withdrawals are exercised in withdraw.test.ts with a fake that checks transactions.
  async submitWithdrawal(): Promise<string> {
    throw new Error("not used here");
  }
  async isWithdrawn() {
    return false;
  }
  async blockHeightPassed() {
    return false;
  }
}

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await connect());
  await migrate(db);
});
afterAll(async () => close());

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

describe("the outbox", () => {
  it("is written in the same transaction as renting and settling", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "A", presetName: "Bully" });
    const b = await createAgent(d, { name: "B", presetName: "Mirage" });
    const opens = await d.select().from(chainOps).where(eq(chainOps.kind, "open_vault"));
    expect(opens.map((o) => o.amount)).toEqual([STARTING_BALANCE, STARTING_BALANCE]);

    const { match, settled } = await runMatch(d, a.id, b.id, { seed: 7 });
    const settles = await d.select().from(chainOps).where(eq(chainOps.matchId, match.id));
    if (settled.A === 0) {
      expect(settles).toHaveLength(0);
    } else {
      expect(settles).toHaveLength(1);
      expect(settles[0]!.amount).toBe(Math.abs(settled.A));
      expect(settles[0]!.toAgent).toBe(settled.A > 0 ? a.id : b.id);
      expect(settles[0]!.fromAgent).toBe(settled.A > 0 ? b.id : a.id);
    }
    await c();
  });
});

describe("the worker", () => {
  it("submits in order and leaves the chain matching the ledger", async () => {
    const { db: d, close: c } = await fresh();
    const agentsMade = [];
    for (let i = 0; i < 6; i++) agentsMade.push(await createAgent(d, { name: `P${i}`, presetName: i % 2 ? "Bully" : "Mirage" }));
    for (let seed = 1; seed <= 30; seed++) {
      const [x, y] = [agentsMade[seed % 6]!, agentsMade[(seed * 5 + 1) % 6]!];
      if (x.id === y.id) continue;
      try {
        await runMatch(d, x.id, y.id, { seed });
      } catch {
        /* a retired agent sits out */
      }
    }

    const chain = new FakeChain();
    const drained = await drainChainOps(d, chain, { limit: 1000 });
    expect(drained.error).toBeNull();
    // Every vault opened before any settlement touched it.
    const firstSettle = chain.calls.findIndex((x) => x.startsWith("settle"));
    const lastOpen = chain.calls.map((x) => x.startsWith("open")).lastIndexOf(true);
    expect(lastOpen).toBeLessThan(firstSettle === -1 ? Infinity : firstSettle);

    const check = await reconcile(d, chain);
    expect(check.checked).toBe(6);
    expect(check.mismatches).toEqual([]);
    for (const a of agentsMade) expect(await chain.vaultBalance(a.id)).toBe(await balanceOf(d, a.id));
    await c();
  });

  it("stops at the first failure instead of skipping ahead, and resumes from it", async () => {
    const { db: d, close: c } = await fresh();
    await createAgent(d, { name: "First", presetName: "Anchor" });
    await createAgent(d, { name: "Second", presetName: "Anchor" });

    const chain = new FakeChain();
    chain.failNext = "rpc unavailable";
    const stuck = await drainChainOps(d, chain);
    expect(stuck.confirmed).toBe(0);
    expect(stuck.error).toMatch(/rpc unavailable/);
    const ops = await d.select().from(chainOps).orderBy(asc(chainOps.seq));
    expect(ops.map((o) => o.status)).toEqual(["pending", "pending"]);
    expect(ops[0]!.attempts).toBe(1);
    expect(ops[1]!.attempts).toBe(0); // never tried: the worker did not skip ahead

    chain.failNext = null;
    const resumed = await drainChainOps(d, chain);
    expect(resumed.confirmed).toBe(2);
    await c();
  });

  it("sets aside an op the program refuses and carries on, rather than holding up every other vault", async () => {
    const { db: d, close: c } = await fresh();
    const throttled = await createAgent(d, { name: "Throttled", presetName: "Bully" });
    const rival = await createAgent(d, { name: "Rival", presetName: "Anchor" });
    const chain = new FakeChain();
    expect((await drainChainOps(d, chain)).confirmed).toBe(2); // both vaults open

    // A match this agent loses, and then matches between others.
    let lost: string | null = null;
    for (let seed = 1; seed <= 60 && !lost; seed++) {
      const { match, settled } = await runMatch(d, throttled.id, rival.id, { seed });
      if (settled.A < 0) lost = match.id;
    }
    expect(lost).not.toBeNull();
    const others = [await createAgent(d, { name: "X", presetName: "Mirage" }), await createAgent(d, { name: "Y", presetName: "Hammer" })];

    chain.throttled.add(throttled.id);
    const pass = await drainChainOps(d, chain);
    expect(pass.deferred).toBe(1);
    expect(pass.error).toMatch(/OutflowLimit/);
    expect(pass.stoppedAt).toBeNull(); // the pass went on
    // The vaults queued behind the refused settlement opened all the same.
    for (const o of others) expect(await chain.hasVault(o.id)).toBe(true);
    const [refused] = await d.select().from(chainOps).where(eq(chainOps.id, (await d.select().from(chainOps).where(eq(chainOps.matchId, lost!)))[0]!.id));
    expect(refused!.status).toBe("pending");
    expect(refused!.lastError).toMatch(/OutflowLimit/);

    // Its window comes round: the next pass lands it, and the chain agrees with the ledger again.
    chain.throttled.clear();
    expect((await drainChainOps(d, chain)).confirmed).toBeGreaterThan(0);
    expect((await reconcile(d, chain)).mismatches).toEqual([]);
    await c();
  });

  it("gives up on an op no instruction can take any more, instead of retrying it forever", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "Legacy", presetName: "Anchor" });
    // As the old server queued them: a vault op with no salt, and a separate owner record.
    await d.update(chainOps).set({ salt: null }).where(eq(chainOps.agentId, a.id));
    await d.insert(chainOps).values({ kind: "register_owner", agentId: a.id, owner: "who", amount: 0 });
    const b = await createAgent(d, { name: "Current", presetName: "Bully" });

    const chain = new FakeChain();
    const pass = await drainChainOps(d, chain);
    expect(pass.stoppedAt).toBeNull();
    const ops = await d.select().from(chainOps).orderBy(asc(chainOps.seq));
    expect(ops.filter((o) => o.agentId === a.id).map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(ops.find((o) => o.agentId === a.id)!.lastError).toMatch(/no salt/);
    // The agent queued after them opened all the same.
    expect(await chain.hasVault(b.id)).toBe(true);
    // And they are not tried again.
    const again = await drainChainOps(d, chain);
    expect(again.deferred).toBe(0);
    await c();
  });

  it("gives up on settlements for a vault that can never open, instead of refusing them for ever", async () => {
    const { db: d, close: c } = await fresh();
    const stranded = await createAgent(d, { name: "Stranded", presetName: "Anchor" });
    const rival = await createAgent(d, { name: "Rival", presetName: "Bully" });
    // As an old rental was: no salt, so its vault can never be opened.
    await d.update(chainOps).set({ salt: null }).where(eq(chainOps.agentId, stranded.id));
    let settled: string | null = null;
    for (let seed = 1; seed <= 60 && !settled; seed++) {
      const { match, settled: nets } = await runMatch(d, stranded.id, rival.id, { seed });
      if (nets.A !== 0) settled = match.id;
    }
    expect(settled).not.toBeNull();

    const chain = new FakeChain();
    const pass = await drainChainOps(d, chain);
    expect(pass.stoppedAt).toBeNull();
    const ops = await d.select().from(chainOps).orderBy(asc(chainOps.seq));
    const dead = ops.filter((o) => o.agentId === stranded.id || o.fromAgent === stranded.id || o.toAgent === stranded.id);
    expect(dead.every((o) => o.status === "failed")).toBe(true);
    expect(dead.find((o) => o.kind === "settle")!.lastError).toMatch(/can never open/);
    // The other agent's vault is untouched by any of it.
    expect(await chain.hasVault(rival.id)).toBe(true);
    // Nothing is retried on the next pass, and the ledger still says what it said.
    const again = await drainChainOps(d, chain);
    expect(again.deferred + again.confirmed).toBe(0);
    expect(await balanceOf(d, stranded.id)).toBeGreaterThan(0);
    await c();
  });

  it("does not submit twice when an earlier attempt landed but was never confirmed", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "A", presetName: "Anchor" });

    const chain = new FakeChain();
    chain.landButThrow = true;
    const first = await drainChainOps(d, chain);
    expect(first.error).toMatch(/timed out/);
    expect(chain.vaults.get(a.id)).toBe(STARTING_BALANCE); // it did land

    chain.landButThrow = false;
    const second = await drainChainOps(d, chain);
    expect(second.alreadyOnChain).toBe(1);
    expect(second.confirmed).toBe(0);
    expect(chain.calls.filter((x) => x.startsWith("open"))).toHaveLength(1);
    expect(chain.vaults.get(a.id)).toBe(STARTING_BALANCE); // not funded twice
    await c();
  });

  it("recovers the signature of a settlement found already on chain, so its page can link it", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "A", presetName: "Bully" });
    const b = await createAgent(d, { name: "B", presetName: "Mirage" });
    const chain = new FakeChain();
    await drainChainOps(d, chain);
    let matchId = "";
    for (let seed = 1; !matchId; seed++) {
      const { match, settled } = await runMatch(d, a.id, b.id, { seed });
      if (settled.A !== 0) matchId = match.id;
    }

    chain.landButThrow = true;
    expect((await drainChainOps(d, chain)).error).toMatch(/timed out/);
    chain.landButThrow = false;
    expect((await drainChainOps(d, chain)).alreadyOnChain).toBe(1);

    const [op] = await d.select().from(chainOps).where(eq(chainOps.matchId, matchId));
    expect(op!.status).toBe("confirmed");
    expect(op!.signature).toBe(`sig-settle-${matchId}`);
    await c();
  });

  it("reconcile reports a disagreement rather than papering over it", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "A", presetName: "Anchor" });
    const chain = new FakeChain();
    await drainChainOps(d, chain);
    chain.vaults.set(a.id, STARTING_BALANCE - 7);
    const check = await reconcile(d, chain);
    expect(check.mismatches).toEqual([{ agentId: a.id, name: "A", ledger: STARTING_BALANCE, chain: STARTING_BALANCE - 7 }]);
    await c();
  });
});

describe("two programs, side by side", () => {
  // A vault is a token account for one mint under one program, so an op has to
  // reach the program that holds its agent's. These check it does, and that a
  // flow with no client waits rather than being asked of the wrong program.
  async function fresh() {
    const { db } = await connect();
    await migrate(db);
    return db;
  }

  it("sends each agent's ops to the program its flow belongs to", async () => {
    const db = await fresh();
    const seed = new FakeChain();
    const deposit = new FakeChain();

    const a = await createAgent(db, { name: "Seeded", presetName: "Anchor", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Deposited", presetName: "Hammer", ownerId: someWallet() });
    await db.update(agents).set({ funding: "deposit" }).where(eq(agents.id, b.id));

    const result = await drainChainOps(db, { seed, deposit });
    expect(result.error).toBeNull();
    expect(result.confirmed).toBe(2);

    // Each vault opened on its own program, and neither knows the other's agent.
    expect(seed.vaults.has(a.id)).toBe(true);
    expect(seed.vaults.has(b.id)).toBe(false);
    expect(deposit.vaults.has(b.id)).toBe(true);
    expect(deposit.vaults.has(a.id)).toBe(false);
  });

  it("makes a deposit-flow op wait when no deposit client is configured", async () => {
    const db = await fresh();
    const seed = new FakeChain();
    const agent = await createAgent(db, { name: "Deposited", presetName: "Bully", ownerId: someWallet() });
    await db.update(agents).set({ funding: "deposit" }).where(eq(agents.id, agent.id));

    // A bare ChainPort means "everything is the seed flow", so there is no
    // deposit client at all.
    const result = await drainChainOps(db, seed);
    expect(result.confirmed).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.error).toMatch(/no deposit settlement client/);
    // Nothing was asked of the seed program about an agent it does not hold.
    expect(seed.calls).toEqual([]);
    expect(seed.vaults.has(agent.id)).toBe(false);

    // The op is still pending, so it lands once the client exists.
    const [op] = await db.select().from(chainOps).where(eq(chainOps.agentId, agent.id));
    expect(op!.status).toBe("pending");
    const deposit = new FakeChain();
    const after = await drainChainOps(db, { seed, deposit });
    expect(after.confirmed).toBe(1);
    expect(deposit.vaults.has(agent.id)).toBe(true);
  });

  it("reconciles each agent against its own program, and stays silent about one it cannot reach", async () => {
    const db = await fresh();
    const seed = new FakeChain();
    const deposit = new FakeChain();
    await createAgent(db, { name: "Seeded", presetName: "Anchor", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Deposited", presetName: "Mirage", ownerId: someWallet() });
    await db.update(agents).set({ funding: "deposit" }).where(eq(agents.id, b.id));
    await drainChainOps(db, { seed, deposit });

    // Both agree with their own program.
    const both = await reconcile(db, { seed, deposit });
    expect(both.checked).toBe(2);
    expect(both.mismatches).toEqual([]);

    // With no deposit client, the deposit-funded agent is skipped rather than
    // reported as disagreeing: nothing was compared, so nothing can be said.
    const seedOnly = await reconcile(db, seed);
    expect(seedOnly.mismatches).toEqual([]);

    // A real disagreement on its own program is still reported.
    deposit.vaults.set(b.id, 1);
    const broken = await reconcile(db, { seed, deposit });
    expect(broken.mismatches.map((m) => m.name)).toEqual(["Deposited"]);
  });
});

describe("the settlement lag alarm", () => {
  // The failure this exists for: a worker that cannot reach a chain logs what
  // a worker with nothing to do logs. These check that the outbox standing
  // still is distinguishable from the outbox being empty.
  async function fresh() {
    const { db } = await connect();
    await migrate(db);
    return db;
  }

  it("says nothing when there is nothing waiting", async () => {
    const db = await fresh();
    expect(await settlementLag(db)).toBeNull();
  });

  it("measures the age of the oldest waiting op, not how many are waiting", async () => {
    const db = await fresh();
    const agent = await createAgent(db, { name: "Waiting", presetName: "Anchor", ownerId: someWallet() });
    const old = new Date(Date.now() - 40 * 60_000);
    await db.update(chainOps).set({ createdAt: old }).where(eq(chainOps.agentId, agent.id));

    const lag = await settlementLag(db);
    expect(lag).toBeGreaterThanOrEqual(39 * 60_000);
    expect(lag).toBeLessThan(41 * 60_000);
    expect(lag! >= SETTLEMENT_LAG_ALARM_MS).toBe(true);

    // A hundred ops that arrived this second are a busy Tuesday, not an alarm:
    // the newer rows do not lower the figure, and on their own would not raise it.
    const before = await settlementLag(db);
    await db.insert(chainOps).values({ kind: "settle", fromAgent: agent.id, toAgent: agent.id, amount: 1 });
    expect(await settlementLag(db)).toBeGreaterThanOrEqual(before!);

    // Once it drains, there is nothing to report again.
    await db.update(chainOps).set({ status: "confirmed" });
    expect(await settlementLag(db)).toBeNull();
  });

  it("fires once when the outbox stalls and once when it moves again, not on every pass", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const agent = await createAgent(db, { name: "Stuck", presetName: "Hammer", ownerId: someWallet() });
    await db.update(chainOps).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(chainOps.agentId, agent.id));
    // The chain is unreachable, which is what makes the op sit there.
    chain.failNext = "fetch failed";

    const seen: { stalled: boolean; lagMs: number }[] = [];
    const worker = startChainWorker(db, chain, {
      intervalMs: 20,
      lagAlarmMs: 15 * 60_000,
      onLag: (s) => seen.push(s),
    });
    await new Promise((r) => setTimeout(r, 300));

    // Many passes have run; the alarm was raised once.
    expect(seen.filter((s) => s.stalled)).toHaveLength(1);
    expect(seen[0]!.lagMs).toBeGreaterThan(15 * 60_000);

    // The chain comes back and the op lands: one all-clear, and no more.
    chain.failNext = null;
    await new Promise((r) => setTimeout(r, 400));
    worker.stop();
    expect(seen.filter((s) => !s.stalled)).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });
});

