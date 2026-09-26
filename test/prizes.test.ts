import { describe, expect, it } from "vitest";
import {
  MIN_RANKED_MATCHES_FOR_PRIZE as MIN,
  perChip,
  prizeOrder,
  type Standing,
  standings,
} from "../src/db/standings.js";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { agents, seasonStandings } from "../src/db/schema.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { closeSeason } from "../src/db/seasons.js";
import { nextSeason, seasonAt } from "../src/season.js";
import { listen } from "../src/http/server.js";
import { someWallet } from "./helpers.js";

/** A standing with everything but the figures under test filled in plausibly. */
const standing = (agentId: string, s: Partial<Standing> = {}): Standing => ({
  agentId,
  name: agentId,
  presetName: "Anchor",
  mark: null,
  retired: false,
  rankedMatches: MIN,
  rankedNet: 0,
  rankedStaked: 0,
  rankedNetReal: 0,
  totalMatches: MIN,
  totalNet: 0,
  ...s,
});

describe("net per chip staked", () => {
  it("is the chips moved over the chips risked", () => {
    expect(perChip(standing("a", { rankedNetReal: 80, rankedStaked: 800 }))).toBeCloseTo(0.1);
    expect(perChip(standing("a", { rankedNetReal: -400, rankedStaked: 800 }))).toBeCloseTo(-0.5);
  });

  it("is null when nothing was staked, rather than zero", () => {
    // Zero would place an agent that never risked anything above everyone
    // losing, which is not a result - it is an absence of one.
    expect(perChip(standing("a", { rankedNetReal: 0, rankedStaked: 0 }))).toBeNull();
  });

  it("gives two bands the same figure for the same rate of return", () => {
    // 40 matches each: band A stakes 20 a match, band C stakes 60.
    const ace = standing("ace", { rankedMatches: 40, rankedStaked: 800, rankedNetReal: 80, rankedNet: 160 });
    const cee = standing("cee", { rankedMatches: 40, rankedStaked: 2400, rankedNetReal: 240, rankedNet: 160 });
    expect(perChip(ace)).toBeCloseTo(perChip(cee)!);

    // And why it is the un-normalised net that gets divided: the ladder's
    // rankedNet has already had the band correction applied, so dividing that
    // by chips staked applies it twice and spreads two identical performances
    // by a factor of three.
    expect(ace.rankedNet / ace.rankedStaked).not.toBeCloseTo(cee.rankedNet / cee.rankedStaked);
  });
});

describe("the prize order", () => {
  it("places the best rate of return first, whatever it won in total", () => {
    // The small careful agent beats the big loose one on rate and loses to it
    // on total. The two orderings are meant to disagree; this is where.
    const small = standing("small", { rankedMatches: MIN, rankedStaked: 400, rankedNetReal: 120, rankedNet: 200 });
    const big = standing("big", { rankedMatches: MIN * 10, rankedStaked: 8000, rankedNetReal: 800, rankedNet: 1200 });
    const order = prizeOrder([big, small]);
    expect(order.map((s) => s.agentId)).toEqual(["small", "big"]);
    expect(order[0]!.prizeRank).toBe(1);
    expect(order[1]!.prizeRank).toBe(2);
    // The ladder would have had them the other way round.
    expect(big.rankedNet).toBeGreaterThan(small.rankedNet);
  });

  it("leaves an agent short of the minimum unplaced, and says how short", () => {
    const keen = standing("keen", { rankedMatches: MIN - 4, rankedStaked: 80, rankedNetReal: 80 });
    const plodder = standing("plodder", { rankedMatches: MIN, rankedStaked: 400, rankedNetReal: 4 });
    const order = prizeOrder([keen, plodder]);
    // A perfect record over four matches does not out-place a modest one over twenty.
    expect(order.map((s) => s.agentId)).toEqual(["plodder", "keen"]);
    expect(order[0]!.prizeRank).toBe(1);
    expect(order[1]!.prizeRank).toBeNull();
    expect(order[1]!.shortBy).toBe(4);
    expect(order[0]!.shortBy).toBe(0);
  });

  it("takes the minimum as a parameter", () => {
    const four = [standing("a", { rankedMatches: 4, rankedStaked: 80, rankedNetReal: 8 })];
    expect(prizeOrder(four, 20)[0]!.prizeRank).toBeNull();
    expect(prizeOrder(four, 4)[0]!.prizeRank).toBe(1);
  });

  it("breaks a tie towards more matches, the opposite of the ladder", () => {
    // The same rate held over more matches is the better evidence for it.
    const few = standing("few", { rankedMatches: MIN, rankedStaked: 400, rankedNetReal: 40 });
    const many = standing("many", { rankedMatches: MIN * 3, rankedStaked: 1200, rankedNetReal: 120 });
    expect(perChip(few)).toBeCloseTo(perChip(many)!);
    expect(prizeOrder([few, many]).map((s) => s.agentId)).toEqual(["many", "few"]);
  });

  it("is a total order: equal figures still fall out the same way every time", () => {
    const a = standing("aaaa", { rankedStaked: 400, rankedNetReal: 40 });
    const b = standing("bbbb", { rankedStaked: 400, rankedNetReal: 40 });
    expect(prizeOrder([a, b]).map((s) => s.agentId)).toEqual(["aaaa", "bbbb"]);
    expect(prizeOrder([b, a]).map((s) => s.agentId)).toEqual(["aaaa", "bbbb"]);
  });

  it("places a losing agent rather than dropping it", () => {
    // A season's standing is a record, not a shortlist. Last place is a place.
    const order = prizeOrder([standing("down", { rankedStaked: 400, rankedNetReal: -200 })]);
    expect(order[0]!.prizeRank).toBe(1);
    expect(order[0]!.perChip).toBeCloseTo(-0.5);
  });

  it("keeps every agent it was given, placed or not", () => {
    const table = [
      standing("p1", { rankedStaked: 400, rankedNetReal: 40 }),
      standing("p2", { rankedMatches: 2, rankedStaked: 40, rankedNetReal: 20 }),
      standing("p3", { rankedMatches: 0, rankedStaked: 0, rankedNetReal: 0 }),
    ];
    const order = prizeOrder(table);
    expect(order.length).toBe(3);
    expect(new Set(order.map((s) => s.agentId))).toEqual(new Set(["p1", "p2", "p3"]));
    expect(order.filter((s) => s.prizeRank !== null).map((s) => s.agentId)).toEqual(["p1"]);
  });
});

describe("freezing both orderings at the boundary", () => {
  const fresh = async () => {
    const c = await connect();
    await migrate(c.db);
    return c;
  };

  it("writes the ladder's rank and the prize placement, and never recomputes either", async () => {
    const { db, close } = await fresh();
    const current = seasonAt(new Date());
    const a = await createAgent(db, { name: "Pa", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Pb", presetName: "Anchor", ownerId: someWallet() });
    for (let i = 0; i < 6; i++) await runMatch(db, a.id, b.id, { seed: 100 + i });

    const live = await standings(db, { season: current.key });
    expect(live.length).toBe(2);

    await db.update(agents).set({ rentalEndsAt: new Date(current.end.getTime()) }).where(eq(agents.id, a.id));
    const result = await closeSeason(db, current.key, new Date(current.end.getTime() + 60_000));
    expect(result.standings).toBe(2);

    const frozen = await db.select().from(seasonStandings).where(eq(seasonStandings.season, current.key));
    expect(frozen.length).toBe(2);
    // Both orderings are complete: every agent has a ladder rank, and the
    // per-chip numerator it is placed on is stored beside it.
    expect(new Set(frozen.map((f) => f.rank))).toEqual(new Set([1, 2]));
    for (const f of frozen) {
      const l = live.find((s) => s.agentId === f.agentId)!;
      expect(Number(f.rankedNetReal)).toBe(l.rankedNetReal);
      expect(Number(f.rankedStaked)).toBe(l.rankedStaked);
    }
    // Six matches is under the minimum, so nobody is placed for prizes - and
    // that is recorded as a null rank, not as an absent row.
    expect(frozen.every((f) => f.prizeRank === null)).toBe(true);

    // Closing again finds it closed and changes nothing.
    const again = await closeSeason(db, current.key, new Date(current.end.getTime() + 120_000));
    expect(again.closed).toBe(false);
    await close();
  });

  it("places the agents that met the minimum, in per-chip order", async () => {
    const { db, close } = await fresh();
    const current = seasonAt(new Date());
    const a = await createAgent(db, { name: "Qa", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Qb", presetName: "Mirage", ownerId: someWallet() });
    for (let i = 0; i < MIN + 5; i++) await runMatch(db, a.id, b.id, { seed: 900 + i });

    const expected = prizeOrder(await standings(db, { season: current.key }));
    await closeSeason(db, current.key, new Date(current.end.getTime() + 60_000));

    const frozen = await db.select().from(seasonStandings).where(eq(seasonStandings.season, current.key));
    for (const e of expected) {
      expect(frozen.find((f) => f.agentId === e.agentId)!.prizeRank).toBe(e.prizeRank);
    }
    // A head-to-head is zero sum, so one of the two is above water and placed first.
    expect(expected.map((e) => e.prizeRank)).toEqual([1, 2]);
    await close();
  });
});

describe("GET /prizes", () => {
  it("serves the live order while the season runs, and the frozen one after it closes", async () => {
    const c = await connect();
    await migrate(c.db);
    const db = c.db;
    const current = seasonAt(new Date());
    const a = await createAgent(db, { name: "Ra", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(db, { name: "Rb", presetName: "Mirage", ownerId: someWallet() });
    for (let i = 0; i < MIN + 2; i++) await runMatch(db, a.id, b.id, { seed: 300 + i });

    const { url, close: closeServer } = await listen({ db });
    try {
      const live = (await (await fetch(`${url}/prizes`)).json()) as any;
      expect(live.season.key).toBe(current.key);
      expect(live.season.current).toBe(true);
      expect(live.frozen).toBe(false);
      expect(live.minMatches).toBe(MIN);
      expect(live.basis).toBe("ranked net per chip staked");
      expect(live.placed).toBe(2);
      expect(live.rows.map((r: any) => r.prizeRank)).toEqual([1, 2]);
      // The per-chip figure is what the order is by, and it is the real net
      // over the real stake - not the ladder's normalised number.
      expect(live.rows[0].perChip).toBeCloseTo(live.rows[0].rankedNetReal / live.rows[0].rankedStaked);
      expect(live.rows[0].perChip).toBeGreaterThan(live.rows[1].perChip);
      expect(live.rows[0]).not.toHaveProperty("rankedNet");

      const before = live.rows.map((r: any) => r.agentId);
      await closeSeason(db, current.key, new Date(current.end.getTime() + 60_000));
      const after = (await (await fetch(`${url}/prizes?season=${current.key}`)).json()) as any;
      expect(after.frozen).toBe(true);
      expect(after.rows.map((r: any) => r.agentId)).toEqual(before);

      // A season nobody has played is an empty table, not an error.
      const next = (await (await fetch(`${url}/prizes?season=${nextSeason(current).key}`)).json()) as any;
      expect(next.rows).toEqual([]);
      expect(next.placed).toBe(0);
      expect((await fetch(`${url}/prizes?season=tuesday`)).status).toBe(400);
    } finally {
      await closeServer();
      await c.close();
    }
  });
});
