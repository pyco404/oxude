import { describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { candidateMarks, firstFreeMark, MARKS } from "../src/marks.js";
import { connect, migrate } from "../src/db/client.js";
import { assignMissingMarks, createAgent, snapshotPreset } from "../src/db/runner.js";
import { agents } from "../src/db/schema.js";

const graphemes = (s: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;

describe("the mark list", () => {
  it("is several hundred distinct, single, plain emoji", () => {
    expect(MARKS.length).toBeGreaterThanOrEqual(400);
    expect(new Set(MARKS).size).toBe(MARKS.length);
    for (const m of MARKS) {
      expect(graphemes(m), m).toBe(1);
      expect(m, m).toMatch(/\p{Extended_Pictographic}/u);
      // No flags (regional indicators), no skin tones, no joined sequences.
      expect(m, m).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|‍/u);
    }
  });

  it("leaves out faces, food, flags and anything religious or cultural", () => {
    const banned = [
      "🐶", "🐱", "🦁", "🐯", "🐵", "🐸", "🦊", "🐼", "😀", "🌝", "🌚", "🌞", "🃏", "🧸", "🎭", "🗿", // faces
      "🍎", "🍕", "🍄", "🌰", "🦐", "🦪", "🍩", // food
      "🏁", "🚩", "🎌", "🏳️", // flags
      "✝️", "☪️", "🕉️", "☯️", "✡️", "🕎", "⛪", "🕌", "🛕", "📿", "🪔", "🧿", "🕯️", "🎄", "🎃", "🏮", "🧧", "🎎", // religious, festive
      "🗽", "🗼", "🗻", "🍁", "💴", "💵", // national
      "🔫", "🗡️", "⚔️", "💣", "🔪", "🏹", "💩", "🚬", "💊", "💀", "☠️", "⚰️", // weapons and the like
    ];
    for (const b of banned) expect(MARKS, b).not.toContain(b);
  });
});

describe("assigning marks", () => {
  it("is deterministic: the same id always leads to the same mark", () => {
    const id = randomUUID();
    expect(firstFreeMark(id, new Set())).toBe(firstFreeMark(id, new Set()));
    expect(candidateMarks(id).next().value).toBe(firstFreeMark(id, new Set()));
  });

  it("moves on when a mark is taken, and pairs up only once every single one is", () => {
    const id = randomUUID();
    const first = firstFreeMark(id, new Set());
    const second = firstFreeMark(id, new Set([first]));
    expect(second).not.toBe(first);
    expect(MARKS).toContain(second);
    const pair = firstFreeMark(id, new Set(MARKS));
    expect(graphemes(pair)).toBe(2);
  });

  it("gives every agent a different mark, and keeps it", async () => {
    const { db, close } = await connect();
    await migrate(db);
    const made = [];
    for (let i = 0; i < 60; i++) {
      made.push(await createAgent(db, { name: `A${i}`, presetName: (["Anchor", "Hammer", "Mirage", "Bully"] as const)[i % 4]! }));
    }
    const marks = made.map((a) => a.mark);
    expect(marks.every((m) => typeof m === "string" && MARKS.includes(m))).toBe(true);
    expect(new Set(marks).size).toBe(60);
    // Already marked: the backfill leaves them alone.
    expect(await assignMissingMarks(db)).toBe(0);
    const stored = await db.select({ mark: agents.mark }).from(agents);
    expect(stored.map((r) => r.mark).sort()).toEqual([...marks].sort());
    await close();
  });

  it("backfills agents made before marks existed, uniquely", async () => {
    const { db, close } = await connect();
    await migrate(db);
    for (let i = 0; i < 25; i++) {
      await db.insert(agents).values({ name: `Old${i}`, presetName: "Anchor", policyTable: snapshotPreset("Anchor") });
    }
    expect(await assignMissingMarks(db)).toBe(25);
    expect(await db.select().from(agents).where(isNull(agents.mark))).toEqual([]);
    const marks = (await db.select({ mark: agents.mark }).from(agents)).map((r) => r.mark);
    expect(new Set(marks).size).toBe(25);
    await close();
  });
});
