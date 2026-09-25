import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { matches } from "../src/db/schema.js";
import { createAgent, runExhibition, runMatch } from "../src/db/runner.js";
import { latestSeq, liveCounters, matchesAfter, recentMatches } from "../src/db/feed.js";
import { renderTranscript } from "../src/transcript.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

describe("the live tail", () => {
  it("reads every match after a seq, oldest first, exhibitions included", async () => {
    const { db, close } = await fresh();
    expect(await latestSeq(db)).toBe(0);
    const a = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const b = await createAgent(db, { name: "HouseB", presetName: "Bully" });
    await runExhibition(db, a.id, b.id, { seed: 1 });
    const from = await latestSeq(db);
    await runMatch(db, a.id, b.id, { seed: 2 });
    await runExhibition(db, a.id, b.id, { seed: 3 });

    const after = await matchesAfter(db, from);
    expect(after.map((m) => m.exhibition)).toEqual([false, true]);
    expect(after[0]!.seq).toBeLessThan(after[1]!.seq);
    expect(await latestSeq(db)).toBe(after[1]!.seq);
    expect(await matchesAfter(db, after[1]!.seq)).toEqual([]);
    // The same row the feed shows, plus its rounds.
    const [row] = await recentMatches(db, { limit: 1, stakedOnly: true });
    const { play, ...item } = after[0]!;
    expect(item).toEqual(row);
    expect(play).toHaveLength(row!.rounds);
    await close();
  });

  it("plays out to the match's own result, with nothing the transcript does not show", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "Left", presetName: "Mirage" });
    const b = await createAgent(db, { name: "Right", presetName: "Hammer" });
    for (let seed = 1; seed <= 8; seed++) await runMatch(db, a.id, b.id, { seed });

    for (const m of await matchesAfter(db, 0)) {
      const last = m.play.at(-1)!;
      expect(last.nets).toEqual({ A: m.netA, B: m.netB });
      const [row] = await db.select().from(matches).where(eq(matches.id, m.id));
      const transcript = renderTranscript(row!.log, { A: m.a.name, B: m.b.name });
      for (const r of m.play) {
        // Both hands, as the transcript prints them.
        expect(transcript).toContain(`Left holds ${r.edges.A.toFixed(2)}`);
        expect(transcript).toContain(`Right holds ${r.edges.B.toFixed(2)}`);
        expect(r.chanceA === null).toBe(r.outcome !== "flipped");
      }
      if (m.beat) expect(m.play.some((r) => r.beats.includes(m.beat as never))).toBe(true);
    }
    await close();
  });

  it("counts today's staked matches and every chip staked, and no exhibition", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const b = await createAgent(db, { name: "HouseB", presetName: "Bully" });
    await runExhibition(db, a.id, b.id, { seed: 1 });
    expect(await liveCounters(db, new Date())).toEqual({ matchesToday: 0, totalStaked: 0 });

    const first = await runMatch(db, a.id, b.id, { seed: 2 });
    const second = await runMatch(db, a.id, b.id, { seed: 3 });
    // One of them yesterday: it still counts toward what was staked, not toward today.
    const yesterday = new Date(Date.now() - 86_400_000);
    await db.update(matches).set({ createdAt: yesterday }).where(eq(matches.id, first.match.id));

    expect(await liveCounters(db, new Date())).toEqual({
      matchesToday: 1,
      totalStaked: (first.stake + second.stake) * 2,
    });
    await close();
  });
});
