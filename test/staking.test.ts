import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, ledger, matches, MAX_EXPOSURE, MIN_STAKE, STARTING_BALANCE } from "../src/db/schema.js";
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
  it("take the smallest of both ceilings, both balances and a match's exposure", () => {
    const rich = { name: "rich", maxStake: 60, balance: 500 };
    expect(stakeBetween(rich, rich)).toBe(MAX_EXPOSURE);
    expect(stakeBetween({ ...rich, maxStake: 25 }, rich)).toBe(25);
    expect(stakeBetween(rich, { ...rich, maxStake: 15 })).toBe(15);
    expect(stakeBetween({ ...rich, balance: 20 }, rich)).toBe(20);
  });

  it("refuse a side that cannot cover the minimum", () => {
    const ok = { name: "ok", maxStake: 60, balance: 200 };
    expect(() => stakeBetween({ name: "skint", maxStake: 60, balance: MIN_STAKE - 1 }, ok)).toThrow(StakeError);
    expect(() => stakeBetween(ok, { name: "skint", maxStake: 60, balance: 0 })).toThrow(/cannot cover a stake/);
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

  it("never moves more than the owner's ceiling", async () => {
    const { db: d, close: c } = await fresh();
    const a = await createAgent(d, { name: "Careful", presetName: "Bully", maxStake: MIN_STAKE });
    const b = await createAgent(d, { name: "Bold", presetName: "Mirage" });

    for (let seed = 1; seed <= 25; seed++) {
      const { stake, settled, match } = await runMatch(d, a.id, b.id, { seed });
      expect(stake).toBe(MIN_STAKE);
      expect(Math.abs(settled.A)).toBeLessThanOrEqual(MIN_STAKE);
      const [row] = await d.select().from(matches).where(eq(matches.id, match.id));
      expect(Math.abs(row!.netA)).toBeLessThanOrEqual(MIN_STAKE);
      // The log still records what was played, even when settlement was capped.
      expect(Math.abs(row!.log.nets.A)).toBeGreaterThanOrEqual(Math.abs(row!.netA));
    }
    await c();
  });

  it("changing the ceiling changes what later matches can move", async () => {
    const { db: d, close: c } = await fresh();
    const owner = "99999999-9999-4999-8999-999999999999";
    const a = await createAgent(d, { name: "Mine", presetName: "Anchor", ownerId: owner });
    const b = await createAgent(d, { name: "Theirs", presetName: "Bully" });
    expect((await runMatch(d, a.id, b.id, { seed: 2 })).stake).toBe(MAX_EXPOSURE);

    expect(await setCeiling(d, a.id, owner, 15)).toBe(15);
    expect((await runMatch(d, a.id, b.id, { seed: 3 })).stake).toBe(15);
    await expect(setCeiling(d, a.id, "88888888-8888-4888-8888-888888888888", 60)).rejects.toThrow(/another owner/);
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
    expect(await balanceOf(d, doomed.id)).toBe(0);

    const [row] = await d.select().from(agents).where(eq(agents.id, doomed.id));
    expect(row!.retiredAt).not.toBeNull();

    // Frozen: it cannot be matched again, in either direction.
    await expect(runMatch(d, doomed.id, rival.id, { seed: 99 })).rejects.toThrow(/retired/);
    await expect(runMatch(d, rival.id, doomed.id, { seed: 99 })).rejects.toThrow(/retired/);

    const board = await leaderboard(d);
    const listed = board.find((r) => r.agentId === doomed.id);
    expect(listed?.retired).toBe(true);
    expect(listed?.balance).toBe(0);
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
