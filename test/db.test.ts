import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, ledger, matches, ratings, RATING_WINDOW, STARTING_BALANCE } from "../src/db/schema.js";
import {
  assertStakesMatch,
  createAgent,
  DEFAULT_RULES,
  leaderboard,
  ownerAgent,
  renderStoredTranscript,
  pickOpponent,
  publicAgent,
  replayMatch,
  resolveAgent,
  runMatch,
  snapshotPreset,
  updateRating,
  type OpponentPick,
} from "../src/db/runner.js";
import { previewPolicy, refreshTrueRatings, rosterProfile, rosterWithout, trueRatingAgainst } from "../src/db/rating.js";
import { agentRecord } from "../src/db/feed.js";
import {
  policyAgent,
  policyFromAgent,
  PRESETS,
  PRESET_VERSION,
  OXUDE_RULES,
  seatAveragedNet,
  type View,
} from "../src/index.js";
import { someWallet } from "./helpers.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await connect());
  await migrate(db);
});
afterAll(async () => close());

describe("migrate", () => {
  it("applies each migration once, so a persistent database survives a restart", async () => {
    const before = await db.select({ id: agents.id }).from(agents);
    await migrate(db);
    await migrate(db);
    expect(await db.select({ id: agents.id }).from(agents)).toEqual(before);
  });
});

const addAgent = async (values: Partial<typeof agents.$inferInsert> & { name: string }) => {
  const preset = values.presetName === undefined ? "Anchor" : values.presetName;
  const [row] = await db
    .insert(agents)
    .values({
      presetName: preset,
      policyTable: values.policyTable ?? (preset ? snapshotPreset(preset as "Anchor") : undefined),
      ...values,
    })
    .returning();
  await db.insert(ratings).values({ agentId: row!.id });
  await db.insert(ledger).values({ agentId: row!.id, amount: STARTING_BALANCE, reason: "rental-seed" });
  return row!;
};

const blankView: Omit<View, "myEdge" | "oppActionThisRound" | "oppRaisedLastRound"> = {
  myRoundsWon: 0,
  oppRoundsWon: 0,
  roundNumber: 1,
  oppRaiseCount: 0,
  stakes: OXUDE_RULES.stakes,
  myNet: 0,
  myActionThisRound: null,
};

describe("match runner", () => {
  it("replays a stored match from its seed and rules, log for log", async () => {
    const a = await addAgent({ name: "Preset A", presetName: "Hammer" });
    const b = await addAgent({
      name: "Policy B",
      presetName: null,
      brief: "be bold",
      policyTable: policyFromAgent(PRESETS.Mirage, blankView),
    });

    for (let i = 0; i < 20; i++) {
      const { match, log, stake, settled, retired } = await runMatch(db, a.id, b.id);
      const [stored] = await db.select().from(matches).where(eq(matches.id, match.id));
      const replayed = replayMatch(stored!, resolveAgent(a), resolveAgent(b));
      expect(replayed).toEqual(stored!.log);
      expect(replayed).toEqual(log);
      // The row records what settled; the log records what was played. They
      // differ only when a thin balance could not cover the whole result.
      expect(stored!.netA).toBe(settled.A);
      // Zero-sum rather than toBe(-settled.A): a settled 0 is -0 on one side.
      expect(stored!.netA + stored!.netB).toBe(0);
      expect(Math.abs(stored!.netA)).toBeLessThanOrEqual(stake);
      if (Math.abs(log.nets.A) <= stake) expect(stored!.netA).toBe(log.nets.A);
      expect(stored!.rulesConfig).toEqual(DEFAULT_RULES);
      if (retired.length > 0) break;
    }
  });

  it("resolves every agent from its stored table, preset or not", async () => {
    const preset = await addAgent({ name: "P", presetName: "Bully" });
    const resolved = resolveAgent(preset);
    for (const edge of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const v = { ...blankView, myEdge: edge, oppActionThisRound: null, oppRaisedLastRound: false };
      expect(resolved(v)).toBe(PRESETS.Bully(v));
    }
    const policy = await addAgent({
      name: "Q",
      presetName: null,
      policyTable: policyFromAgent(PRESETS.Anchor, blankView),
    });
    const agent = resolveAgent(policy);
    for (const edge of [0.3, 0.5, 0.7]) {
      const view = { ...blankView, myEdge: edge, oppActionThisRound: null, oppRaisedLastRound: false };
      expect(agent(view)).toBe(PRESETS.Anchor(view));
    }
    expect(() => resolveAgent({ name: "X", presetName: "Nobody", policyTable: null })).toThrow(/unknown preset/);
    expect(() => resolveAgent({ name: "X", presetName: null, policyTable: null })).toThrow(/neither/);
  });
});

describe("ratings", () => {
  it("are the mean net over the last 50 matches, and count every match played", async () => {
    const a = await addAgent({ name: "Rated" });
    const b = await addAgent({ name: "Other", presetName: "Bully" });
    // 60 matches with known nets: 10 of +10, then 50 alternating +6 / -2.
    const nets = [...Array.from({ length: 10 }, () => 10), ...Array.from({ length: 50 }, (_, i) => (i % 2 ? -2 : 6))];
    for (const [i, net] of nets.entries()) {
      await db.insert(matches).values({
        agentA: a.id,
        agentB: b.id,
        seed: i,
        rulesConfig: DEFAULT_RULES,
        winner: net > 0 ? "A" : "B",
        netA: net,
        netB: -net,
        log: { rounds: [] } as never,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    await updateRating(db, a.id);
    const [row] = await db.select().from(ratings).where(eq(ratings.agentId, a.id));
    const last50 = nets.slice(-RATING_WINDOW);
    const expected = last50.reduce((x, y) => x + y, 0) / RATING_WINDOW;
    expect(row!.matchesPlayed).toBe(60);
    expect(row!.rollingNet50).toBeCloseTo(expected, 10);
    expect(expected).toBeCloseTo(2, 10); // 25 x +6 and 25 x -2

    // From the opponent's side the same matches count with the opposite sign.
    await updateRating(db, b.id);
    const [opp] = await db.select().from(ratings).where(eq(ratings.agentId, b.id));
    expect(opp!.rollingNet50).toBeCloseTo(-expected, 10);
  });
});

describe("matchmaking", () => {
  it("never pairs an owner with themselves, and prefers the closest rating", async () => {
    const owner = someWallet();
    const other = "22222222-2222-2222-2222-222222222222";
    const me = await addAgent({ name: "Mine", ownerId: owner });
    const sibling = await addAgent({ name: "Also mine", ownerId: owner });
    const rivals = [];
    for (let i = 0; i < 5; i++) rivals.push(await addAgent({ name: `Rival ${i}`, ownerId: other }));

    // Everyone has a recent match, including my own sibling.
    for (const agent of [me, sibling, ...rivals]) {
      await db.insert(matches).values({
        agentA: agent.id,
        agentB: me.id === agent.id ? sibling.id : me.id,
        seed: 1,
        rulesConfig: DEFAULT_RULES,
        winner: "A",
        netA: 0,
        netB: 0,
        log: { rounds: [] } as never,
      });
    }
    // Matchmaking pairs on the exact rating, so set those.
    await db.update(agents).set({ trueRating: 0.5 }).where(eq(agents.id, me.id));
    await db.update(agents).set({ trueRating: 0.5 }).where(eq(agents.id, sibling.id));
    for (const [i, rival] of rivals.entries()) {
      await db.update(agents).set({ trueRating: i === 2 ? 0.45 : 3 + i }).where(eq(agents.id, rival.id));
    }

    for (let i = 0; i < 25; i++) {
      const pick = await pickOpponent(db, me.id);
      expect(pick.opponentId).not.toBe(me.id);
      expect(pick.opponentId).not.toBe(sibling.id);
      if (pick.path === "closest-rating") expect(pick.opponentId).toBe(rivals[2]!.id);
    }
  });

  it("falls back to a preset agent when the pool is thin, and logs which path it took", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const lonely = await createAgent(fresh, { name: "Lonely", presetName: "Anchor", ownerId: someWallet() });
    const preset = await createAgent(fresh, { name: "Roster", presetName: "Mirage", ownerId: someWallet() });

    const picks: OpponentPick[] = [];
    const pick = await pickOpponent(fresh, lonely.id, { onLog: (p) => picks.push(p) });
    expect(pick.path).toBe("preset-fallback");
    expect(pick.opponentId).toBe(preset.id);
    expect(pick.candidates).toBeLessThan(4);
    expect(picks).toHaveLength(1);
    await closeFresh();
  });
});

describe("ladder", () => {
  it("ranks all-time net won, with no minimum, and shows recent form separately", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const make = async (name: string, nets: number[], retired = false) => {
      // Players on both sides: the ladder lists only rented agents, and only
      // their matches against each other are ranked.
      const [row] = await fresh
        .insert(agents)
        .values({
          name,
          presetName: "Anchor",
          policyTable: snapshotPreset("Anchor"),
          ownerId: someWallet(),
          retiredAt: retired ? new Date() : null,
        })
        .returning();
      await fresh.insert(ratings).values({ agentId: row!.id });
      await fresh.insert(ledger).values({ agentId: row!.id, amount: STARTING_BALANCE, reason: "rental-seed" });
      const [opp] = await fresh
        .insert(agents)
        .values({ name: `${name}-opp`, presetName: "Bully", policyTable: snapshotPreset("Bully"), ownerId: someWallet() })
        .returning();
      await fresh.insert(ratings).values({ agentId: opp!.id });
      await fresh.insert(ledger).values({ agentId: opp!.id, amount: STARTING_BALANCE, reason: "rental-seed" });
      for (const [i, net] of nets.entries()) {
        await fresh.insert(matches).values({
          agentA: row!.id,
          agentB: opp!.id,
          seed: i,
          rulesConfig: DEFAULT_RULES,
          winner: net > 0 ? "A" : "B",
          netA: net,
          netB: -net,
          // Ranked: these stand in for player-versus-player matches, which are
          // the only ones the ladder orders. Unranked matches are covered in
          // test/ranked.test.ts.
          ranked: true,
          log: { rounds: [] } as never,
        });
      }
      await updateRating(fresh, row!.id);
      return row!;
    };
    // Three matches, +30 total: fewer than the old 20-match threshold, still ranked.
    const sprinter = await make("Sprinter", [10, 10, 10]);
    // Ten matches, +50 total, poor recent form.
    await make("Grinder", [20, 20, 20, 20, 20, -10, -10, -10, -10, -10]);
    await make("Retired", [100, 100], true);

    const board = await leaderboard(fresh);
    // Every player appears, opponents and retired ones included; ranking is all-time net won.
    const active = board.filter((r) => !r.retired);
    expect(active.map((r) => r.name).slice(0, 2)).toEqual(["Grinder", "Sprinter"]);
    const retired = board.find((r) => r.name === "Retired");
    expect(retired?.retired).toBe(true);
    expect(retired?.cumulativeNet).toBe(200);
    expect(board.every((r, i) => i === 0 || board[i - 1]!.cumulativeNet >= r.cumulativeNet)).toBe(true);
    expect(board.every((r) => typeof r.balance === "number")).toBe(true);
    expect(active[0]!.cumulativeNet).toBe(50);
    expect(active[0]!.recentForm).toBeCloseTo(5, 9);
    expect(active[1]!.cumulativeNet).toBe(30);
    expect(board.find((r) => r.name === sprinter.name)!.matchesPlayed).toBe(3);
    // The private rating is not in the ladder at all.
    expect(Object.keys(board[0]!)).not.toContain("trueRating");
    await closeFresh();
  });

  it("orders the recent-form window by seq, not by a shared timestamp", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const a = (await fresh.insert(agents).values({ name: "A", presetName: "Anchor", policyTable: snapshotPreset("Anchor") }).returning())[0]!;
    const b = (await fresh.insert(agents).values({ name: "B", presetName: "Bully", policyTable: snapshotPreset("Bully") }).returning())[0]!;
    await fresh.insert(ratings).values([{ agentId: a.id }, { agentId: b.id }]);
    await fresh.insert(ledger).values([
      { agentId: a.id, amount: STARTING_BALANCE, reason: "rental-seed" as const },
      { agentId: b.id, amount: STARTING_BALANCE, reason: "rental-seed" as const },
    ]);
    const stamp = new Date("2026-01-01T00:00:00Z");
    // 60 matches sharing one timestamp: only seq distinguishes them.
    for (let i = 0; i < 60; i++) {
      await fresh.insert(matches).values({
        agentA: a.id,
        agentB: b.id,
        seed: i,
        rulesConfig: DEFAULT_RULES,
        winner: "A",
        netA: i < 10 ? 100 : 2,
        netB: i < 10 ? -100 : -2,
        log: { rounds: [] } as never,
        createdAt: stamp,
      });
    }
    await updateRating(fresh, a.id);
    const [row] = await fresh.select().from(ratings).where(eq(ratings.agentId, a.id));
    // The last 50 are all +2; the +100s are outside the window.
    expect(row!.rollingNet50).toBeCloseTo(2, 9);
    expect(row!.cumulativeNet).toBe(10 * 100 + 50 * 2);
    await closeFresh();
  });
});

describe("true rating", () => {
  it("is the exact expected net against the roster, and matches the calculator", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    for (let i = 0; i < 8; i++) {
      await createAgent(fresh, { name: `R${i}`, presetName: i % 2 === 0 ? "Anchor" : "Bully" });
    }
    const mine = await createAgent(fresh, { name: "Mine", brief: "aim at bullies", policyTable: snapshotPreset("Mirage") });
    await refreshTrueRatings(fresh);

    const [row] = await fresh.select().from(agents).where(eq(agents.id, mine.id));
    const half = (a: "Anchor" | "Bully") => seatAveragedNet(policyAgent(snapshotPreset("Mirage")), PRESETS[a], OXUDE_RULES);
    // Roster is 4 Anchors, 4 Bullys and Mirage itself; an agent is rated against everyone but itself.
    const profile = await rosterProfile(fresh, "B");
    const expected = (4 * half("Anchor") + 4 * half("Bully")) / 8;
    expect(row!.trueRating).toBeCloseTo(expected, 9);
    expect(trueRatingAgainst(policyAgent(snapshotPreset("Mirage")), rosterWithout(profile, snapshotPreset("Mirage")))).toBeCloseTo(expected, 9);

    // A preview needs no agent row and no match.
    const preview = previewPolicy(snapshotPreset("Bully"), profile);
    expect(preview.roster).toBe(9);
    expect(preview.breakdown).toHaveLength(3);
    expect(preview.trueRating).toBeCloseTo(trueRatingAgainst(PRESETS.Bully, profile), 9);
    await closeFresh();
  });

  it("does not move when the previewed table is rented", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    for (let i = 0; i < 6; i++) {
      await createAgent(fresh, { name: `R${i}`, presetName: (["Anchor", "Bully", "Mirage"] as const)[i % 3]! });
    }
    // A Mirage already on the roster still counts as an opponent for a new Mirage.
    const table = snapshotPreset("Mirage");
    const preview = previewPolicy(table, await rosterProfile(fresh, "B"));

    const mine = await createAgent(fresh, { name: "Mine", brief: "bluff", policyTable: table });
    await refreshTrueRatings(fresh);
    const [row] = await fresh.select().from(agents).where(eq(agents.id, mine.id));
    expect(row!.trueRating).toBeCloseTo(preview.trueRating, 12);
    await closeFresh();
  });

  it("rates against the agent's own band only, since no match crosses bands", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    // Band A holds only Anchors, band C only Bullys: the same table is worth
    // different amounts in each, and neither band sees the other's agents.
    for (let i = 0; i < 4; i++) await createAgent(fresh, { name: `A${i}`, presetName: "Anchor", band: "A" });
    for (let i = 0; i < 4; i++) await createAgent(fresh, { name: `C${i}`, presetName: "Bully", band: "C" });
    const inA = await createAgent(fresh, { name: "MirageA", presetName: "Mirage", band: "A", ownerId: someWallet() });
    const inC = await createAgent(fresh, { name: "MirageC", presetName: "Mirage", band: "C", ownerId: someWallet() });
    await refreshTrueRatings(fresh);

    const mirage = policyAgent(snapshotPreset("Mirage"));
    const vs = (a: "Anchor" | "Bully") => seatAveragedNet(mirage, PRESETS[a], OXUDE_RULES);
    const [a] = await fresh.select().from(agents).where(eq(agents.id, inA.id));
    const [c] = await fresh.select().from(agents).where(eq(agents.id, inC.id));
    expect(a!.trueRating).toBeCloseTo(vs("Anchor"), 9);
    expect(c!.trueRating).toBeCloseTo(vs("Bully"), 9);

    // The preview for band A rates against band A's roster, priced in band A's money.
    const preview = previewPolicy(snapshotPreset("Mirage"), await rosterProfile(fresh, "A"));
    expect(preview.band).toBe("A");
    expect(preview.roster).toBe(5);
    // A preview rates a table that is not on the roster yet, so it counts MirageA too, which nets 0 against itself.
    expect(preview.trueRating).toBeCloseTo((4 * vs("Anchor")) / 5, 9);
    expect(preview.priced.perMatch).toBeCloseTo(preview.trueRating * 0.5, 12);
    await closeFresh();
  });

  it("leaves player agents idle for a week out of the roster it rates against, but keeps them matchable", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // House agents never go idle, however old.
    for (let i = 0; i < 4; i++) {
      const h = await createAgent(fresh, { name: `H${i}`, presetName: "Anchor" });
      await fresh.update(agents).set({ createdAt: longAgo }).where(eq(agents.id, h.id));
    }
    // Three rentals of one preset: two dormant for eight days, one that played yesterday.
    const dormant: string[] = [];
    for (let i = 0; i < 2; i++) {
      const d = await createAgent(fresh, { name: `Dormant${i}`, presetName: "Mirage", ownerId: someWallet() });
      await fresh.update(agents).set({ createdAt: longAgo }).where(eq(agents.id, d.id));
      dormant.push(d.id);
    }
    const busy = await createAgent(fresh, { name: "Busy", presetName: "Mirage", ownerId: someWallet() });
    await fresh.update(agents).set({ createdAt: longAgo }).where(eq(agents.id, busy.id));
    // A real opponent, because a house match is an exhibition now and says
    // nothing about whether an agent has been active.
    const sparring = await createAgent(fresh, { name: "Sparring", presetName: "Anchor", ownerId: someWallet() });
    await fresh.update(agents).set({ createdAt: longAgo }).where(eq(agents.id, sparring.id));
    await runMatch(fresh, busy.id, sparring.id, { seed: 1 });
    // And one rented today, which has had no chance to play yet.
    const fresher = await createAgent(fresh, { name: "New", presetName: "Bully", ownerId: someWallet() });

    const profile = await rosterProfile(fresh, "B");
    expect(profile.agentCount).toBe(7); // 4 house, Busy, Sparring, New
    for (const id of dormant) expect(profile.members.has(id)).toBe(false);
    expect(profile.members.has(busy.id)).toBe(true);
    expect(profile.members.has(fresher.id)).toBe(true);

    // A dormant agent is rated against the active roster, with nothing subtracted for itself.
    await refreshTrueRatings(fresh, { force: true });
    const [d0] = await fresh.select().from(agents).where(eq(agents.id, dormant[0]!));
    expect(d0!.trueRating).toBeCloseTo(trueRatingAgainst(policyAgent(snapshotPreset("Mirage")), profile), 12);

    // Still matchable: idle is about ratings, not about who can be played.
    const pick = await pickOpponent(fresh, fresher.id);
    // Players only: a house agent stakes nothing, so matchmaking will not offer
    // one. Both dormant, Busy and Sparring - idle is about ratings, not about
    // who can be played.
    expect(pick.candidates).toBe(4);
    await closeFresh();
  });

  it("is recomputed when the roster changes materially, and skipped when it has not", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    for (let i = 0; i < 4; i++) await createAgent(fresh, { name: `A${i}`, presetName: "Anchor" });
    const mine = await createAgent(fresh, { name: "Mine", presetName: "Mirage" });
    expect(await refreshTrueRatings(fresh)).toBe(5);
    const before = (await fresh.select().from(agents).where(eq(agents.id, mine.id)))[0]!;
    // Nothing changed: no work, same rating.
    expect(await refreshTrueRatings(fresh)).toBe(0);

    for (let i = 0; i < 6; i++) await createAgent(fresh, { name: `B${i}`, presetName: "Bully" });
    expect(await refreshTrueRatings(fresh)).toBe(11);
    const after = (await fresh.select().from(agents).where(eq(agents.id, mine.id)))[0]!;
    expect(after.trueRating).not.toBeCloseTo(before.trueRating!, 6);
    expect(after.trueRatingRoster).not.toBe(before.trueRatingRoster);
    await closeFresh();
  });

  it("is private: absent from the public view of an agent, and owner-gated", async () => {
    const owner = someWallet();
    const mine = await createAgent(db, { name: "Private", ownerId: owner, brief: "secret sauce", presetName: "Hammer" });
    await refreshTrueRatings(db, { force: true });

    const seen = await publicAgent(db, mine.id);
    expect(seen).toBeDefined();
    expect(Object.keys(seen!)).not.toContain("trueRating");
    expect(Object.keys(seen!)).not.toContain("brief");
    expect(Object.keys(seen!)).not.toContain("policyTable");

    const own = await ownerAgent(db, mine.id, owner);
    expect(own!.trueRating).toBeTypeOf("number");
    expect(own!.brief).toBe("secret sauce");
    await expect(ownerAgent(db, mine.id, "44444444-4444-4444-4444-444444444444")).rejects.toThrow(/another owner/);
  });
});

describe("transcript permanence", () => {
  it("replays from the stored table even when the named preset would now play differently", async () => {
    // The row names a preset but stores a different table: the stored one must win.
    const drifted = await addAgent({ name: "Drifted", presetName: "Anchor", policyTable: snapshotPreset("Bully") });
    const opponent = await addAgent({ name: "Opp", presetName: "Mirage" });
    const { match, log } = await runMatch(db, drifted.id, opponent.id);
    const [stored] = await db.select().from(matches).where(eq(matches.id, match.id));

    expect(replayMatch(stored!, resolveAgent(drifted), resolveAgent(opponent))).toEqual(log);
    // Resolution ignores the preset name in favour of the snapshot.
    const view = { myEdge: 0.4, oppActionThisRound: null, oppRaisedLastRound: false, ...blankView };
    expect(resolveAgent(drifted)(view)).toBe(PRESETS.Bully(view));
    expect(stored!.rulesConfig.presetVersion).toBe(PRESET_VERSION);
  });
});

describe("variable stakes", () => {
  it("refuses to play a table at stakes it was not built for", async () => {
    const a = await createAgent(db, { name: "Priced", presetName: "Anchor" });
    const b = await createAgent(db, { name: "Also priced", presetName: "Bully" });
    const otherStakes = { ...DEFAULT_RULES.stakes, ante: 8 };

    await expect(runMatch(db, a.id, b.id, { rules: { ...DEFAULT_RULES, stakes: otherStakes } })).rejects.toThrow(
      /table built for ante 4\/10\/20, but this match is at ante 8\/10\/20/,
    );
    // The same agents at the stakes they were built for are fine.
    await expect(runMatch(db, a.id, b.id)).resolves.toBeDefined();
    expect(() => assertStakesMatch({ name: "x", policyStakes: DEFAULT_RULES.stakes }, otherStakes)).toThrow(
      /re-elicit or re-snapshot/,
    );
  });
});

describe("ladder tabs", () => {
  it("offers winnings and net per match, and both are facts", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const make = async (name: string, nets: number[]) => {
      const row = await createAgent(fresh, { name, presetName: "Anchor", ownerId: someWallet() });
      const opp = await createAgent(fresh, { name: `${name}-opp`, presetName: "Bully", ownerId: someWallet() });
      for (const [i, net] of nets.entries()) {
        await fresh.insert(matches).values({
          agentA: row.id,
          agentB: opp.id,
          seed: i,
          rulesConfig: DEFAULT_RULES,
          winner: net > 0 ? "A" : "B",
          netA: net,
          netB: -net,
          // As above: the ladder only orders player-versus-player matches.
          ranked: true,
          log: { rounds: [] } as never,
        });
      }
      await updateRating(fresh, row.id);
      await updateRating(fresh, opp.id);
      return row;
    };
    // Volume player: more won in total, less per match.
    await make("Grinder", Array.from({ length: 40 }, () => 5));
    // Sharp: fewer matches, far better per match.
    await make("Sharp", [30, 30, 30]);
    const idle = await createAgent(fresh, { name: "Idle", presetName: "Mirage", ownerId: someWallet() });

    const winnings = await leaderboard(fresh, 50, "winnings");
    expect(winnings[0]!.name).toBe("Grinder");
    expect(winnings[0]!.cumulativeNet).toBe(200);
    expect(winnings.map((r) => r.name)).toContain(idle.name); // no minimum to appear

    const perMatch = await leaderboard(fresh, 50, "per-match");
    expect(perMatch[0]!.name).toBe("Sharp");
    expect(perMatch[0]!.netPerMatch).toBeCloseTo(30, 9);
    expect(perMatch.find((r) => r.name === "Grinder")!.netPerMatch).toBeCloseTo(5, 9);
    // Nothing to divide by, so an agent with no matches is absent from this tab only.
    expect(perMatch.map((r) => r.name)).not.toContain(idle.name);
    for (const row of [...winnings, ...perMatch]) expect(Object.keys(row)).not.toContain("trueRating");
    await closeFresh();
  });
});

describe("stored transcripts", () => {
  it("render from the log with the agents' names and nothing private", async () => {
    const mine = await createAgent(db, { name: "Teller", brief: "bluff a lot", policyTable: snapshotPreset("Mirage") });
    const foe = await createAgent(db, { name: "Listener", presetName: "Anchor" });
    const { match } = await runMatch(db, mine.id, foe.id, { seed: 4242 });
    const text = await renderStoredTranscript(db, match.id);
    expect(text.split("\n")[0]).toBe("Teller vs Listener");
    expect(text).toContain("Round 1.");
    expect(text.toLowerCase()).not.toContain("bluff a lot");
    await expect(renderStoredTranscript(db, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no match/);
  });
});

describe("agent record", () => {
  it("counts a match by money, not rounds: finishing ahead is a win", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const a = await createAgent(fresh, { name: "A", presetName: "Mirage" });
    const b = await createAgent(fresh, { name: "B", presetName: "Anchor" });
    const row = (winner: "A" | "B" | null, netA: number) => ({
      agentA: a.id,
      agentB: b.id,
      seed: 1,
      rulesConfig: DEFAULT_RULES,
      winner,
      netA,
      netB: -netA,
      stake: 60,
      log: { rounds: [] } as never,
    });
    // B took more rounds in the first, but A finished ahead on money.
    await fresh.insert(matches).values([row("B", 6), row("A", 20), row("B", -36), row(null, 0)]);
    expect(await agentRecord(fresh, a.id)).toEqual({ wins: 2, losses: 1, level: 1 });
    expect(await agentRecord(fresh, b.id)).toEqual({ wins: 1, losses: 2, level: 1 });
    await closeFresh();
  });
});
