import { describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { agents, chainOps, ledger, matches, ratings } from "../src/db/schema.js";
import { balanceOf } from "../src/db/ledger.js";
import { createAgent, runExhibition, runMatch } from "../src/db/runner.js";
import { agentRecord, matchActivity, recentMatches } from "../src/db/feed.js";
import { pickHousePair, startHouseExhibitions } from "../src/db/house.js";
import { StakeError } from "../src/db/ledger.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

describe("house exhibitions", () => {
  it("record a match and move nothing: no ledger, no chain, no balance, no rating", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const b = await createAgent(db, { name: "HouseB", presetName: "Bully" });
    const count0 = async (t: typeof ledger | typeof chainOps) => (await db.select({ n: count() }).from(t))[0]!.n;
    const [ledgerBefore, opsBefore] = [await count0(ledger), await count0(chainOps)];
    const [balA, balB] = [await balanceOf(db, a.id), await balanceOf(db, b.id)];

    for (let seed = 1; seed <= 5; seed++) await runExhibition(db, a.id, b.id, { seed });

    expect(await count0(ledger)).toBe(ledgerBefore);
    expect(await count0(chainOps)).toBe(opsBefore);
    expect(await balanceOf(db, a.id)).toBe(balA);
    expect(await balanceOf(db, b.id)).toBe(balB);
    const [rating] = await db.select().from(ratings).where(eq(ratings.agentId, a.id));
    expect(rating?.matchesPlayed ?? 0).toBe(0);
    expect(await agentRecord(db, a.id)).toEqual({ wins: 0, losses: 0, level: 0 });

    const feed = await recentMatches(db, { limit: 10 });
    expect(feed).toHaveLength(5);
    expect(feed.every((m) => m.exhibition)).toBe(true);
    await close();
  });

  it("never count toward a rating or record once the agent plays a real match", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const b = await createAgent(db, { name: "HouseB", presetName: "Bully" });
    for (let seed = 1; seed <= 4; seed++) await runExhibition(db, a.id, b.id, { seed });
    const { settled } = await runMatch(db, a.id, b.id, { seed: 99 });

    const [rating] = await db.select().from(ratings).where(eq(ratings.agentId, a.id));
    expect(rating!.matchesPlayed).toBe(1);
    expect(rating!.cumulativeNet).toBe(settled.A);
    const record = await agentRecord(db, a.id);
    expect(record.wins + record.losses + record.level).toBe(1);
    await close();
  });

  it("refuses player agents: an exhibition only ever involves the house", async () => {
    const { db, close } = await fresh();
    const house = await createAgent(db, { name: "House", presetName: "Anchor" });
    const mine = await createAgent(db, { name: "Mine", presetName: "Hammer", ownerId: someWallet() });
    await expect(runExhibition(db, house.id, mine.id)).rejects.toThrow(StakeError);
    await expect(runExhibition(db, house.id, house.id)).rejects.toThrow(StakeError);
    expect((await db.select({ n: count() }).from(matches))[0]!.n).toBe(0);
    await close();
  });

  it("spreads pairings across the roster instead of repeating one matchup", async () => {
    const { db, close } = await fresh();
    for (let i = 0; i < 6; i++) await createAgent(db, { name: `H${i}`, presetName: (["Anchor", "Bully", "Mirage"] as const)[i % 3]! });
    await createAgent(db, { name: "Player", presetName: "Hammer", ownerId: someWallet() });
    let state = 7;
    const random = (n: number) => (state = (state * 1103515245 + 12345) % 2 ** 31) % n;

    const pairs: string[] = [];
    for (let i = 0; i < 15; i++) {
      const pair = await pickHousePair(db, random);
      expect(pair).not.toBeNull();
      await runExhibition(db, pair![0], pair![1], { seed: i + 1 });
      pairs.push([...pair!].sort().join("|"));
    }
    // 6 agents make 15 possible pairs; the picker should reach most of them without repeats piling up.
    expect(new Set(pairs).size).toBeGreaterThanOrEqual(12);
    const plays = new Map<string, number>();
    for (const p of pairs) for (const id of p.split("|")) plays.set(id, (plays.get(id) ?? 0) + 1);
    expect(Math.max(...plays.values()) - Math.min(...plays.values())).toBeLessThanOrEqual(2);
    const player = (await db.select().from(agents).where(eq(agents.name, "Player")))[0]!;
    expect(plays.has(player.id)).toBe(false);
    await close();
  });

  // The wait below is the point of the test, so its budget has to be comfortably
  // inside the timeout: at the default 5s they were equal, and a loaded suite
  // failed here for no reason but contention.
  it("only pairs agents in the same band, and does not stall on a freshly seeded one", async () => {
    const { db, close } = await fresh();
    // The shape production had: a full band B, fresh agents on zero plays in A
    // and C, and one agent alone in its band with nobody to meet.
    const band = new Map<string, string>();
    for (const [b, n] of [["B", 6], ["A", 3], ["C", 3]] as const) {
      for (let i = 0; i < n; i++) {
        const row = await createAgent(db, { name: `${b}${i}`, presetName: "Anchor", band: b });
        band.set(row.id, b);
      }
    }

    // Run the real loop's own steps: pick, then play. Every pick must be
    // playable, so no exhibition is ever refused and every agent gets a turn.
    const played = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const pair = await pickHousePair(db);
      expect(pair).not.toBeNull();
      const [x, y] = pair!;
      expect(band.get(x)).toBe(band.get(y));
      await runExhibition(db, x, y, { seed: k + 1 });
      played.add(x).add(y);
    }
    // Nobody is stuck on zero - the fresh A and C agents included.
    expect(played.size).toBe(band.size);
    await close();
  });

  it("leaves out a band with nobody to pair, and anyone too poor for their own band", async () => {
    const { db, close } = await fresh();
    const b1 = await createAgent(db, { name: "B1", presetName: "Anchor", band: "B" });
    const b2 = await createAgent(db, { name: "B2", presetName: "Bully", band: "B" });
    // Alone in band C: there is no one it could meet.
    const lonely = await createAgent(db, { name: "C1", presetName: "Hammer", band: "C" });
    // In band B with too little to cover a band B match.
    const poor = await createAgent(db, { name: "Poor", presetName: "Mirage", band: "B", startingBalance: 39 });

    for (let k = 0; k < 20; k++) {
      const pair = await pickHousePair(db);
      expect(pair).not.toBeNull();
      expect([...pair!].sort()).toEqual([b1.id, b2.id].sort());
      expect(pair).not.toContain(lonely.id);
      expect(pair).not.toContain(poor.id);
    }
    await close();
  });

  it("schedules nothing when no band holds two agents that could play", async () => {
    const { db, close } = await fresh();
    await createAgent(db, { name: "OnlyA", presetName: "Anchor", band: "A" });
    await createAgent(db, { name: "OnlyC", presetName: "Bully", band: "C" });
    expect(await pickHousePair(db)).toBeNull();
    await close();
  });

  it("keeps playing when run the way the server runs it, with no callbacks", async () => {
    const { db, close } = await fresh();
    for (let i = 0; i < 3; i++) await createAgent(db, { name: `H${i}`, presetName: "Anchor" });
    const loop = startHouseExhibitions(db, { intervalMs: 20 });
    try {
      const deadline = Date.now() + 5000;
      let n = 0;
      while (Date.now() < deadline && n < 3) {
        await new Promise((r) => setTimeout(r, 50));
        n = (await db.select({ n: count() }).from(matches))[0]!.n;
      }
      expect(n).toBeGreaterThanOrEqual(3);
    } finally {
      loop.stop();
    }
    await close();
  }, 20_000);

  it("leave platform activity to staked matches only", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const b = await createAgent(db, { name: "HouseB", presetName: "Bully" });
    for (let seed = 1; seed <= 3; seed++) await runExhibition(db, a.id, b.id, { seed });
    expect(await matchActivity(db)).toEqual({ stakedMatches: 0, totalStaked: 0, largestPot: 0, exhibitions: 3 });

    const played = await runMatch(db, a.id, b.id, { seed: 5 });
    const activity = await matchActivity(db);
    expect(activity.stakedMatches).toBe(1);
    expect(activity.totalStaked).toBe(played.stake * 2);
    expect(activity.largestPot).toBe(Math.abs(played.settled.A));
    expect(activity.exhibitions).toBe(3);
    await close();
  });
});
