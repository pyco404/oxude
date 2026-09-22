import { describe, expect, it } from "vitest";
import { playMatch, OXUDE_RULES, PRESETS, PRESET_NAMES, type PresetName } from "../src/index.js";
import { addCounts, countMatch, EMPTY_COUNTS, MIN_DECISIONS, traitsFrom, type TraitCounts } from "../src/character/traits.js";

/** One preset's counts over many matches against the others, from both seats. */
function measure(me: PresetName, matches = 240): TraitCounts {
  let c = EMPTY_COUNTS;
  for (let i = 0; i < matches; i++) {
    const opp = PRESET_NAMES[i % PRESET_NAMES.length]!;
    const asA = i % 2 === 0;
    const log = asA ? playMatch(PRESETS[me], PRESETS[opp], { seed: 1000 + i, ...OXUDE_RULES }) : playMatch(PRESETS[opp], PRESETS[me], { seed: 1000 + i, ...OXUDE_RULES });
    c = addCounts(c, countMatch(log, asA ? "A" : "B"));
  }
  return c;
}

describe("traits measured from play", () => {
  const traits = Object.fromEntries(PRESET_NAMES.map((n) => [n, traitsFrom(measure(n))])) as Record<PresetName, ReturnType<typeof traitsFrom>>;

  it("see the bluffer bluff most, and the straight players never", () => {
    expect(traits.Mirage.bluff!.rate).toBeGreaterThan(0.3);
    // Anchor and Hammer never raise a hand below even odds. Bully raises from 0.40 up, so it bluffs some.
    expect(traits.Anchor.bluff!.rate).toBe(0);
    expect(traits.Hammer.bluff!.rate).toBe(0);
    expect(traits.Bully.bluff!.rate).toBeGreaterThan(0);
    expect(traits.Bully.bluff!.rate).toBeLessThan(traits.Mirage.bluff!.rate);
    expect(traits.Mirage.bluff!.word).toMatch(/bluffs (often|relentlessly)/);
    expect(traits.Anchor.bluff!.word).toBe("never bluffs");
  });

  it("order aggression as the tables do: Bully, then Hammer, then Anchor", () => {
    expect(traits.Bully.aggression!.rate).toBeGreaterThan(traits.Hammer.aggression!.rate);
    expect(traits.Hammer.aggression!.rate).toBeGreaterThan(traits.Anchor.aggression!.rate);
  });

  it("show a behaviour under pressure once there are enough pressured decisions", () => {
    for (const n of PRESET_NAMES) expect(["holds firm", "backs down", "pushes back"]).toContain(traits[n].underPressure?.word);
  });

  it("say not enough hands yet until the minimum", () => {
    const one = traitsFrom(countMatch(playMatch(PRESETS.Anchor, PRESETS.Bully, { seed: 7, ...OXUDE_RULES }), "A"));
    expect(one.decisions).toBeLessThan(MIN_DECISIONS);
    expect(one).toMatchObject({ bluff: null, fold: null, aggression: null, underPressure: null, note: "not enough hands yet" });
  });

  it("add up: counting matches one at a time or all together gives the same traits", () => {
    const logs = [1, 2, 3, 4, 5].map((s) => playMatch(PRESETS.Mirage, PRESETS.Hammer, { seed: s, ...OXUDE_RULES }));
    const stepwise = logs.reduce((acc, l) => addCounts(acc, countMatch(l, "A")), EMPTY_COUNTS);
    const decisions = logs.reduce((n, l) => n + l.rounds.reduce((m, r) => m + r.sequence.filter((d) => d.seat === "A").length, 0), 0);
    expect(stepwise.decisions).toBe(decisions);
    expect(stepwise.folds + (stepwise.decisions - stepwise.folds)).toBe(decisions);
  });
});
