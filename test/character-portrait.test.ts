import { describe, expect, it } from "vitest";
import { snapshotPreset } from "../src/db/runner.js";
import { PRESET_NAMES } from "../src/presets.js";
import { portrait, uniquePortrait } from "../src/character/portrait.js";
import { table } from "./helpers.js";

const extremes = [
  ...PRESET_NAMES.map((n) => snapshotPreset(n)),
  table({}, "r r r r r"), // raises everything: the sharpest face
  table({}, "c c c c c"), // calls everything: the calmest
  table({ lead: "r c c c r", vsCall: "r c c c r", leadUnderPressure: "r r r r r", vsCallUnderPressure: "r r r r r" }),
  table({ leadUnderPressure: "f f f c c", vsCallUnderPressure: "f f f c c", vsRaise: "f f f f c", vsRaiseUnderPressure: "f f f f f" }),
];

/** Every coordinate in the SVG, mapped through the fixed transform to the frame. */
function frameCoordinates(svg: string): number[] {
  const [, tx, ty, k] = svg.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/)!.map(Number) as number[];
  const out: number[] = [];
  for (const [, list] of svg.matchAll(/points="([^"]+)"/g)) {
    for (const pair of list!.split(" ")) {
      const [x, y] = pair.split(",").map(Number) as [number, number];
      out.push(tx! + x * k!, ty! + y * k!);
    }
  }
  return out;
}

describe("portraits", () => {
  it("are the same face, byte for byte, every time", () => {
    const t = snapshotPreset("Mirage");
    expect(portrait("agent-1", t).svg).toBe(portrait("agent-1", t).svg);
    expect(portrait("agent-1", t).svg).not.toBe(portrait("agent-2", t).svg);
  });

  it("take the character from the table and the individual from the id", () => {
    const a = portrait("same-id", snapshotPreset("Anchor"));
    const m = portrait("same-id", snapshotPreset("Mirage"));
    // Same id, same individual choices; different play, different face.
    expect(a.features).toEqual(m.features);
    expect(a.svg).not.toBe(m.svg);
    expect(a.fingerprint).not.toBe(m.fingerprint);
  });

  it("are plain shapes: no text, no links, nothing fetched, and small", () => {
    for (const t of extremes) {
      const { svg } = portrait("check", t);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"')).toBe(true);
      expect(svg).not.toMatch(/<text|href|url\(|<image|<script|<foreignObject/);
      expect(svg.length).toBeLessThan(6000);
    }
  });

  it("stay inside the frame, horns and outline included, at every extreme of style", () => {
    // The widest outline stroke is 10 units at 0.8 scale: 4 either side of a point.
    for (const t of extremes) {
      for (let i = 0; i < 200; i++) {
        for (const v of frameCoordinates(portrait(`fit-${i}`, t).svg)) {
          expect(v).toBeGreaterThanOrEqual(4);
          expect(v).toBeLessThanOrEqual(96);
        }
      }
    }
  });

  it("never repeat a face: a collision re-rolls the id's choices and keeps the character", () => {
    const taken = new Set<string>();
    const mirage = snapshotPreset("Mirage");
    let rerolled = 0;
    for (let i = 0; i < 3000; i++) {
      const p = uniquePortrait(`mirage-${i}`, mirage, taken);
      expect(taken.has(p.fingerprint)).toBe(false);
      taken.add(p.fingerprint);
      if (p.salt > 0) rerolled++;
      expect(p.style).toEqual(portrait(`mirage-${i}`, mirage).style);
    }
    // Three thousand of one preset: collisions happen, and are rare enough to re-roll.
    expect(rerolled).toBeLessThan(300);
  });
});
