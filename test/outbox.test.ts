import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { chainOps, STARTING_BALANCE } from "../src/db/schema.js";
import { balanceOf } from "../src/db/ledger.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { drainChainOps, reconcile, type ChainPort } from "../src/chain/worker.js";

/** An in-memory stand-in for the program, with the same guarantees it enforces. */
class FakeChain implements ChainPort {
  vaults = new Map<string, number>();
  settled = new Set<string>();
  calls: string[] = [];
  failNext: string | null = null;
  /** Simulates a submission that landed but whose confirmation was lost. */
  landButThrow = false;

  async openVault(agentId: string, amount: number) {
    this.calls.push(`open ${agentId.slice(0, 4)}`);
    if (this.failNext) throw new Error(this.failNext);
    if (this.vaults.has(agentId)) throw new Error("vault already in use");
    this.vaults.set(agentId, amount);
    if (this.landButThrow) throw new Error("timed out waiting for confirmation");
    return `sig-open-${agentId}`;
  }
  async settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }) {
    this.calls.push(`settle ${input.matchId.slice(0, 4)}`);
    if (this.failNext) throw new Error(this.failNext);
    if (this.settled.has(input.matchId)) throw new Error("settlement already in use");
    const from = this.vaults.get(input.fromAgent);
    const to = this.vaults.get(input.toAgent);
    if (from === undefined || to === undefined) throw new Error("AccountNotInitialized");
    if (from < input.amount) throw new Error("InsufficientVault");
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
  async registerOwner(agentId: string, owner: string) {
    this.calls.push(`owner ${agentId.slice(0, 4)}`);
    if (this.owners.has(agentId)) throw new Error("owner already in use");
    this.owners.set(agentId, owner);
    return `sig-owner-${agentId}`;
  }
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
