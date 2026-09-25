import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { matches } from "../src/db/schema.js";
import { createAgent, runExhibition, runMatch } from "../src/db/runner.js";
import { latestSeq, liveCounters, matchesAfter, recentMatches } from "../src/db/feed.js";
import { renderTranscript } from "../src/transcript.js";
import { listen } from "../src/http/server.js";
import { PLAY_MS, type LiveOptions } from "../src/http/live.js";

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

/** Reads server-sent events off a fetch body, one parsed event at a time. `next.stop()` hangs up. */
function events(res: Response) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async function (timeoutMs = 5000): Promise<{ event: string; id: string | null; data: any }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
        const event = field("event");
        if (event) return { event, id: field("id"), data: JSON.parse(field("data")!) };
        continue; // retry: and : ping lines
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no event in time");
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no event in time")), left)),
      ]);
      if (chunk.done) throw new Error("stream ended");
      buffer += chunk.value;
    }
  };
  return Object.assign(next, {
    stop: () => reader.cancel(),
    /** Whether the server ends the stream within a second. */
    ended: async () => {
      for (;;) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
        if (chunk === null) return false;
        if (chunk.done) return true;
      }
    },
  });
}

describe("GET /live", () => {
  const start = async (live: LiveOptions = {}) => {
    const { db, close: closeDb } = await fresh();
    const server = await listen({ db, live: { pollMs: 20, ...live } });
    const a = await createAgent(db, { name: "HouseA", presetName: "Mirage" });
    const b = await createAgent(db, { name: "HouseB", presetName: "Bully" });
    return {
      db,
      url: server.url,
      a,
      b,
      close: async () => {
        await server.close();
        await closeDb();
      },
    };
  };

  it("says hello, then streams each match as it is recorded", async () => {
    const t = await start();
    const res = await fetch(`${t.url}/live`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    const next = events(res);

    const hello = await next();
    expect(hello.event).toBe("hello");
    expect(hello.data).toEqual({ counters: { matchesToday: 0, totalStaked: 0 }, playMs: PLAY_MS });

    const played = await runMatch(t.db, t.a.id, t.b.id, { seed: 4 });
    const staked = await next();
    expect(staked.event).toBe("match");
    expect(staked.id).toBe(String(played.match.seq));
    expect(staked.data.match.id).toBe(played.match.id);
    expect(staked.data.match.play).toHaveLength(played.log.rounds.length);
    expect(staked.data.ageMs).toBeLessThan(PLAY_MS);
    expect(staked.data.counters).toEqual({ matchesToday: 1, totalStaked: played.stake * 2 });

    // An exhibition is streamed too, and changes no counter.
    await runExhibition(t.db, t.a.id, t.b.id, { seed: 5 });
    const exhibition = await next();
    expect(exhibition.data.match.exhibition).toBe(true);
    expect(exhibition.data.counters).toBeUndefined();

    await next.stop();
    await t.close();
  });

  it("replays what a reconnecting browser missed, from Last-Event-ID", async () => {
    const t = await start();
    const first = await runMatch(t.db, t.a.id, t.b.id, { seed: 1 });
    const missed = [await runMatch(t.db, t.a.id, t.b.id, { seed: 2 }), await runMatch(t.db, t.a.id, t.b.id, { seed: 3 })];

    const res = await fetch(`${t.url}/live`, { headers: { "last-event-id": String(first.match.seq) } });
    const next = events(res);
    expect((await next()).event).toBe("hello");
    expect((await next()).data.match.id).toBe(missed[0]!.match.id);
    expect((await next()).data.match.id).toBe(missed[1]!.match.id);
    await next.stop();
    await t.close();
  });

  it("shows a newcomer the match still playing out, and not older ones", async () => {
    const t = await start();
    const old = await runMatch(t.db, t.a.id, t.b.id, { seed: 1 });
    await t.db.update(matches).set({ createdAt: new Date(Date.now() - PLAY_MS - 1000) }).where(eq(matches.id, old.match.id));
    const current = await runMatch(t.db, t.a.id, t.b.id, { seed: 2 });

    const res = await fetch(`${t.url}/live`);
    const next = events(res);
    expect((await next()).event).toBe("hello");
    const playing = await next();
    expect(playing.data.match.id).toBe(current.match.id);
    await expect(next(300)).rejects.toThrow(/no event/);
    await next.stop();
    await t.close();
  });

  it("limits how many streams one address holds open", async () => {
    const t = await start({ perAddress: 2 });
    const open = [await fetch(`${t.url}/live`), await fetch(`${t.url}/live`)];
    const third = await fetch(`${t.url}/live`);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("30");
    for (const r of open) await r.body!.cancel();
    await t.close();
  });

  it("does not keep the server from closing", async () => {
    const t = await start();
    const next = events(await fetch(`${t.url}/live`));
    await next();
    await t.close();
    expect(await next.ended()).toBe(true);
  });
});
