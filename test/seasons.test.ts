import { describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agentEvents, agents, ledger, matches, ratings, seasonStandings, seasons } from "../src/db/schema.js";
import { createAgent, pickOpponent, runMatch } from "../src/db/runner.js";
import { dueAgents } from "../src/db/autoplay.js";
import { StakeError } from "../src/db/ledger.js";
import { nextSeason, seasonAt, GRACE_MS, RENEWAL_REMINDER_MS } from "../src/season.js";
import { closeSeason, lapseExpired, renewAgent, rentalStatus, seasonTick } from "../src/db/seasons.js";
import { standings } from "../src/db/standings.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

const house = async (db: Db, n: number) => {
  for (let i = 0; i < n; i++) {
    await createAgent(db, { name: `H${i}-${Math.random().toString(36).slice(2, 6)}`, presetName: (["Anchor", "Hammer", "Mirage", "Bully"] as const)[i % 4]! });
  }
};

/** Ends an agent's rental a minute ago, as the season boundary would. */
const expire = (db: Db, id: string) =>
  db.update(agents).set({ rentalEndsAt: new Date(Date.now() - 60_000) }).where(eq(agents.id, id));

describe("rentals end at the season boundary", () => {
  it("ends a player's rental at the end of the season it is rented in, and never a house agent's", async () => {
    const { db, close } = await fresh();
    const now = new Date();
    const player = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    const h = await createAgent(db, { name: "H", presetName: "Anchor" });
    expect(player.rentalEndsAt?.getTime()).toBe(seasonAt(now).end.getTime());
    expect(h.rentalEndsAt).toBeNull();
    // Renting on the season's last Sunday still ends at that Monday, not a week later.
    const late = await createAgent(db, { name: "Late", presetName: "Anchor", ownerId: someWallet(), now: new Date("2026-09-27T23:50:00Z") });
    expect(late.rentalEndsAt?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    await close();
  });

  it("records each match in the season it was played in", async () => {
    const { db, close } = await fresh();
    await house(db, 1);
    const player = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    const [opp] = await db.select().from(agents).where(isNull(agents.ownerId));
    const { match } = await runMatch(db, player.id, opp!.id, { seed: 3 });
    expect(match.season).toBe(seasonAt(match.createdAt).key);
    await close();
  });

  it("refuses to record a match for an agent whose rental has ended, and moves nothing", async () => {
    const { db, close } = await fresh();
    await house(db, 1);
    const [h] = await db.select().from(agents);
    const player = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    await expire(db, player.id);
    await expect(runMatch(db, player.id, h!.id)).rejects.toThrow(StakeError);
    await expect(runMatch(db, h!.id, player.id)).rejects.toThrow(/rental ended with the season/);
    expect(await db.select().from(matches)).toHaveLength(0);
    expect((await db.select().from(ledger).where(eq(ledger.agentId, player.id))).map((r) => r.reason)).toEqual(["rental-seed"]);
    await close();
  });

  it("leaves an expired agent out of matchmaking and out of the scheduler", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const me = await createAgent(db, { name: "Me", presetName: "Anchor", ownerId: someWallet() });
    const gone = await createAgent(db, { name: "Gone", presetName: "Bully", ownerId: someWallet() });
    await db.update(agents).set({ autoplay: true }).where(eq(agents.id, gone.id));
    await expire(db, gone.id);
    for (let i = 0; i < 10; i++) expect((await pickOpponent(db, me.id)).opponentId).not.toBe(gone.id);
    expect((await pickOpponent(db, me.id)).candidates).toBe(4);
    expect(await dueAgents(db, 0)).toHaveLength(0);
    await expect(pickOpponent(db, gone.id)).rejects.toThrow(/renew it to play/);
    await close();
  });
});

describe("the season boundary", () => {
  /** Two players who have played each other, and a house agent they have both played. */
  const season = async (db: Db) => {
    await house(db, 4);
    const [h] = await db.select().from(agents).where(isNull(agents.ownerId));
    const a = await createAgent(db, { name: "A", presetName: "Hammer", ownerId: someWallet() });
    const b = await createAgent(db, { name: "B", presetName: "Mirage", ownerId: someWallet() });
    for (let seed = 1; seed <= 6; seed++) await runMatch(db, a.id, b.id, { seed });
    await runMatch(db, a.id, h!.id, { seed: 7 });
    await runMatch(db, b.id, h!.id, { seed: 8 });
    return { a, b, current: seasonAt(new Date()) };
  };
  const eventsOf = async (db: Db, id: string) =>
    // Sorted: events written in one transaction share a timestamp, so their order is not the point.
    (await db.select().from(agentEvents).where(eq(agentEvents.agentId, id))).map((e) => `${e.source} ${e.kind}`).sort();

  it("freezes standings with the same figures the all-time ladder keeps, when every match is in one season", async () => {
    const { db, close } = await fresh();
    const { a, b, current } = await season(db);
    const result = await closeSeason(db, current.key, current.end);
    expect(result).toMatchObject({ closed: true, standings: 2 });
    const frozen = await db.select().from(seasonStandings).where(eq(seasonStandings.season, current.key)).orderBy(seasonStandings.rank);
    expect(frozen.map((r) => r.rank)).toEqual([1, 2]);
    for (const row of frozen) {
      const [r] = await db.select().from(ratings).where(eq(ratings.agentId, row.agentId));
      expect(row.rankedMatches).toBe(r!.rankedMatches);
      expect(row.rankedNet).toBe(r!.rankedNet);
      expect(row.totalMatches).toBe(r!.matchesPlayed);
      expect(row.totalNet).toBe(r!.cumulativeNet);
    }
    // Ranked excludes the house match each played; the totals include it.
    expect(frozen.every((r) => r.totalMatches === r.rankedMatches + 1)).toBe(true);
    expect(new Set(frozen.map((r) => r.agentId))).toEqual(new Set([a.id, b.id]));
    // The next season exists, and this one is closed.
    const [row] = await db.select().from(seasons).where(eq(seasons.key, current.key));
    expect(row!.status).toBe("closed");
    expect((await db.select().from(seasons).where(eq(seasons.key, nextSeason(current).key)))).toHaveLength(1);
    await close();
  });

  it("closes exactly once: a second run, as after a restart, changes nothing", async () => {
    const { db, close } = await fresh();
    const { a, current } = await season(db);
    await db.update(agents).set({ autoplay: true }).where(eq(agents.id, a.id));
    await closeSeason(db, current.key, current.end);
    const before = { standings: await db.select().from(seasonStandings), events: await db.select().from(agentEvents) };
    const again = await closeSeason(db, current.key, new Date(current.end.getTime() + 60_000));
    expect(again.closed).toBe(false);
    expect(await db.select().from(seasonStandings)).toEqual(before.standings);
    expect(await db.select().from(agentEvents)).toEqual(before.events);
    // And a season that has not ended cannot be closed early.
    await expect(closeSeason(db, nextSeason(current).key, current.end)).rejects.toThrow(/has not ended/);
    await close();
  });

  it("expires whoever was not renewed, and stops autoplay for everyone, keeping band and floor", async () => {
    const { db, close } = await fresh();
    const { a, b, current } = await season(db);
    // B's owner renewed; A's did not. Both were on autoplay.
    await db.update(agents).set({ rentalEndsAt: nextSeason(current).end }).where(eq(agents.id, b.id));
    await db.update(agents).set({ autoplay: true, autoplayFloor: 300 });
    await closeSeason(db, current.key, current.end);

    expect(await eventsOf(db, a.id)).toEqual(["season autoplay-off", "season expired"]);
    expect(await eventsOf(db, b.id)).toEqual(["season autoplay-off"]);
    for (const id of [a.id, b.id]) {
      const [row] = await db.select().from(agents).where(eq(agents.id, id));
      expect(row!.autoplay).toBe(false);
      expect(row!.autoplayStoppedReason).toBe("season");
      expect(row!.autoplayFloor).toBe(300);
      expect(row!.band).toBe("B");
      expect(row!.retiredAt).toBeNull();
    }
    await close();
  });

  it("lapses an expired agent once its 24 hours are up, and only once", async () => {
    const { db, close } = await fresh();
    const { a, b, current } = await season(db);
    await db.update(agents).set({ rentalEndsAt: nextSeason(current).end }).where(eq(agents.id, b.id));
    await closeSeason(db, current.key, current.end);

    expect(await lapseExpired(db, new Date(current.end.getTime() + GRACE_MS - 1))).toEqual([]);
    expect(await lapseExpired(db, new Date(current.end.getTime() + GRACE_MS))).toEqual([a.id]);
    expect(await lapseExpired(db, new Date(current.end.getTime() + GRACE_MS + 60_000))).toEqual([]);
    const [row] = await db.select().from(agents).where(eq(agents.id, a.id));
    expect(row!.retiredReason).toBe("lapsed");
    expect(await eventsOf(db, a.id)).toContain("season lapsed");
    // The standings were frozen at the boundary and the grace period did not touch them.
    expect(await db.select().from(seasonStandings).where(eq(seasonStandings.agentId, a.id))).toHaveLength(1);
    await close();
  });

  it("catches up after downtime: one pass closes every ended season, opens the current one and lapses", async () => {
    const { db, close } = await fresh();
    const { a, current } = await season(db);
    // The api was down from before the boundary until two days after it.
    const later = new Date(current.end.getTime() + 2 * GRACE_MS);
    const tick = await seasonTick(db, later);
    expect(tick.closed.map((c) => c.key)).toEqual([current.key]);
    expect(tick.lapsed).toContain(a.id);
    expect((await db.select().from(seasons).where(eq(seasons.key, seasonAt(later).key)))[0]!.status).toBe("open");
    expect((await seasonTick(db, later)).closed).toEqual([]);
    await close();
  });

  it("counts a season's matches only, so a later season starts from nothing", async () => {
    const { db, close } = await fresh();
    const { current } = await season(db);
    expect((await standings(db, { season: current.key })).length).toBe(2);
    expect(await standings(db, { season: nextSeason(current).key })).toEqual([]);
    await close();
  });
});

describe("renewal", () => {
  const owned = async (db: Db) => {
    const ownerId = someWallet();
    const row = await createAgent(db, { name: "R", presetName: "Anchor", ownerId });
    return { row, ownerId, current: seasonAt(new Date()) };
  };

  it("renews an active rental into the next season, once, and reminds in the last 72 hours", async () => {
    const { db, close } = await fresh();
    const { row, ownerId, current } = await owned(db);
    const early = new Date(current.end.getTime() - RENEWAL_REMINDER_MS - 60_000);
    const late = new Date(current.end.getTime() - RENEWAL_REMINDER_MS + 60_000);
    expect(rentalStatus(row, early)).toMatchObject({ state: "active", remind: false, canRenew: true });
    expect(rentalStatus(row, late)).toMatchObject({ state: "active", remind: true });

    const after = await renewAgent(db, row.id, ownerId, late);
    expect(after.state).toBe("renewed");
    expect(after.endsAt?.getTime()).toBe(nextSeason(current).end.getTime());
    await expect(renewAgent(db, row.id, ownerId, late)).rejects.toThrow(/already renewed/);
    await expect(renewAgent(db, row.id, someWallet(), late)).rejects.toThrow(/someone else/);
    await close();
  });

  it("restores an expired agent within 24 hours, record and settings intact, with autoplay left off", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const { row, ownerId, current } = await owned(db);
    const [h] = await db.select().from(agents).where(isNull(agents.ownerId));
    await runMatch(db, row.id, h!.id, { seed: 5 });
    const [record] = await db.select().from(ratings).where(eq(ratings.agentId, row.id));
    // It expired at the start of this season: the boundary passed without a renewal.
    await db.update(agents).set({ rentalEndsAt: current.start, autoplayFloor: 250, band: "A" }).where(eq(agents.id, row.id));
    const inGrace = new Date(current.start.getTime() + GRACE_MS - 60_000);
    const [expiredRow] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(rentalStatus(expiredRow!, inGrace)).toMatchObject({ state: "expired", canRenew: true });
    expect(rentalStatus(expiredRow!, inGrace).graceEndsAt?.getTime()).toBe(current.start.getTime() + GRACE_MS);

    const after = await renewAgent(db, row.id, ownerId, inGrace);
    // Back for the season now running, not the next one.
    expect(after).toMatchObject({ state: "active" });
    expect(after.endsAt?.getTime()).toBe(current.end.getTime());
    const [restored] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(restored!).toMatchObject({ autoplay: false, autoplayFloor: 250, band: "A", retiredAt: null });
    expect((await db.select().from(ratings).where(eq(ratings.agentId, row.id)))[0]).toEqual(record);
    await close();
  });

  it("refuses once the grace period is over, and after the agent has lapsed", async () => {
    const { db, close } = await fresh();
    const { row, ownerId, current } = await owned(db);
    await db.update(agents).set({ rentalEndsAt: current.start }).where(eq(agents.id, row.id));
    const pastGrace = new Date(current.start.getTime() + GRACE_MS + 60_000);
    await expect(renewAgent(db, row.id, ownerId, pastGrace)).rejects.toThrow(/grace period is over/);
    await lapseExpired(db, pastGrace);
    await expect(renewAgent(db, row.id, ownerId, pastGrace)).rejects.toThrow(/lapsed/);
    await close();
  });
});
