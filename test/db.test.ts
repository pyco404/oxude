import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, matches, ratings, MIN_RANKED_MATCHES, RATING_WINDOW } from "../src/db/schema.js";
import {
  DEFAULT_RULES,
  leaderboard,
  pickOpponent,
  replayMatch,
  resolveAgent,
  runMatch,
  updateRating,
  type OpponentPick,
} from "../src/db/runner.js";
import { policyFromAgent, PRESETS, OXUDE_RULES, type View } from "../src/index.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await connect());
  await migrate(db);
});
afterAll(async () => close());

const addAgent = async (values: Partial<typeof agents.$inferInsert> & { name: string }) => {
  const [row] = await db
    .insert(agents)
    .values({ presetName: "Anchor", ...values })
    .returning();
  await db.insert(ratings).values({ agentId: row!.id });
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
      const { match, log } = await runMatch(db, a.id, b.id);
      const [stored] = await db.select().from(matches).where(eq(matches.id, match.id));
      const replayed = replayMatch(stored!, resolveAgent(a), resolveAgent(b));
      expect(replayed).toEqual(stored!.log);
      expect(replayed).toEqual(log);
      expect(stored!.netA).toBe(log.nets.A);
      expect(stored!.netB).toBe(-log.nets.A);
      expect(stored!.rulesConfig).toEqual(DEFAULT_RULES);
    }
  });

  it("resolves presets by name and player agents from their stored table", async () => {
    const preset = await addAgent({ name: "P", presetName: "Bully" });
    expect(resolveAgent(preset)).toBe(PRESETS.Bully);
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
    const owner = "11111111-1111-1111-1111-111111111111";
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
    await db.update(ratings).set({ rollingNet50: 5 }).where(eq(ratings.agentId, me.id));
    await db.update(ratings).set({ rollingNet50: 5 }).where(eq(ratings.agentId, sibling.id));
    await db.update(ratings).set({ rollingNet50: 4.5 }).where(eq(ratings.agentId, rivals[2]!.id));

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
    const [lonely] = await fresh.insert(agents).values({ name: "Lonely", presetName: "Anchor" }).returning();
    await fresh.insert(ratings).values({ agentId: lonely!.id });
    const [preset] = await fresh.insert(agents).values({ name: "Roster", presetName: "Mirage" }).returning();
    await fresh.insert(ratings).values({ agentId: preset!.id });

    const picks: OpponentPick[] = [];
    const pick = await pickOpponent(fresh, lonely!.id, { onLog: (p) => picks.push(p) });
    expect(pick.path).toBe("preset-fallback");
    expect(pick.opponentId).toBe(preset!.id);
    expect(pick.candidates).toBeLessThan(4);
    expect(picks).toHaveLength(1);
    await closeFresh();
  });
});

describe("leaderboard", () => {
  it("hides agents with fewer than the minimum matches, and retired ones", async () => {
    const { db: fresh, close: closeFresh } = await connect();
    await migrate(fresh);
    const make = async (name: string, played: number, net: number, retired = false) => {
      const [row] = await fresh
        .insert(agents)
        .values({ name, presetName: "Anchor", retiredAt: retired ? new Date() : null })
        .returning();
      await fresh.insert(ratings).values({ agentId: row!.id, matchesPlayed: played, rollingNet50: net });
      return row!;
    };
    await make("Rookie", MIN_RANKED_MATCHES - 1, 99);
    const ranked = await make("Veteran", MIN_RANKED_MATCHES, 1.5);
    await make("Retired ace", 500, 50, true);
    const board = await fresh.select().from(ratings);
    expect(board).toHaveLength(3);

    const shown = await leaderboard(fresh);
    expect(shown.map((r) => r.name)).toEqual([ranked.name]);
    await closeFresh();
  });
});
