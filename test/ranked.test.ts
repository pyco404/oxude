import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { matches, ratings } from "../src/db/schema.js";
import { createAgent, leaderboard, runMatch, runExhibition } from "../src/db/runner.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

const ratingOf = async (db: Awaited<ReturnType<typeof fresh>>["db"], agentId: string) =>
  (await db.select().from(ratings).where(eq(ratings.agentId, agentId)))[0]!;

describe("only player-versus-player matches are ranked", () => {
  it("marks a match against a house agent unranked, and it still settles", async () => {
    const { db, close } = await fresh();
    const mine = await createAgent(db, { name: "Mine", presetName: "Anchor", ownerId: someWallet() });
    const houseAgent = await createAgent(db, { name: "House", presetName: "Hammer" });

    const { match, settled } = await runMatch(db, mine.id, houseAgent.id, { seed: 7 });
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
    expect(row!.ranked).toBe(false);
    expect(row!.exhibition).toBe(false);

    const r = await ratingOf(db, mine.id);
    // The money moved and is counted; the ladder's figures are untouched.
    expect(r.matchesPlayed).toBe(1);
    expect(r.cumulativeNet).toBe(settled.A);
    expect(r.rankedMatches).toBe(0);
    expect(r.rankedNet).toBe(0);
    expect(r.rankedStaked).toBe(0);
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

  it("the ladder sorts on ranked winnings and carries the total beside it", async () => {
    const { db, close } = await fresh();
    const farmer = await createAgent(db, { name: "Farmer", presetName: "Hammer", ownerId: someWallet() });
    const honest = await createAgent(db, { name: "Honest", presetName: "Anchor", ownerId: someWallet() });
    const rival = await createAgent(db, { name: "Rival", presetName: "Bully", ownerId: someWallet() });
    const houseA = await createAgent(db, { name: "HouseA", presetName: "Mirage" });

    // The farmer only ever plays the house; the other two play each other.
    for (let seed = 1; seed <= 6; seed++) await runMatch(db, farmer.id, houseA.id, { seed });
    for (let seed = 20; seed <= 25; seed++) await runMatch(db, honest.id, rival.id, { seed });

    const rows = await leaderboard(db, 50, "winnings");
    const farmerRow = rows.find((r) => r.name === "Farmer")!;
    // Nothing the farmer did against the house reaches the ladder's figure.
    expect(farmerRow.matchesPlayed).toBe(0);
    expect(Number(farmerRow.cumulativeNet)).toBe(0);
    // But the money it actually won is still reported, so it has not vanished.
    expect(farmerRow.totalMatches).toBe(6);
    expect(Number(farmerRow.totalNet)).not.toBe(0);

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
});
