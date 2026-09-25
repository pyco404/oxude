import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { chainOps, ledger, matches, ratings } from "../src/db/schema.js";
import { createAgent, leaderboard, runMatch, runExhibition } from "../src/db/runner.js";
import { someWallet } from "./helpers.js";
import { balanceOf } from "../src/db/ledger.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

const ratingOf = async (db: Awaited<ReturnType<typeof fresh>>["db"], agentId: string) =>
  (await db.select().from(ratings).where(eq(ratings.agentId, agentId)))[0]!;

describe("only player-versus-player matches are ranked", () => {
  it("plays a match against a house agent for nothing: no stake, no ladder, no money", async () => {
    const { db, close } = await fresh();
    const mine = await createAgent(db, { name: "Mine", presetName: "Anchor", ownerId: someWallet() });
    const houseAgent = await createAgent(db, { name: "House", presetName: "Hammer" });
    const mineBefore = await balanceOf(db, mine.id);
    const houseBefore = await balanceOf(db, houseAgent.id);

    const { match } = await runMatch(db, mine.id, houseAgent.id, { seed: 7 });
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
    // A house agent's money is the platform's, so a staked match against one is
    // the platform gambling with itself against its own customers. The match is
    // still played and still has a transcript; nothing moves.
    expect(row!.ranked).toBe(false);
    expect(row!.exhibition).toBe(true);
    expect(await balanceOf(db, mine.id)).toBe(mineBefore);
    expect(await balanceOf(db, houseAgent.id)).toBe(houseBefore);
    // Nothing was queued for the chain either, because nothing moved.
    expect(await db.select().from(chainOps).where(eq(chainOps.matchId, match.id))).toHaveLength(0);

    const r = await ratingOf(db, mine.id);
    // Counted nowhere: not the ladder's figures, and not the total beside them.
    expect(r.matchesPlayed).toBe(0);
    expect(r.cumulativeNet).toBe(0);
    expect(r.rankedMatches).toBe(0);
    await close();
  });

  it("marks a match between two rented agents ranked, and counts it in both", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "A", presetName: "Anchor", ownerId: someWallet() });
    const b = await createAgent(db, { name: "B", presetName: "Bully", ownerId: someWallet() });

    const { match, stake, settled } = await runMatch(db, a.id, b.id, { seed: 11 });
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
    expect(row!.ranked).toBe(true);

    const r = await ratingOf(db, a.id);
    expect(r.rankedMatches).toBe(1);
    expect(r.rankedNet).toBe(settled.A);
    expect(r.rankedStaked).toBe(stake);
    // Totals include it too: a ranked match is still a staked match.
    expect(r.matchesPlayed).toBe(1);
    expect(r.cumulativeNet).toBe(settled.A);
    await close();
  });

  it("an exhibition counts in neither", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "H1", presetName: "Anchor" });
    const b = await createAgent(db, { name: "H2", presetName: "Mirage" });
    await runExhibition(db, a.id, b.id, { seed: 3 });
    const r = await db.select().from(ratings).where(eq(ratings.agentId, a.id));
    expect(r[0]?.matchesPlayed ?? 0).toBe(0);
    expect(r[0]?.rankedMatches ?? 0).toBe(0);
    await close();
  });

  it("leaves nothing to farm: playing the house earns nothing at all", async () => {
    const { db, close } = await fresh();
    const farmer = await createAgent(db, { name: "Farmer", presetName: "Hammer", ownerId: someWallet() });
    const honest = await createAgent(db, { name: "Honest", presetName: "Anchor", ownerId: someWallet() });
    const rival = await createAgent(db, { name: "Rival", presetName: "Bully", ownerId: someWallet() });
    const houseA = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const farmerBefore = await balanceOf(db, farmer.id);

    // The farmer only ever plays the house; the other two play each other.
    for (let seed = 1; seed <= 6; seed++) await runMatch(db, farmer.id, houseA.id, { seed });
    for (let seed = 20; seed <= 25; seed++) await runMatch(db, honest.id, rival.id, { seed });

    const rows = await leaderboard(db, 50, "winnings");
    // Players only: the house agent is not listed at all.
    expect(rows.find((r) => r.name === "HouseA")).toBeUndefined();

    const farmerRow = rows.find((r) => r.name === "Farmer")!;
    // The ladder's figures were already immune to this. What is new is that
    // there is no money either: six matches against the house move nothing, so
    // the farmer's own balance is exactly where it started. The weakness of a
    // fixed preset is computable, so beating one was never evidence of
    // anything - now it is not even profitable.
    expect(farmerRow.matchesPlayed).toBe(0);
    expect(Number(farmerRow.cumulativeNet)).toBe(0);
    expect(farmerRow.totalMatches).toBe(0);
    expect(Number(farmerRow.totalNet)).toBe(0);
    expect(await balanceOf(db, farmer.id)).toBe(farmerBefore);

    // Two players against each other is the only thing that counts.
    const honestRow = rows.find((r) => r.name === "Honest")!;
    expect(honestRow.matchesPlayed).toBe(6);
    expect(honestRow.totalMatches).toBe(6);
    await close();
  });

  it("per-match needs a ranked match to divide by, not merely a staked one", async () => {
    const { db, close } = await fresh();
    const farmer = await createAgent(db, { name: "Farmer", presetName: "Hammer", ownerId: someWallet() });
    const houseA = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    for (let seed = 1; seed <= 4; seed++) await runMatch(db, farmer.id, houseA.id, { seed });

    const rows = await leaderboard(db, 50, "per-match");
    // Six staked matches, no ranked ones: absent from the per-match ladder.
    expect(rows.find((r) => r.name === "Farmer")).toBeUndefined();
    await close();
  });

  it("stakes only when both sides belong to players, which is the same question as ranked", async () => {
    const { db, close } = await fresh();
    const p1 = await createAgent(db, { name: "P1", presetName: "Anchor", ownerId: someWallet() });
    const p2 = await createAgent(db, { name: "P2", presetName: "Bully", ownerId: someWallet() });
    const houseAgent = await createAgent(db, { name: "House", presetName: "Mirage" });

    // Every combination, and the two answers never disagree: a match is played
    // for money exactly when it is played for the ladder.
    for (const [x, y] of [
      [p1, p2],
      [p1, houseAgent],
      [houseAgent, p1],
    ] as const) {
      const { match } = await runMatch(db, x.id, y.id, { seed: 11 });
      const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
      const bothPlayers = x.ownerId !== null && y.ownerId !== null;
      expect(row!.ranked).toBe(bothPlayers);
      expect(row!.exhibition).toBe(!bothPlayers);
      // And the ledger agrees with the flag, rather than being decided separately.
      const moved = await db.select().from(ledger).where(eq(ledger.matchId, match.id));
      expect(moved.length > 0).toBe(bothPlayers);
    }
    await close();
  });

});
