import { describe, expect, it } from "vitest";
import {
  MIN_RANKED_MATCHES_FOR_PRIZE as MIN,
  perChip,
  prizeOrder,
  type Standing,
} from "../src/db/standings.js";

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
