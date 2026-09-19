import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { chainOps, STARTING_BALANCE } from "../src/db/schema.js";
import { balanceOf } from "../src/db/ledger.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { drainChainOps, reconcile, type ChainPort } from "../src/chain/worker.js";
import type { OpenVaultInput } from "../src/chain/settlement.js";
import { agentIdFor } from "../src/agent-id.js";

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

  async openVault({ agentId, owner, salt, amount }: OpenVaultInput) {
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
