import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agentEvents, agents, exits } from "../src/db/schema.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { checkExitWindow, drainChainOps, reconcile } from "../src/chain/worker.js";
import { ingestExits, isExiting } from "../src/db/exits.js";
import { balanceOf, StakeError } from "../src/db/ledger.js";
import { dueAgents } from "../src/db/autoplay.js";
import { withdrawable } from "../src/db/withdrawals.js";
import { FakeChain } from "./fake-chain.js";
import { someWallet } from "./helpers.js";

/**
 * The watcher (docs/non-custodial-exit.md, step 4).
 *
 * The ledger follows the chain here, which it does nowhere else. What these
 * hold to is the order that makes the gap safe: frozen from the request, and
 * not free again until the claim has been absorbed.
 */
const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

async function player(db: Db, chain: FakeChain, name: string) {
  const agent = await createAgent(db, { name, presetName: "Anchor", ownerId: someWallet() });
  await drainChainOps(db, chain, { limit: 200 });
  return agent;
}

const eventsOf = async (db: Db, id: string) =>
  (await db.select().from(agentEvents).where(eq(agentEvents.agentId, id))).map((e) => `${e.kind}`);

describe("a request freezes the agent", () => {
  it("stops autoplay and refuses to stake, from the request rather than the claim", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Goer");
    const b = await player(db, chain, "Stayer");
    await db.update(agents).set({ autoplay: true }).where(eq(agents.id, a.id));

    chain.requestExit(a.id, 300);
    const pass = await ingestExits(db, await chain.exits());
    expect(pass.frozen).toEqual([a.id]);
    expect(pass.ingested).toEqual([]);

    expect(await isExiting(db, a.id)).toBe(true);
    // Nothing is staked by an agent whose money may be about to leave.
    await expect(runMatch(db, a.id, b.id, { seed: 1 })).rejects.toThrow(StakeError);
    await expect(runMatch(db, a.id, b.id, { seed: 1 })).rejects.toThrow(/exit waiting on chain/);
    // And the scheduler stops offering it, rather than being turned away every pass.
    expect((await dueAgents(db, 0)).map((r) => r.id)).not.toContain(a.id);
    expect((await db.select().from(agents).where(eq(agents.id, a.id)))[0]!.autoplayStoppedReason).toBe("exit");
    expect(await eventsOf(db, a.id)).toContain("exit-requested");

    // The money has not moved: a request is a clock starting.
    expect(await balanceOf(db, a.id)).toBe(900);
    await close();
  });

  it("closes the instant co-signed path while it waits", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Both");
    chain.requestExit(a.id, 100);
    await ingestExits(db, await chain.exits());

    const w = await withdrawable(db, a.id);
    expect(w.withdrawable).toBe(0);
    expect(w.reason).toMatch(/exit is waiting on chain/);
    await close();
  });

  it("does nothing twice, however many passes run", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Once");
    chain.requestExit(a.id, 100);

    expect((await ingestExits(db, await chain.exits())).frozen).toEqual([a.id]);
    expect((await ingestExits(db, await chain.exits())).frozen).toEqual([]);
    expect((await ingestExits(db, await chain.exits())).frozen).toEqual([]);
    expect((await eventsOf(db, a.id)).filter((k) => k === "exit-requested")).toHaveLength(1);
    await close();
  });
});

describe("a claim is absorbed, and only then is the agent free", () => {
  it("debits the ledger, clears the freeze and leaves the books level", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Partial");
    const b = await player(db, chain, "Other");

    chain.requestExit(a.id, 300);
    await ingestExits(db, await chain.exits());
    chain.claimExit(a.id, 300, 5_000);

    // Claimed on chain, ledger not yet told: still frozen, and the reconciler
    // explains the gap rather than alarming.
    expect(await isExiting(db, a.id)).toBe(true);
    const mid = await reconcile(db, chain);
    expect(mid.mismatches).toEqual([]);
    expect(mid.explained).toHaveLength(1);

    const pass = await ingestExits(db, await chain.exits());
    expect(pass.ingested).toEqual([{ agentId: a.id, amount: 300, retired: false }]);
    expect(await balanceOf(db, a.id)).toBe(600);
    expect(await isExiting(db, a.id)).toBe(false);
    expect(await eventsOf(db, a.id)).toContain("exit-claimed");

    // A partial exit leaves a playable agent, not a retired one.
    const row = (await db.select().from(agents).where(eq(agents.id, a.id)))[0]!;
    expect(row.retiredAt).toBeNull();
    const played = await runMatch(db, a.id, b.id, { seed: 3 });
    expect(played.match.id).toBeTruthy();

    // And the two sides agree again with nothing left to explain.
    const after = await reconcile(db, chain);
    expect(after.mismatches).toEqual([]);
    expect(after.explained).toEqual([]);
    await close();
  });

  it("retires the agent when the claim empties the vault", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Gone");

    chain.requestExit(a.id, 900);
    await ingestExits(db, await chain.exits());
    chain.claimExit(a.id, 900, 5_000);
    const pass = await ingestExits(db, await chain.exits());

    expect(pass.ingested).toEqual([{ agentId: a.id, amount: 900, retired: true }]);
    expect(await balanceOf(db, a.id)).toBe(0);
    const row = (await db.select().from(agents).where(eq(agents.id, a.id)))[0]!;
    expect(row.retiredAt).not.toBeNull();
    expect(row.retiredReason).toBe("withdrawn");
    await close();
  });

  it("absorbs a claim once, even if several passes see it", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Twice");

    chain.claimExit(a.id, 200, 5_000);
    expect((await ingestExits(db, await chain.exits())).ingested).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      expect((await ingestExits(db, await chain.exits())).ingested).toEqual([]);
    }
    expect(await balanceOf(db, a.id)).toBe(700);
    await close();
  });

  it("absorbs a second exit at the same address on its own terms", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Again");

    chain.claimExit(a.id, 200, 5_000);
    await ingestExits(db, await chain.exits());
    chain.closeExit(a.id);
    await ingestExits(db, await chain.exits());

    chain.claimExit(a.id, 100, 20_000);
    const pass = await ingestExits(db, await chain.exits());
    expect(pass.ingested).toEqual([{ agentId: a.id, amount: 100, retired: false }]);
    expect(await balanceOf(db, a.id)).toBe(600);
    await close();
  });
});

describe("an exit that goes away", () => {
  it("unfreezes the agent when the owner cancels before claiming", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Stays");
    const b = await player(db, chain, "Rival");

    chain.requestExit(a.id, 900);
    await ingestExits(db, await chain.exits());
    expect(await isExiting(db, a.id)).toBe(true);

    chain.closeExit(a.id);
    const pass = await ingestExits(db, await chain.exits());
    expect(pass.cleared).toEqual([a.id]);
    expect(await isExiting(db, a.id)).toBe(false);
    expect(await eventsOf(db, a.id)).toContain("exit-cancelled");
    // Playable again, with its money untouched.
    expect(await balanceOf(db, a.id)).toBe(900);
    expect((await runMatch(db, a.id, b.id, { seed: 9 })).match.id).toBeTruthy();

    // Autoplay is not switched back on for them: asking to leave is not
    // asking to start again half an hour later.
    expect((await db.select().from(agents).where(eq(agents.id, a.id)))[0]!.autoplay).toBe(false);
    await close();
  });

  it("will not forget a claim it recorded but has not yet absorbed", async () => {
    // A pass that saw the claim and then died before debiting the ledger
    // leaves this row. Dropping it because the chain record has since gone
    // would lose the only note that the ledger still owes a debit.
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Halfway");

    await db.insert(exits).values({
      agentId: a.id,
      requestedSlot: 500,
      unlockSlot: 5_000,
      amount: 400,
      claimedSlot: 5_000,
      claimedAmount: 400,
      ingestedAt: null,
    });

    // Nothing on chain any more.
    const pass = await ingestExits(db, []);
    expect(pass.cleared).toEqual([]);
    expect(await isExiting(db, a.id)).toBe(true);
    await close();
  });

  it("treats a vanished request as a cancel, which the program's close grace makes safe", async () => {
    // A request that disappears before this server ever saw a claim is a
    // cancel, and is read as one. It could in principle be a claim this server
    // missed - but the program refuses to close a claimed exit until a whole
    // window has passed, and passes run every thirty seconds, so there is no
    // real race here. If that grace were ever wrong, the reconciler would see
    // a vault short with nothing to explain it and say so.
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Changed");

    chain.requestExit(a.id, 900);
    await ingestExits(db, await chain.exits());
    chain.closeExit(a.id);

    expect((await ingestExits(db, await chain.exits())).cleared).toEqual([a.id]);
    expect(await isExiting(db, a.id)).toBe(false);
    await close();
  });
});

describe("the window a server will start against", () => {
  it("accepts the shipped pair with room to spare", () => {
    // 4,500 slots is about thirty minutes; passes are thirty seconds apart.
    const check = checkExitWindow(4_500, 30_000);
    expect(check.ok).toBe(true);
    expect(check.graceMs).toBe(1_800_000);
    expect(check.needMs).toBe(300_000);
  });

  it("refuses a window shorter than the watcher could notice", () => {
    // The program's own floor, which is four seconds: shorter than one pass.
    const check = checkExitWindow(10, 30_000);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/would never hear about it|never hear about it/);
    // The message says both ways out, with the numbers worked out.
    expect(check.reason).toMatch(/raise the window to at least 750 slots/);
    expect(check.reason).toMatch(/CHAIN_EXIT_INTERVAL_MS to 400ms or less/);
  });

  it("is a margin, not a threshold: exactly ten times passes, a hair under does not", () => {
    expect(checkExitWindow(750, 30_000).ok).toBe(true);
    expect(checkExitWindow(749, 30_000).ok).toBe(false);
  });

  it("breaks either way round, because it is about the pair", () => {
    // A perfectly good window, read too seldom.
    expect(checkExitWindow(4_500, 30_000).ok).toBe(true);
    expect(checkExitWindow(4_500, 300_000).ok).toBe(false);
  });
});

describe("what the owner's own view says", () => {
  const fresh = async () => {
    const c = await connect();
    await migrate(c.db);
    return c;
  };

  it("says nothing about exits when there is none, which is the ordinary case", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Normal");
    const w = await withdrawable(db, a.id);
    expect(w.exit).toBeNull();
    expect(w.reason).toBeNull();
    expect(w.withdrawable).toBe(900);
    await close();
  });

  it("carries the window while it waits, and closes the instant path", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Waiting");
    chain.requestExit(a.id, 300, 100, 4_500);
    await ingestExits(db, await chain.exits());

    const w = await withdrawable(db, a.id);
    expect(w.exit).toMatchObject({ amount: 300, claimed: false, settled: false, unlockSlot: 4_600 });
    // Thirty minutes of slots from when the row was written.
    expect(w.exit!.unlockAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
    expect(w.exit!.claimable).toBe(false);
    expect(w.reason).toMatch(/exit is waiting on chain/);
    expect(w.withdrawable).toBe(0);
    await close();
  });

  it("says claimable once the window has passed", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Ready");
    chain.requestExit(a.id, 300, 100, 4_500);
    await ingestExits(db, await chain.exits());

    const later = new Date(Date.now() + 31 * 60_000);
    const w = await withdrawable(db, a.id, later);
    expect(w.exit!.claimable).toBe(true);
    await close();
  });

  it("shows a claim as unsettled until the ledger has caught up", async () => {
    const { db, close } = await fresh();
    const chain = new FakeChain();
    const a = await player(db, chain, "Landed");
    chain.claimExit(a.id, 300, 5_000);

    // The chain has paid, and this server has not been told yet.
    await db.insert(exits).values({
      agentId: a.id,
      requestedSlot: 500,
      unlockSlot: 5_000,
      amount: 300,
      claimedSlot: 5_000,
      claimedAmount: 300,
      ingestedAt: null,
    });
    let w = await withdrawable(db, a.id);
    expect(w.exit).toMatchObject({ claimed: true, claimedAmount: 300, settled: false });

    await ingestExits(db, await chain.exits());
    w = await withdrawable(db, a.id);
    expect(w.exit).toMatchObject({ claimed: true, settled: true });
    // Settled means free: the instant path is open again.
    expect(w.reason).toBeNull();
    expect(w.withdrawable).toBe(600);
    await close();
  });
});
