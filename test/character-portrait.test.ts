import { describe, expect, it } from "vitest";
import { snapshotPreset } from "../src/db/runner.js";
import { PRESET_NAMES } from "../src/presets.js";
import { CHARACTER_TYPES, portrait, uniquePortrait } from "../src/character/portrait.js";
import { PALETTES } from "../src/character/draw.js";
import { table } from "./helpers.js";

const extremes = [
  ...PRESET_NAMES.map((n) => snapshotPreset(n)),
  table({}, "r r r r r"),
  table({}, "c c c c c"),
  table({ vsRaise: "f f f f c", vsRaiseUnderPressure: "f f f f f" }, "c c c r r"),
];

/** Every coordinate the character is drawn at, mapped through its transform into the 100-unit frame. */
function characterCoordinates(svg: string): number[] {
  const [, tx, ty, k] = svg.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/)!.map(Number) as number[];
  const group = svg.slice(svg.indexOf("<g "));
  const out: number[] = [];
  for (const [, list] of group.matchAll(/points="([^"]+)"/g)) {
    for (const pair of list!.split(" ")) {
      const [x, y] = pair.split(",").map(Number) as [number, number];
      out.push(tx! + x * k!, ty! + y * k!);
    }
  }
  return out;
}

describe("portraits", () => {
  it("are the same face, byte for byte, every time, large and small", () => {
    const t = snapshotPreset("Mirage");
    const a = portrait("agent-1", t);
    const b = portrait("agent-1", t);
    expect(a.svg).toBe(b.svg);
    expect(a.svgSmall).toBe(b.svgSmall);
    expect(a.svg).not.toBe(portrait("agent-2", t).svg);
  });

  it("take the character from the id and the expression from the table", () => {
    const calm = portrait("same-id", snapshotPreset("Anchor"));
    const sly = portrait("same-id", snapshotPreset("Mirage"));
    // Same id: the same character, colours and accessories. Different play: a different face on it.
    expect(calm.features).toEqual(sly.features);
    expect(calm.svg).not.toBe(sly.svg);
    expect(calm.fingerprint).not.toBe(sly.fingerprint);
  });

  it("give each preset the mood of how it plays", () => {
    const mood = (n: (typeof PRESET_NAMES)[number]) => portrait("x", snapshotPreset(n)).expression;
    expect(mood("Anchor")).toMatchObject({ mood: "calm", wary: false });
    expect(mood("Hammer")).toMatchObject({ mood: "fierce", wary: false });
    expect(mood("Mirage")).toMatchObject({ mood: "sly" });
    // Raises almost everything, then folds when raised back at.
    expect(mood("Bully")).toMatchObject({ mood: "fierce", wary: true });
  });

  it("are plain shapes: no text, no links, nothing fetched, and small", () => {
    for (const t of extremes) {
      for (let i = 0; i < 60; i++) {
        const p = portrait(`check-${i}`, t);
        for (const svg of [p.svg, p.svgSmall]) {
          expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"')).toBe(true);
          expect(svg).not.toMatch(/<text|href|url\(|<image|<script|<foreignObject|<style/);
          expect(svg.length).toBeLessThan(9000);
        }
      }
    }
  });

  it("borrow nothing from the Oxude mark", () => {
    for (let i = 0; i < 400; i++) {
      const p = portrait(`mark-${i}`, snapshotPreset(PRESET_NAMES[i % 4]!));
      expect(p.svg.toLowerCase()).not.toContain("#ff2d2d");
    }
    expect(CHARACTER_TYPES.map((t) => t.name)).not.toContain("bull");
  });

  it("keep the large drawing inside the frame, outline included", () => {
    // The outline is 1.8 units at 0.82 scale; a point may sit that close to the edge and no closer.
    for (const t of extremes) {
      for (let i = 0; i < 100; i++) {
        for (const v of characterCoordinates(portrait(`fit-${i}`, t).svg)) {
          expect(v).toBeGreaterThanOrEqual(0.8);
          expect(v).toBeLessThanOrEqual(99.2);
        }
      }
    }
  });

  it("reach every character type and every colour scheme", () => {
    const types = new Set<string>();
    const palettes = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const f = portrait(`reach-${i}`, snapshotPreset("Anchor")).features;
      types.add(f.type);
      palettes.add(f.palette);
    }
    expect(types.size).toBe(CHARACTER_TYPES.length);
    expect(palettes.size).toBe(PALETTES.length);
  });

  it("give neighbours a different character or colour scheme until every look is used", () => {
    const taken = new Set<string>();
    const looks = CHARACTER_TYPES.length * PALETTES.length;
    for (let i = 0; i < looks - 40; i++) {
      const p = uniquePortrait(`look-${i}`, snapshotPreset(PRESET_NAMES[i % 4]!), taken);
      expect(taken.has(p.lookKey)).toBe(false);
      taken.add(p.lookKey);
      taken.add(p.fingerprint);
    }
  });

  it("never repeat a face, however many agents there are", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const p = uniquePortrait(`many-${i}`, snapshotPreset("Mirage"), taken);
      expect(taken.has(p.fingerprint)).toBe(false);
      taken.add(p.fingerprint);
      taken.add(p.lookKey);
      // A re-roll changes the character, never the table's expression.
      expect(p.expression.mood).toBe("sly");
    }
  });
});
