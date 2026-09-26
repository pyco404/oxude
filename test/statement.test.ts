import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { agents, rentals } from "../src/db/schema.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { closeSeason } from "../src/db/seasons.js";
import { seasonStatement } from "../src/db/statement.js";
import { listen } from "../src/http/server.js";
import { seasonAt } from "../src/season.js";
import { baseUnits, DEVNET_CHIP_RATE } from "../src/chips.js";
import { MIN_RANKED_MATCHES_FOR_PRIZE as MIN } from "../src/db/standings.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

describe("a season's statement", () => {
  it("reports the play, the burn and an empty prize side", async () => {
    const { db, close } = await fresh();
    const current = seasonAt(new Date());
    const a = await createAgent(db, { name: "Sa", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Sb", presetName: "Mirage", ownerId: someWallet() });
    const h = await createAgent(db, { name: "Sh", presetName: "Anchor" });
    for (let i = 0; i < MIN + 1; i++) await runMatch(db, a.id, b.id, { seed: 400 + i });
    // Against the house: played and recorded, but staked nothing and ranked nothing.
    await runMatch(db, a.id, h.id, { seed: 999 });

    const s = await seasonStatement(db, current.key);
    expect(s.season.key).toBe(current.key);
    expect(s.season.status).toBe("open");
    expect(s.play.rankedMatches).toBe(MIN + 1);
    expect(s.play.stakedMatches).toBe(MIN + 1);
    expect(s.play.exhibitions).toBe(1);
    expect(s.play.rankedStaked).toBe(s.play.stakedTotal);
    expect(s.play.rankedStaked).toBeGreaterThan(0);

    // The reconciliation line: a match is zero-sum between its two agents, so
    // every side's net across the season adds to nothing.
    expect(s.play.netAcrossAllSides).toBe(0);

    // The prize side is empty and says which kind of empty it is.
    expect(s.prizes.funded).toBe(false);
    expect(s.prizes.pool).toBeNull();
    expect(s.prizes.paid).toBeNull();
    expect(s.prizes.placed).toBe(2);
    expect(s.prizes.basis).toBe("ranked net per chip staked");
    expect(s.prizes.places.map((p) => p.prizeRank)).toEqual([1, 2]);
    await close();
  });

  it("counts the rent burned in the season, in chips, and only what landed", async () => {
    const { db, close } = await fresh();
    const current = seasonAt(new Date());
    const owner = someWallet();
    const agent = await createAgent(db, { name: "Renter", presetName: "Anchor", ownerId: owner });
    const fee = baseUnits(2, DEVNET_CHIP_RATE);
    await db.insert(rentals).values([
      { agentId: agent.id, ownerId: owner, fee, deposit: 0, salt: "a", preparedTx: "x", lastValidBlockHeight: 1, status: "confirmed" },
      // Prepared and expired rentals burned nothing, so they are not a burn.
      { agentId: agent.id, ownerId: owner, fee, deposit: 0, salt: "b", preparedTx: "x", lastValidBlockHeight: 1, status: "prepared" },
      { agentId: agent.id, ownerId: owner, fee, deposit: 0, salt: "c", preparedTx: "x", lastValidBlockHeight: 1, status: "expired" },
    ]);

    const s = await seasonStatement(db, current.key);
    expect(s.burned.rentals).toBe(1);
    expect(s.burned.chips).toBe(2);
    await close();
  });

  it("goes final when the season closes, carrying the frozen placement", async () => {
    const { db, close } = await fresh();
    const current = seasonAt(new Date());
    const a = await createAgent(db, { name: "Fa", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Fb", presetName: "Anchor", ownerId: someWallet() });
    for (let i = 0; i < MIN + 3; i++) await runMatch(db, a.id, b.id, { seed: 500 + i });

    const before = await seasonStatement(db, current.key);
    expect(before.season.status).toBe("open");
    await db.update(agents).set({ rentalEndsAt: current.end }).where(eq(agents.id, a.id));
    await closeSeason(db, current.key, new Date(current.end.getTime() + 60_000));

    const after = await seasonStatement(db, current.key);
    expect(after.season.status).toBe("closed");
    expect(after.play).toEqual(before.play);
    expect(after.prizes.places.map((p) => p.agentId)).toEqual(before.prizes.places.map((p) => p.agentId));
    await close();
  });

  it("is a statement of a season nobody played, not an error", async () => {
    const { db, close } = await fresh();
    const s = await seasonStatement(db, "2099-01-05");
    expect(s.play).toEqual({
      rankedMatches: 0,
      rankedStaked: 0,
      stakedMatches: 0,
      stakedTotal: 0,
      exhibitions: 0,
      netAcrossAllSides: 0,
    });
    expect(s.burned).toEqual({ rentals: 0, chips: 0 });
    expect(s.prizes.places).toEqual([]);
    await close();
  });
});

describe("GET /statement", () => {
  it("serves the current season by default and rejects a day that is not a Monday", async () => {
    const c = await fresh();
    const { url, close: closeServer } = await listen({ db: c.db });
    try {
      const body = (await (await fetch(`${url}/statement`)).json()) as any;
      expect(body.statement.season.key).toBe(seasonAt(new Date()).key);
      expect(body.statement.prizes.funded).toBe(false);
      expect(body.statement.prizes.pool).toBeNull();
      expect((await fetch(`${url}/statement?season=2026-09-22`)).status).toBe(400);
    } finally {
      await closeServer();
      await c.close();
    }
  });
});
