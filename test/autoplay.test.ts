import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { agents, chainOps, matches, withdrawals, bandByName, outflowBudget } from "../src/db/schema.js";
import { record } from "../src/db/ledger.js";
import { createAgent, hasOutflowRoom, pickOpponent } from "../src/db/runner.js";
import { checkAgent, dueAgents, isHold, stopAgent, tick } from "../src/db/autoplay.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

/** A player agent with autoplay already switched on, as the owner would leave it. */
type Overrides = Partial<Parameters<typeof createAgent>[1]>;

const playerOn = async (db: Awaited<ReturnType<typeof fresh>>["db"], opts: Overrides = {}) => {
  const row = await createAgent(db, { name: `P${Math.random().toString(36).slice(2, 7)}`, presetName: "Anchor", ownerId: someWallet(), ...opts });
  await db.update(agents).set({ autoplay: true }).where(eq(agents.id, row.id));
  return row;
};

/** House opponents, so a player agent has someone to meet. */
const house = async (db: Awaited<ReturnType<typeof fresh>>["db"], n: number, band: "A" | "B" | "C" = "B") => {
  for (let i = 0; i < n; i++) {
    await createAgent(db, { name: `H${i}-${Math.random().toString(36).slice(2, 6)}`, presetName: (["Anchor", "Hammer", "Mirage", "Bully"] as const)[i % 4]!, band });
  }
};

describe("autoplay: who is due", () => {
  it("never selects a house agent: they have their own loop and stake nothing", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    // Even with the flag forced on, an agent with no owner is not autoplayed.
    await db.update(agents).set({ autoplay: true });
    expect(await dueAgents(db, 1000)).toHaveLength(0);
    await close();
  });

  it("starts paused: a freshly rented agent is not due until its owner turns it on", async () => {
    const { db, close } = await fresh();
    const row = await createAgent(db, { name: "Fresh", presetName: "Anchor", ownerId: someWallet() });
    expect(row.autoplay).toBe(false);
    expect(await dueAgents(db, 0)).toHaveLength(0);
    await close();
  });

  it("paces per agent from its own last match, not from a shared clock", async () => {
    const { db, close } = await fresh();
    const a = await playerOn(db);
    const b = await playerOn(db);
    const now = new Date();
    // a played one minute ago, b eleven.
    await db.update(agents).set({ autoplayLastMatchAt: new Date(now.getTime() - 60_000) }).where(eq(agents.id, a.id));
    await db.update(agents).set({ autoplayLastMatchAt: new Date(now.getTime() - 11 * 60_000) }).where(eq(agents.id, b.id));
    const due = await dueAgents(db, 10 * 60_000, now);
    expect(due.map((r) => r.id)).toEqual([b.id]);
    await close();
  });
});

describe("autoplay: safety", () => {
  it("pauses before a match that could breach the floor, not after one that did", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    const worst = bandByName("B").worstMatch;
    const balance = 900;
    // A floor one chip above (balance - worst) must stop it, even though the
    // balance is still comfortably above the floor itself.
    await db.update(agents).set({ autoplayFloor: balance - worst + 1 }).where(eq(agents.id, row.id));
    const stop = await checkAgent(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(stop.play).toBe(false);
    if (!stop.play) {
      expect(stop.reason).toBe("floor");
      expect(stop.detail).toContain("within one match of your floor");
    }

    // One chip lower and the worst case still clears it, so it plays.
    await db.update(agents).set({ autoplayFloor: balance - worst }).where(eq(agents.id, row.id));
    const ok = await checkAgent(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(ok.play).toBe(true);
    await close();
  });

  it("pauses when the balance can no longer cover the band's worst match", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    const worst = bandByName("B").worstMatch;
    await record(db, [{ agentId: row.id, amount: -(900 - worst + 1), reason: "match-settlement" }]);
    const stop = await checkAgent(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(stop.play).toBe(false);
    if (!stop.play) expect(stop.reason).toBe("insolvent");
    await close();
  });

  it("holds while a withdrawal is settling, and the hold leaves autoplay on", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    await db.insert(withdrawals).values({ agentId: row.id, ownerId: row.ownerId!, amount: 10, remaining: 890, retire: false, preparedTx: "test", lastValidBlockHeight: 1, status: "submitted" });
    const stop = await checkAgent(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(stop.play).toBe(false);
    if (!stop.play) {
      expect(stop.reason).toBe("withdrawal");
      expect(isHold(stop.reason)).toBe(true);
    }
    await stopAgent(db, row.id, "withdrawal");
    const [after] = await db.select().from(agents).where(eq(agents.id, row.id));
    // The distinction the panel depends on: still on, so it resumes by itself.
    expect(after!.autoplay).toBe(true);
    expect(after!.autoplayStoppedReason).toBe("withdrawal");
    await close();
  });

  it("a pause turns autoplay off, so only the owner restarts it", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    await stopAgent(db, row.id, "floor");
    const [after] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(after!.autoplay).toBe(false);
    expect(after!.autoplayStoppedReason).toBe("floor");
    expect(isHold("floor")).toBe(false);
    await close();
  });

  it("pauses a retired agent", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    await db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, row.id));
    const stop = await checkAgent(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(stop.play).toBe(false);
    if (!stop.play) expect(stop.reason).toBe("retired");
    await close();
  });
});

describe("autoplay: the tick", () => {
  it("plays one match for a due agent and schedules the next from that moment", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    const result = await tick(db, { intervalMs: 0 });
    expect(result.played).toEqual([row.id]);
    expect((await db.select().from(matches))[0]!.exhibition).toBe(false);
    const [after] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(after!.autoplayLastMatchAt).not.toBeNull();
    // Not due again until the interval has passed.
    expect(await dueAgents(db, 10 * 60_000)).toHaveLength(0);
    await close();
  });

  it("waits rather than pausing when the band has nobody, and keeps the wait time", async () => {
    const { db, close } = await fresh();
    // An empty band C: the agent is solvent and willing, with no opponent.
    const row = await playerOn(db, { band: "C" });
    const first = await tick(db, { intervalMs: 0 });
    expect(first.waiting).toEqual([row.id]);
    expect(first.stopped).toEqual([]);
    const [waiting] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(waiting!.autoplay).toBe(true);
    expect(waiting!.autoplayWaitingSince).not.toBeNull();
    expect(waiting!.band).toBe("C");

    // Still waiting on the next tick, and the original wait time is kept, so
    // the panel can say how long it has been rather than restarting the clock.
    const started = waiting!.autoplayWaitingSince;
    await tick(db, { intervalMs: 0 });
    const [again] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(again!.autoplayWaitingSince?.getTime()).toBe(started?.getTime());

    // An opponent appears: it plays, and the wait is cleared.
    await house(db, 4, "C");
    const played = await tick(db, { intervalMs: 0 });
    expect(played.played).toEqual([row.id]);
    const [done] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(done!.autoplayWaitingSince).toBeNull();
    await close();
  });

  it("stops a due agent that cannot play, and records which kind of stop", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await db.update(agents).set({ autoplayFloor: 5_000 }).where(eq(agents.id, row.id));
    const result = await tick(db, { intervalMs: 0 });
    expect(result.stopped).toEqual([{ agentId: row.id, reason: "floor" }]);
    expect(result.played).toEqual([]);
    expect((await db.select().from(matches))).toHaveLength(0);
    await close();
  });

  it("plays player against house: an autoplayer is not stranded by an empty player pool", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await tick(db, { intervalMs: 0 });
    const [match] = await db.select().from(matches);
    const other = match!.agentA === row.id ? match!.agentB : match!.agentA;
    const [opponent] = await db.select().from(agents).where(eq(agents.id, other));
    expect(opponent!.ownerId).toBeNull();
    // It still settles for money: a house opponent is not an exhibition.
    expect(match!.exhibition).toBe(false);
    await close();
  });
});

describe("autoplay: the popular-opponent budget", () => {
  it("counts what a vault has already committed, and refuses a loss that would not fit", async () => {
    const { db, close } = await fresh();
    const row = await createAgent(db, { name: "Popular", presetName: "Anchor", ownerId: someWallet() });
    const worst = bandByName("B").worstMatch;
    expect(await hasOutflowRoom(db, row.id, worst)).toBe(true);

    // Fill the window to one chip short of what a full loss needs.
    const budget = outflowBudget(900);
    await db.insert(chainOps).values({ kind: "settle", fromAgent: row.id, amount: budget - worst + 1 });
    expect(await hasOutflowRoom(db, row.id, worst)).toBe(false);
    await close();
  });

  it("a settlement the chain refused still counts against the window", async () => {
    const { db, close } = await fresh();
    const row = await createAgent(db, { name: "Refused", presetName: "Anchor", ownerId: someWallet() });
    const worst = bandByName("B").worstMatch;
    // 'failed' is the one status that does not count: the chain never took it.
    await db.insert(chainOps).values({ kind: "settle", fromAgent: row.id, amount: outflowBudget(900), status: "failed" });
    expect(await hasOutflowRoom(db, row.id, worst)).toBe(true);
    await close();
  });

  it("leaves a spent opponent out of matchmaking rather than pairing into a refusal", async () => {
    const { db, close } = await fresh();
    const me = await createAgent(db, { name: "Me", presetName: "Anchor", ownerId: someWallet() });
    const spent = await createAgent(db, { name: "Spent", presetName: "Hammer" });
    const fresh2 = await createAgent(db, { name: "Fresh", presetName: "Mirage" });
    // Everyone else is out of window, so matchmaking has one legal choice.
    await db.insert(chainOps).values({ kind: "settle", fromAgent: spent.id, amount: outflowBudget(900) });
    const pick = await pickOpponent(db, me.id, { minCandidates: 1 });
    expect(pick.opponentId).toBe(fresh2.id);
    await close();
  });

  it("refuses to play an agent whose own vault has no room left", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await db.insert(chainOps).values({ kind: "settle", fromAgent: row.id, amount: outflowBudget(900) });
    const result = await tick(db, { intervalMs: 0 });
    // Waiting, not paused: the window passes on its own.
    expect(result.waiting).toEqual([row.id]);
    const [after] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(after!.autoplay).toBe(true);
    await close();
  });
});
