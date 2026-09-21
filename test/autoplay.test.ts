import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { agentEvents, agents, chainOps, matches, withdrawals, bandByName, outflowBudget } from "../src/db/schema.js";
import { record } from "../src/db/ledger.js";
import { createAgent, hasOutflowRoom, pickOpponent, setBand } from "../src/db/runner.js";
import { autoplayStatus, checkAgent, dueAgents, isHold, markSeen, setAutoplay, sinceYouLeft, stopAgent, tick } from "../src/db/autoplay.js";
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

  it("logs a wait once when it starts, with the reason, and how long it lasted when it ends", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db, { band: "C" });
    const lines: string[] = [];
    const onLog = (line: string) => lines.push(line);
    await tick(db, { intervalMs: 0, onLog });
    await tick(db, { intervalMs: 0, onLog });
    // Two retries, one line: a wait is logged when it starts, not on every poll.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(row.id.slice(0, 8));
    expect(lines[0]).toMatch(/waiting: no opponent in the C band/);
    // Waiting alone plays and stops nothing, so there is no tick summary.
    expect(lines.some((l) => l.includes("tick played"))).toBe(false);

    lines.length = 0;
    await house(db, 4, "C");
    await tick(db, { intervalMs: 0, onLog });
    expect(lines[0]).toMatch(/stopped waiting after \d+m/);
    expect(lines[1]).toMatch(/^autoplay: tick played 1, stopped 0, waiting 0 - .* in band C$/);
    await close();
  });

  it("logs a stop with its kind and detail, and summarises the tick", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await db.update(agents).set({ autoplayFloor: 5_000 }).where(eq(agents.id, row.id));
    const lines: string[] = [];
    await tick(db, { intervalMs: 0, onLog: (line) => lines.push(line) });
    expect(lines).toEqual([
      expect.stringMatching(/paused \(floor\): balance \d+ is within one match of your floor \(5000\)$/),
      "autoplay: tick played 0, stopped 1, waiting 0",
    ]);
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

  it("the preset fallback respects the window too, rather than pairing into a refusal", async () => {
    const { db, close } = await fresh();
    const me = await createAgent(db, { name: "Me", presetName: "Anchor", ownerId: someWallet() });
    // Two presets - too few for the closest-rating path, so the fallback decides.
    const spent = await createAgent(db, { name: "SpentPreset", presetName: "Hammer" });
    const room = await createAgent(db, { name: "RoomPreset", presetName: "Mirage" });
    await db.insert(chainOps).values({ kind: "settle", fromAgent: spent.id, amount: outflowBudget(900) });
    // Many draws, because the fallback chooses at random: a spent preset must never come up.
    for (let i = 0; i < 20; i++) {
      const pick = await pickOpponent(db, me.id);
      expect(pick.path).toBe("preset-fallback");
      expect(pick.opponentId).toBe(room.id);
    }
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

describe("autoplay: what the panel says", () => {
  const rowOf = async (db: Awaited<ReturnType<typeof fresh>>["db"], id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

  it("is off until switched on, with no countdown", async () => {
    const { db, close } = await fresh();
    const row = await createAgent(db, { name: "Off", presetName: "Anchor", ownerId: someWallet() });
    const status = await autoplayStatus(db, await rowOf(db, row.id));
    expect(status.state).toBe("off");
    expect(status.nextMatchAt).toBeNull();
    expect(status.message).toBeNull();
    await close();
  });

  it("counts down to the next match from the last one", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    const now = new Date("2026-09-21T12:00:00Z");
    await db.update(agents).set({ autoplayLastMatchAt: new Date(now.getTime() - 4 * 60_000) }).where(eq(agents.id, row.id));
    const status = await autoplayStatus(db, await rowOf(db, row.id), { intervalMs: 10 * 60_000, now });
    expect(status.state).toBe("on");
    expect(status.nextMatchAt!.getTime() - now.getTime()).toBe(6 * 60_000);
    await close();
  });

  it("says a hold clears itself and a pause needs the owner, in those words", async () => {
    const { db, close } = await fresh();
    const held = await playerOn(db);
    await db.insert(withdrawals).values({
      agentId: held.id, ownerId: held.ownerId!, amount: 10, remaining: 890, retire: false,
      preparedTx: "test", lastValidBlockHeight: 1, status: "submitted",
    });
    const h = await autoplayStatus(db, await rowOf(db, held.id));
    expect(h.state).toBe("held");
    expect(h.message).toBe("Held: withdrawal settling, resumes automatically.");
    expect(h.stop).toEqual({ reason: "withdrawal", hold: true });

    const paused = await playerOn(db);
    await db.update(agents).set({ autoplayFloor: 300 }).where(eq(agents.id, paused.id));
    await stopAgent(db, paused.id, "floor");
    const p = await autoplayStatus(db, await rowOf(db, paused.id));
    expect(p.state).toBe("paused");
    expect(p.enabled).toBe(false);
    // The reason with its number, and what the owner has to do.
    expect(p.message).toBe("Paused: one match from your floor (300).");
    expect(p.action).toContain("You need to switch it back on");
    await close();
  });

  it("names the balance and the band's worst match when it cannot cover one", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    await record(db, [{ agentId: row.id, amount: -(900 - 25), reason: "match-settlement" }]);
    await stopAgent(db, row.id, "insolvent");
    const status = await autoplayStatus(db, await rowOf(db, row.id));
    expect(status.message).toBe("Paused: balance 25 can't cover a band B match, which can move up to 40.");
    await close();
  });

  it("does not tell a retired agent's owner to switch it back on", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    await db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, row.id));
    await stopAgent(db, row.id, "retired");
    const status = await autoplayStatus(db, await rowOf(db, row.id));
    expect(status.action).not.toContain("switch it back on");
    await close();
  });

  it("shows how long it has waited, and no countdown while it waits", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db, { band: "C" });
    await tick(db, { intervalMs: 0 });
    const status = await autoplayStatus(db, await rowOf(db, row.id));
    expect(status.state).toBe("waiting");
    expect(status.waitingSince).not.toBeNull();
    expect(status.nextMatchAt).toBeNull();
    await close();
  });

  it("totals today's matches and net as money, house opponents included", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await tick(db, { intervalMs: 0 });
    const [m] = await db.select().from(matches);
    const mine = m!.agentA === row.id ? m!.netA : m!.netB;
    const status = await autoplayStatus(db, await rowOf(db, row.id));
    expect(status.today).toEqual({ matches: 1, net: mine });
    await close();
  });
});

describe("since you left", () => {
  it("is empty until the owner has been seen once", async () => {
    const { db, close } = await fresh();
    const row = await createAgent(db, { name: "New", presetName: "Anchor", ownerId: someWallet() });
    expect(await sinceYouLeft(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!)).toBeNull();
    await close();
  });

  it("counts matches since the owner was last seen, their net, and the best win", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await markSeen(db, row.id, new Date(Date.now() - 60_000));
    for (let i = 0; i < 4; i++) {
      await db.update(agents).set({ autoplayLastMatchAt: null }).where(eq(agents.id, row.id));
      await tick(db, { intervalMs: 0 });
    }
    const played = await db.select().from(matches);
    const nets = played.map((m) => (m.agentA === row.id ? m.netA : m.netB));

    const summary = await sinceYouLeft(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(summary!.matches).toBe(played.length);
    expect(summary!.net).toBe(nets.reduce((a, b) => a + b, 0));
    const best = Math.max(...nets);
    if (best > 0) expect(summary!.bestHand!.net).toBe(best);
    else expect(summary!.bestHand).toBeNull();
    await close();
  });

  it("starts again from the moment the owner dismisses it", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const row = await playerOn(db);
    await markSeen(db, row.id, new Date(Date.now() - 60_000));
    await tick(db, { intervalMs: 0 });
    await markSeen(db, row.id);
    const summary = await sinceYouLeft(db, (await db.select().from(agents).where(eq(agents.id, row.id)))[0]!);
    expect(summary!.matches).toBe(0);
    await close();
  });
});

describe("agent events", () => {
  const eventsOf = async (db: Awaited<ReturnType<typeof fresh>>["db"], id: string) =>
    (await db.select().from(agentEvents).where(eq(agentEvents.agentId, id)).orderBy(agentEvents.createdAt)).map(
      (e) => `${e.source} ${e.kind} ${e.detail}`,
    );
  const reload = async (db: Awaited<ReturnType<typeof fresh>>["db"], id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

  it("records the owner switching autoplay on and off, and a floor change, but not a save that changed nothing", async () => {
    const { db, close } = await fresh();
    const row = await createAgent(db, { name: "Owned", presetName: "Anchor", ownerId: someWallet() });
    await setAutoplay(db, await reload(db, row.id), true, 80);
    await setAutoplay(db, await reload(db, row.id), true, 80);
    await setAutoplay(db, await reload(db, row.id), true, 120);
    await setAutoplay(db, await reload(db, row.id), false, 120);
    expect(await eventsOf(db, row.id)).toEqual([
      "owner autoplay-on floor 80",
      "owner floor floor 120",
      "owner autoplay-off floor 120",
    ]);
    await close();
  });

  it("records a pause as autoplay switching off on its own, and a hold not at all", async () => {
    const { db, close } = await fresh();
    const row = await playerOn(db);
    await stopAgent(db, row.id, "withdrawal");
    await stopAgent(db, row.id, "floor");
    expect(await eventsOf(db, row.id)).toEqual(["autoplay autoplay-off paused: floor"]);
    await close();
  });

  it("records a band change with where it moved from, and not a move to the band it is already in", async () => {
    const { db, close } = await fresh();
    const owner = someWallet();
    const row = await createAgent(db, { name: "Mover", presetName: "Anchor", ownerId: owner });
    await setBand(db, row.id, owner, "A");
    await setBand(db, row.id, owner, "A");
    expect(await eventsOf(db, row.id)).toEqual(["owner band B -> A"]);
    await close();
  });
});
