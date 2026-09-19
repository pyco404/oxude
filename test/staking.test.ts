import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, bandOf, ledger, matches, MAX_EXPOSURE, MIN_STAKE, STARTING_BALANCE } from "../src/db/schema.js";
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
import { clampCeiling, createAgent, leaderboard, pickOpponent, runMatch, setCeiling } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";

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
  it("take what both sides can cover, and never more than a match can move", () => {
    const rich = { name: "rich", balance: 500 };
    expect(stakeBetween(rich, rich)).toBe(MAX_EXPOSURE);
    expect(stakeBetween({ ...rich, balance: 20 }, rich)).toBe(20);
    expect(stakeBetween(rich, { ...rich, balance: 35 })).toBe(35);
    // The lower of the two ceilings caps it: an owner never risks more than they chose.
    expect(stakeBetween({ ...rich, ceiling: 30 }, rich)).toBe(30);
    expect(stakeBetween({ ...rich, ceiling: 40 }, { ...rich, ceiling: 25 })).toBe(25);
    expect(stakeBetween({ ...rich, balance: 18, ceiling: 30 }, rich)).toBe(18);
  });

  it("refuse a side that cannot cover the minimum", () => {
    const ok = { name: "ok", balance: 200 };
    expect(() => stakeBetween({ name: "skint", balance: MIN_STAKE - 1 }, ok)).toThrow(StakeError);
    expect(() => stakeBetween(ok, { name: "skint", balance: 0 })).toThrow(/cannot cover a stake/);
  });

  it("sort ceilings into bands, with the upper bound winning at a boundary", () => {
    expect(bandOf(10)).toBe("10-20");
    expect(bandOf(20)).toBe("10-20");
    expect(bandOf(21)).toBe("20-40");
    expect(bandOf(40)).toBe("20-40");
    expect(bandOf(41)).toBe("40-60");
    expect(bandOf(60)).toBe("40-60");
  });

  it("cap what a match can move, in both directions", () => {
    expect(settle(45, 20)).toBe(20);
    expect(settle(-45, 20)).toBe(-20);
    expect(settle(8, 20)).toBe(8);
    expect(settle(0, 20)).toBe(0);
  });

  it("clamp an owner's ceiling to something a match can honour", () => {
    expect(clampCeiling(5)).toBe(MIN_STAKE);
    expect(clampCeiling(1000)).toBe(MAX_EXPOSURE);
    expect(clampCeiling(25.7)).toBe(25);
  });
});

describe("settlement", () => {
  it("moves money between balances and records both sides against the match", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "A", presetName: "Bully" });
    const b = await createAgent(d, { name: "B", presetName: "Mirage" });

    const { match, log, stake, settled } = await runMatch(d, a.id, b.id, { seed: 5 });
    expect(stake).toBe(MAX_EXPOSURE);
    expect(settled.A).toBe(settle(log.nets.A, stake));
    expect(settled.A + settled.B).toBe(0);
    expect(await balanceOf(d, a.id)).toBe(STARTING_BALANCE + settled.A);
    expect(await balanceOf(d, b.id)).toBe(STARTING_BALANCE + settled.B);

    const rows = await d.select().from(ledger).where(eq(ledger.matchId, match.id));
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(0);
    expect(rows.every((r) => r.reason === "match-settlement")).toBe(true);
    await c();
  });

  it("is capped by the lower ceiling: neither owner risks more than they chose", async () => {
    const { db: d, close: c } = await fresh();
    const careful = await createAgent(d, { name: "Careful", presetName: "Bully", maxStake: 30 });
    const bold = await createAgent(d, { name: "Bold", presetName: "Mirage", maxStake: 60 });

    let sawTheCap = false;
    for (let seed = 1; seed <= 200 && !sawTheCap; seed++) {
      const before = { a: await balanceOf(d, careful.id), b: await balanceOf(d, bold.id) };
      if (Math.min(before.a, before.b) < MIN_STAKE) break;
      const { stake, match } = await runMatch(d, careful.id, bold.id, { seed });
      // The stake is what both can cover, within the lower ceiling.
      expect(stake).toBe(Math.min(before.a, before.b, 30, MAX_EXPOSURE));
      const [row] = await d.select().from(matches).where(eq(matches.id, match.id));
      // Nobody moves more than the careful owner's ceiling.
      expect(Math.abs(row!.netA)).toBeLessThanOrEqual(30);
      if (Math.abs(row!.log.nets.A) > 30) sawTheCap = true;
    }
    // At least one match was worth more than 30 in play, and the ceiling held it.
    expect(sawTheCap).toBe(true);
    await c();
  });

  it("the ceiling decides the band an agent is matched in", async () => {
    const { db: d, close: c } = await fresh();
    const owner = "99999999-9999-4999-8999-999999999999";
    const cautious = await createAgent(d, { name: "Cautious", presetName: "Anchor", ownerId: owner, maxStake: 15 });
    // Four in the cautious band, four well above it.
    const low = [];
    for (let i = 0; i < 4; i++) low.push(await createAgent(d, { name: `Low ${i}`, presetName: "Bully", maxStake: 20 }));
    for (let i = 0; i < 4; i++) await createAgent(d, { name: `High ${i}`, presetName: "Hammer", maxStake: 60 });
    await refreshTrueRatings(d);

    for (let i = 0; i < 20; i++) {
      const pick = await pickOpponent(d, cautious.id);
      expect(pick.band).toBe("10-20");
      expect(low.map((a) => a.id)).toContain(pick.opponentId);
    }

    // Raising the ceiling moves the agent to another band, and another set of opponents.
    expect(await setCeiling(d, cautious.id, owner, 60)).toBe(60);
    const pick = await pickOpponent(d, cautious.id);
    expect(pick.band).toBe("40-60");
    expect(low.map((a) => a.id)).not.toContain(pick.opponentId);
    await expect(setCeiling(d, cautious.id, "88888888-8888-4888-8888-888888888888", 60)).rejects.toThrow(/another owner/);
    await c();
  });

  it("says so when nobody in the band can play", async () => {
    const { db: d, close: c } = await fresh();
    const lonely = await createAgent(d, { name: "Lonely", presetName: "Anchor", maxStake: 15 });
    for (let i = 0; i < 4; i++) await createAgent(d, { name: `High ${i}`, presetName: "Bully", maxStake: 60 });
    await expect(pickOpponent(d, lonely.id)).rejects.toThrow(/no opponent in the 10-20 band/);
    await c();
  });
});

describe("running out", () => {
  it("retires an agent at zero, freezes its record, and marks it on the ladder", async () => {
    const { db: d, close: c } = await fresh();
    // Enough to cover one stake and no more.
    const doomed = await createAgent(d, { name: "Doomed", presetName: "Mirage", startingBalance: MIN_STAKE, maxStake: MIN_STAKE });
    const rival = await createAgent(d, { name: "Rival", presetName: "Bully" });

    let retiredAfter = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const result = await runMatch(d, doomed.id, rival.id, { seed });
      if (result.retired.includes(doomed.id)) {
        retiredAfter = seed;
        break;
      }
    }
    expect(retiredAfter).toBeGreaterThan(0);
    // Retired when it can no longer cover a stake, which may leave small change.
    expect(await balanceOf(d, doomed.id)).toBeLessThan(MIN_STAKE);

    const [row] = await d.select().from(agents).where(eq(agents.id, doomed.id));
    expect(row!.retiredAt).not.toBeNull();

    // Frozen: it cannot be matched again, in either direction.
    await expect(runMatch(d, doomed.id, rival.id, { seed: 99 })).rejects.toThrow(/retired/);
    await expect(runMatch(d, rival.id, doomed.id, { seed: 99 })).rejects.toThrow(/retired/);

    const board = await leaderboard(d);
    const listed = board.find((r) => r.agentId === doomed.id);
    expect(listed?.retired).toBe(true);
    expect(listed?.balance).toBeLessThan(MIN_STAKE);
    await c();
  });

  it("is never offered as an opponent once it cannot cover a stake", async () => {
    const { db: d, close: c } = await fresh();
    const seeker = await createAgent(d, { name: "Seeker", presetName: "Anchor" });
    const broke = await createAgent(d, { name: "Broke", presetName: "Bully", startingBalance: MIN_STAKE - 1 });
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
    const owner = "12121212-1212-4212-8212-121212121212";
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
