import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { exits } from "../src/db/schema.js";
import { createAgent } from "../src/db/runner.js";
import { drainChainOps, reconcile } from "../src/chain/worker.js";
import { balanceOf } from "../src/db/ledger.js";
import { someWallet } from "./helpers.js";
import { FakeChain } from "./fake-chain.js";
import type { ChainPort } from "../src/chain/worker.js";

/**
 * Reconcile's third state (docs/non-custodial-exit.md).
 *
 * An exit is owner-signed and needs nobody here, so the chain moves first and
 * the ledger follows - the one place in this system where that order is right
 * rather than a bug. Between the two, the vault holds less than the ledger
 * says, which is otherwise the definition of the serious alarm.
 */
const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

/** An agent with a vault open on chain and nothing pending, which is what reconcile looks at. */
async function settled(db: Awaited<ReturnType<typeof fresh>>["db"], chain: FakeChain, name: string) {
  const agent = await createAgent(db, { name, presetName: "Anchor", ownerId: someWallet() });
  await drainChainOps(db, chain, { limit: 100 });
  return agent;
}

describe("a vault short because its owner exited", () => {
  it("is explained, not alarmed, and the alarm's own list stays empty", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const agent = await settled(db, chain, "Leaver");
    const before = await balanceOf(db, agent.id);

    chain.claimExit(agent.id, 300);

    const check = await reconcile(db, chain);
    expect(check.mismatches).toEqual([]);
    expect(check.surpluses).toEqual([]);
    expect(check.explained).toHaveLength(1);
    expect(check.explained[0]).toMatchObject({
      agentId: agent.id,
      ledger: before,
      chain: before - 300,
      claimed: 300,
    });
    await close();
  });

  it("still reports a real drain that happens alongside a claim", async () => {
    // The case this whole design exists to keep honest. Treating any claim as
    // blanket permission to be short is how it would hide the bug it is for.
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const agent = await settled(db, chain, "Robbed");
    const before = await balanceOf(db, agent.id);

    chain.claimExit(agent.id, 300);
    // And 50 more leaves the vault by some route nothing accounts for.
    chain.vaults.set(agent.id, (chain.vaults.get(agent.id) ?? 0) - 50);

    const check = await reconcile(db, chain);
    expect(check.explained).toEqual([]);
    expect(check.mismatches).toHaveLength(1);
    // Sized at what the exit does not cover, not at the whole shortfall.
    expect(check.mismatches[0]!.ledger - check.mismatches[0]!.chain!).toBe(50);
    expect(before - (chain.vaults.get(agent.id) ?? 0)).toBe(350);
    await close();
  });

  it("stops explaining once the ledger has absorbed that claim", async () => {
    // A claim the ledger already took account of must not go on excusing
    // shortfalls forever: the next one is real.
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const agent = await settled(db, chain, "Twice");

    chain.claimExit(agent.id, 300, 1_000);
    expect((await reconcile(db, chain)).explained).toHaveLength(1);

    // The watcher debits the ledger and records that it did.
    const { record } = await import("../src/db/ledger.js");
    await record(db, [{ agentId: agent.id, amount: -300, reason: "adjustment" }]);
    await db.insert(exits).values({
      agentId: agent.id,
      requestedSlot: 1_000 - 4_500,
      unlockSlot: 1_000,
      amount: 300,
      claimedSlot: 1_000,
      claimedAmount: 300,
      ingestedAt: new Date(),
    });
    // Nothing to explain now: the two agree.
    let check = await reconcile(db, chain);
    expect(check.explained).toEqual([]);
    expect(check.mismatches).toEqual([]);

    // Now a genuine drain. The stale claim is still on chain, unclosed.
    chain.vaults.set(agent.id, (chain.vaults.get(agent.id) ?? 0) - 120);
    check = await reconcile(db, chain);
    expect(check.explained).toEqual([]);
    expect(check.mismatches).toHaveLength(1);
    expect(check.mismatches[0]!.ledger - check.mismatches[0]!.chain!).toBe(120);
    await close();
  });

  it("explains a second exit once the first has been absorbed", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const agent = await settled(db, chain, "Again");

    chain.claimExit(agent.id, 200, 1_000);
    const { record } = await import("../src/db/ledger.js");
    await record(db, [{ agentId: agent.id, amount: -200, reason: "adjustment" }]);
    await db.insert(exits).values({
      agentId: agent.id,
      requestedSlot: 1_000 - 4_500,
      unlockSlot: 1_000,
      amount: 200,
      claimedSlot: 1_000,
      claimedAmount: 200,
      ingestedAt: new Date(),
    });

    // A fresh exit at a later slot, reusing the same address, is a new claim.
    chain.claimExit(agent.id, 100, 9_000);
    const check = await reconcile(db, chain);
    expect(check.mismatches).toEqual([]);
    expect(check.explained).toHaveLength(1);
    expect(check.explained[0]).toMatchObject({ claimed: 100, claimedSlot: 9_000 });
    await close();
  });

  it("says nothing about exits on a program that has none", async () => {
    // The seed program has no exit instruction, so its port has no exitOf at
    // all, and a shortfall there is what it always was. Delegating rather than
    // spreading: FakeChain is a class, and a spread of one keeps its fields
    // and loses every method.
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const agent = await settled(db, chain, "Seeded");
    chain.vaults.set(agent.id, (chain.vaults.get(agent.id) ?? 0) - 70);
    // An exit exists on chain, and must still not be consulted.
    chain.exits.set(agent.id, {
      amount: 70,
      requestedSlot: 0,
      unlockSlot: 1,
      vaultAtRequest: 0,
      claimedSlot: 1,
      claimedAmount: 70,
    });

    const exitless: ChainPort = {
      openVault: (i) => chain.openVault(i),
      settle: (i) => chain.settle(i),
      hasVault: (i) => chain.hasVault(i),
      isSettled: (i) => chain.isSettled(i),
      vaultBalance: (i) => chain.vaultBalance(i),
      ownerOf: (i) => chain.ownerOf(i),
      submitWithdrawal: () => chain.submitWithdrawal(),
      isWithdrawn: () => chain.isWithdrawn(),
      blockHeightPassed: () => chain.blockHeightPassed(),
    };
    const check = await reconcile(db, exitless);
    expect(check.explained).toEqual([]);
    expect(check.mismatches).toHaveLength(1);
    await close();
  });

  it("leaves an agent whose vault agrees alone, and asks the chain nothing extra", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    await settled(db, chain, "Fine");
    let asked = 0;
    const counting = Object.create(chain) as FakeChain;
    counting.exitOf = async (id: string) => {
      asked++;
      return chain.exitOf(id);
    };
    const check = await reconcile(db, counting);
    expect(check.mismatches).toEqual([]);
    expect(check.explained).toEqual([]);
    // The common case must not cost a second chain read per agent.
    expect(asked).toBe(0);
    await db.select().from(exits).where(eq(exits.agentId, "00000000-0000-0000-0000-000000000000"));
    await close();
  });
});
