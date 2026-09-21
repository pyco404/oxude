import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import {
  agents,
  bandByName,
  canAffordBand,
  affordableBands,
  ledger,
  matches,
  normaliseNet,
  ratings,
  STARTING_BALANCE,
} from "../src/db/schema.js";
import {
  balanceOf,
  record,
  settle,
  stakeBetween,
  StakeError,
  statement,
  isFirstElicitationFree,
  recordElicitation,
  elicitationCount,
} from "../src/db/ledger.js";
import { createAgent, leaderboard, pickOpponent, playableBands, runMatch, setBand } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";
import { someWallet } from "./helpers.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await connect());
  await migrate(db);
});
afterAll(async () => close());

const fresh = async () => {
  const { db: d, close: c } = await connect();
  await migrate(d);
  return { db: d, close: c };
};

describe("balances", () => {
  it("are the sum of the ledger, and renting seeds the first movement", async () => {
    const a = await createAgent(db, { name: "Seeded", presetName: "Anchor" });
    expect(await balanceOf(db, a.id)).toBe(STARTING_BALANCE);

    await record(db, [{ agentId: a.id, amount: -30, reason: "match-settlement" }]);
    await record(db, [{ agentId: a.id, amount: 12, reason: "match-settlement" }]);
    expect(await balanceOf(db, a.id)).toBe(STARTING_BALANCE - 30 + 12);

    const rows = await statement(db, a.id);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.amount).toBe(12);
    expect(rows[rows.length - 1]!.reason).toBe("rental-seed");
    // Nothing is stored as a running total: the balance is recomputed from these.
    const summed = rows.reduce((s, r) => s + r.amount, 0);
    expect(summed).toBe(await balanceOf(db, a.id));
  });
});

describe("stakes", () => {
  it("are the band's worst match, whatever either side holds beyond it", () => {
    const rich = { name: "rich", balance: 5_000 };
    // No clamp any more: a band is a money scale, and both sides pay it in full.
    expect(stakeBetween(rich, rich, "A")).toBe(20);
    expect(stakeBetween(rich, rich, "B")).toBe(40);
    expect(stakeBetween(rich, rich, "C")).toBe(60);
    // A bigger balance buys nothing; the band alone decides.
    expect(stakeBetween({ name: "just enough", balance: 60 }, rich, "C")).toBe(60);
  });

  it("refuse a side that cannot cover the band's worst match", () => {
    const ok = { name: "ok", balance: 900 };
    expect(() => stakeBetween({ name: "skint", balance: 59 }, ok, "C")).toThrow(StakeError);
    expect(() => stakeBetween(ok, { name: "skint", balance: 39 }, "B")).toThrow(/cannot cover a band B match/);
    // The same balance is fine one band down.
    expect(stakeBetween({ name: "skint", balance: 39 }, ok, "A")).toBe(20);
  });

  it("know which bands a balance can still afford", () => {
    expect(affordableBands(900)).toEqual(["A", "B", "C"]);
    expect(affordableBands(59)).toEqual(["A", "B"]);
    expect(affordableBands(39)).toEqual(["A"]);
    expect(affordableBands(19)).toEqual([]);
    expect(canAffordBand(20, "A")).toBe(true);
    expect(canAffordBand(19, "A")).toBe(false);
  });

  it("normalise a net onto band B's scale so bands compare", () => {
    // A band C win of 30 is the same achievement as a band B win of 20.
    expect(normaliseNet(30, "C")).toBe(20);
    expect(normaliseNet(10, "A")).toBe(20);
    expect(normaliseNet(60, "C")).toBe(40);
    expect(normaliseNet(20, "B")).toBe(20);
    expect(bandByName("C").worstMatch).toBe(60);
  });

  it("scale every amount by one factor, so each band is the same game", () => {
    for (const band of ["A", "B", "C"] as const) {
      const b = bandByName(band);
      // The shape is fixed: ante : bet : raised stays 2 : 5 : 10 everywhere.
      expect(b.baseBet / b.ante).toBe(2.5);
      expect(b.raisedBet / b.baseBet).toBe(2);
      // The worst a match can move is two rounds at the raised bet: a match is
      // first to two, so the winner can never take a third.
      expect(b.worstMatch).toBe(b.raisedBet * 2);
    }
  });

  it("record a net as it stands: nothing is clamped any more", () => {
    expect(settle(45)).toBe(45);
    expect(settle(-45)).toBe(-45);
    expect(settle(0)).toBe(0);
  });
});

describe("settlement", () => {
  it("moves money between balances and records both sides against the match", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "A", presetName: "Bully" });
    const b = await createAgent(d, { name: "B", presetName: "Mirage" });

    const { match, log, stake, settled } = await runMatch(d, a.id, b.id, { seed: 5 });
    // Both agents default to band B, whose worst match is 60.
    expect(stake).toBe(bandByName("B").worstMatch);
    expect(settled.A).toBe(settle(log.nets.A));
    expect(settled.A + settled.B).toBe(0);
    expect(await balanceOf(d, a.id)).toBe(STARTING_BALANCE + settled.A);
    expect(await balanceOf(d, b.id)).toBe(STARTING_BALANCE + settled.B);

    const rows = await d.select().from(ledger).where(eq(ledger.matchId, match.id));
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(0);
    expect(rows.every((r) => r.reason === "match-settlement")).toBe(true);
    await c();
  });

  it("moves a full band C net, which no clamp would have allowed", async () => {
    const { db: d, close: c } = await fresh();
    const big = await createAgent(d, { name: "Big", presetName: "Bully", band: "C" });
    const bold = await createAgent(d, { name: "Bold", presetName: "Mirage", band: "C" });

    let sawBeyondBandB = false;
    for (let seed = 1; seed <= 200 && !sawBeyondBandB; seed++) {
      const before = { a: await balanceOf(d, big.id), b: await balanceOf(d, bold.id) };
      if (Math.min(before.a, before.b) < bandByName("C").worstMatch) break;
      const { stake, match } = await runMatch(d, big.id, bold.id, { seed });
      // The band alone sets the stake; balances beyond it buy nothing.
      expect(stake).toBe(60);
      const [row] = await d.select().from(matches).where(eq(matches.id, match.id));
      // Nothing is clamped: the recorded net is the net the engine produced.
      expect(row!.netA).toBe(row!.log.nets.A);
      expect(Math.abs(row!.netA)).toBeLessThanOrEqual(60);
      // Band B's widest possible net is 40; band C reaches past it.
      if (Math.abs(row!.netA) > 40) sawBeyondBandB = true;
    }
    // Band C really does move more than band B ever could.
    expect(sawBeyondBandB).toBe(true);
    await c();
  });

  it("the band decides who an agent is matched against", async () => {
    const { db: d, close: c } = await fresh();
    const owner = someWallet();
    const cautious = await createAgent(d, { name: "Cautious", presetName: "Anchor", ownerId: owner, band: "A" });
    // Four on the cheap scale, four on the dear one.
    const low = [];
    for (let i = 0; i < 4; i++) low.push(await createAgent(d, { name: `Low ${i}`, presetName: "Bully", band: "A" }));
    for (let i = 0; i < 4; i++) await createAgent(d, { name: `High ${i}`, presetName: "Hammer", band: "C" });
    await refreshTrueRatings(d);

    for (let i = 0; i < 20; i++) {
      const pick = await pickOpponent(d, cautious.id);
      expect(pick.band).toBe("A");
      expect(low.map((a) => a.id)).toContain(pick.opponentId);
    }

    // Changing band moves the agent to another scale, and another set of opponents.
    expect(await setBand(d, cautious.id, owner, "C")).toBe("C");
    const pick = await pickOpponent(d, cautious.id);
    expect(pick.band).toBe("C");
    expect(low.map((a) => a.id)).not.toContain(pick.opponentId);
    await expect(setBand(d, cautious.id, "88888888-8888-4888-8888-888888888888", "C")).rejects.toThrow(/another owner/);
    await c();
  });

  it("never pairs a wallet's own agents, even when the band is too thin to pick on rating", async () => {
    const { db: d, close: c } = await fresh();
    const owner = someWallet();
    // Two agents, one wallet, one band, and nobody else at all. The rating path
    // needs four candidates, so this always falls through to the preset one.
    const mine = await createAgent(d, { name: "Mine", presetName: "Anchor", ownerId: owner, band: "C" });
    await createAgent(d, { name: "Also mine", presetName: "Bully", ownerId: owner, band: "C" });
    await refreshTrueRatings(d);
    await expect(pickOpponent(d, mine.id)).rejects.toThrow(/no opponent in the C band/);

    // A stranger in the band is picked by that same fallback.
    const stranger = await createAgent(d, { name: "Stranger", presetName: "Hammer", ownerId: someWallet(), band: "C" });
    await refreshTrueRatings(d);
    const pick = await pickOpponent(d, mine.id);
    expect(pick.opponentId).toBe(stranger.id);
    expect(pick.path).toBe("preset-fallback");
    await c();
  });

  it("names a band that does have opponents when this one has none", async () => {
    const { db: d, close: c } = await fresh();
    const lonely = await createAgent(d, { name: "Lonely", presetName: "Anchor", ownerId: someWallet(), band: "C" });
    for (let i = 0; i < 3; i++) await createAgent(d, { name: `B ${i}`, presetName: "Bully", band: "B" });
    await createAgent(d, { name: "A one", presetName: "Mirage", band: "A" });
    await refreshTrueRatings(d);
    // Band B has the most ready opponents, so that is the one suggested.
    await expect(pickOpponent(d, lonely.id)).rejects.toThrow(/Band B has 3 agents ready to play/);

    // Counting is per band and respects the cover rule: an agent too poor for
    // its own band is not offered as a reason to go there.
    const counts = await playableBands(d, lonely.id, null);
    expect(counts.find((x) => x.band === "B")?.count).toBe(3);
    expect(counts.find((x) => x.band === "A")?.count).toBe(1);
    expect(counts.find((x) => x.band === "C")?.count).toBe(0);
    await c();
  });

  it("says so when nobody in the band can play", async () => {
    const { db: d, close: c } = await fresh();
    const lonely = await createAgent(d, { name: "Lonely", presetName: "Anchor", band: "A" });
    for (let i = 0; i < 4; i++) await createAgent(d, { name: `High ${i}`, presetName: "Bully", band: "C" });
    await expect(pickOpponent(d, lonely.id)).rejects.toThrow(/no opponent in the A band/);
    await c();
  });
});

describe("rating across bands", () => {
  it("normalises the ranked record onto band B's scale, so bands rank against each other", async () => {
    const { db: d, close: c } = await fresh();
    // The same preset, the same seed, the same opponent preset - one pair in
    // band A, one in band C. Owned on both sides, so the match is ranked. The
    // money differs by the scale; the ranked record must not.
    const results: Record<string, { cumulative: number; ranked: number; form: number; raw: number }> = {};
    for (const band of ["A", "C"] as const) {
      const a = await createAgent(d, { name: `A-${band}`, presetName: "Bully", band, ownerId: someWallet() });
      const b = await createAgent(d, { name: `B-${band}`, presetName: "Mirage", band, ownerId: someWallet() });
      const { match } = await runMatch(d, a.id, b.id, { seed: 7 });
      const [row] = await d.select().from(matches).where(eq(matches.id, match.id));
      const [rating] = await d.select().from(ratings).where(eq(ratings.agentId, a.id));
      results[band] = {
        cumulative: rating!.cumulativeNet,
        ranked: rating!.rankedNet,
        form: rating!.rollingNet50,
        raw: row!.netA,
      };
    }
    // Band C moved three times band A's money on the same match.
    expect(results["C"]!.raw).toBe(results["A"]!.raw * 3);
    // What the ladder ranks is identical, and on band B's scale: a band A net of n reads as 2n.
    expect(results["C"]!.ranked).toBe(results["A"]!.ranked);
    expect(results["C"]!.form).toBe(results["A"]!.form);
    expect(results["A"]!.ranked).toBe(results["A"]!.raw * 2);
    // But net won is money, and stays the money each band actually moved.
    expect(results["A"]!.cumulative).toBe(results["A"]!.raw);
    expect(results["C"]!.cumulative).toBe(results["C"]!.raw);
    await c();
  });

  it("keeps net won equal to the ledger's settlements in a band that is not B", async () => {
    const { db: d, close: c } = await fresh();
    const me = await createAgent(d, { name: "Banded", presetName: "Mirage", band: "A", ownerId: someWallet() });
    const opp = await createAgent(d, { name: "Opp", presetName: "Anchor", band: "A" });
    for (let seed = 1; seed <= 12; seed++) await runMatch(d, me.id, opp.id, { seed });
    const [rating] = await d.select().from(ratings).where(eq(ratings.agentId, me.id));
    const [settled] = await d
      .select({ total: sql<number>`coalesce(sum(${ledger.amount}), 0)::int` })
      .from(ledger)
      .where(and(eq(ledger.agentId, me.id), eq(ledger.reason, "match-settlement")));
    expect(rating!.matchesPlayed).toBe(12);
    expect(rating!.cumulativeNet).toBe(Number(settled!.total));
    await c();
  });
});

describe("running out", () => {
  it("retires an agent at zero, freezes its record, and marks it on the ladder", async () => {
    const { db: d, close: c } = await fresh();
    // Enough to cover one band A match and very little more. Both are players:
    // the ladder lists only rented agents, and that is where a retirement shows.
    const doomed = await createAgent(d, { name: "Doomed", presetName: "Mirage", band: "A", startingBalance: 24, ownerId: someWallet() });
    const rival = await createAgent(d, { name: "Rival", presetName: "Bully", band: "A", startingBalance: 900, ownerId: someWallet() });

    let retiredAfter = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const result = await runMatch(d, doomed.id, rival.id, { seed });
      if (result.retired.includes(doomed.id)) {
        retiredAfter = seed;
        break;
      }
    }
    expect(retiredAfter).toBeGreaterThan(0);
    // Retired only when no band at all is open to it, which may leave small change.
    expect(await balanceOf(d, doomed.id)).toBeLessThan(bandByName("A").worstMatch);
    expect(affordableBands(await balanceOf(d, doomed.id))).toEqual([]);

    const [row] = await d.select().from(agents).where(eq(agents.id, doomed.id));
    expect(row!.retiredAt).not.toBeNull();

    // Frozen: it cannot be matched again, in either direction.
    await expect(runMatch(d, doomed.id, rival.id, { seed: 99 })).rejects.toThrow(/retired/);
    await expect(runMatch(d, rival.id, doomed.id, { seed: 99 })).rejects.toThrow(/retired/);

    const board = await leaderboard(d);
    const listed = board.find((r) => r.agentId === doomed.id);
    expect(listed?.retired).toBe(true);
    expect(listed?.balance).toBeLessThan(bandByName("A").worstMatch);
    await c();
  });

  it("is never offered as an opponent once it cannot cover a stake", async () => {
    const { db: d, close: c } = await fresh();
    const seeker = await createAgent(d, { name: "Seeker", presetName: "Anchor" });
    const broke = await createAgent(d, { name: "Broke", presetName: "Bully", startingBalance: bandByName("B").worstMatch - 1 });
    const solvent = [];
    for (let i = 0; i < 5; i++) solvent.push(await createAgent(d, { name: `Solvent ${i}`, presetName: "Hammer" }));
    await refreshTrueRatings(d);

    for (let i = 0; i < 20; i++) {
      const pick = await pickOpponent(d, seeker.id);
      expect(pick.opponentId).not.toBe(broke.id);
      expect(solvent.map((s) => s.id)).toContain(pick.opponentId);
    }
    await c();
  });
});

describe("first elicitation", () => {
  it("is free once per owner, then counts", async () => {
    const { db: d, close: c } = await fresh();
    const owner = someWallet();
    const other = "34343434-3434-4434-8434-343434343434";

    expect(await isFirstElicitationFree(d, owner)).toBe(true);
    await recordElicitation(d, { ownerId: owner, kind: "preview", free: true });
    expect(await isFirstElicitationFree(d, owner)).toBe(false);
    expect(await elicitationCount(d, owner)).toBe(1);

    await recordElicitation(d, { ownerId: owner, kind: "rent", free: false });
    expect(await elicitationCount(d, owner)).toBe(2);
    // Each owner gets their own first one.
    expect(await isFirstElicitationFree(d, other)).toBe(true);
    await c();
  });
});
