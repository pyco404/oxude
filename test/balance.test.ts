import { describe, expect, it } from "vitest";
import {
  expectedNet,
  makeStrategy,
  OXUDE_RULES,
  PRESET_NAMES,
  PRESET_PARAMS,
  PRESETS,
  seatAveragedNet,
  type Agent,
  type PresetName,
  type Stakes,
  type StrategyParams,
} from "../src/index.js";

// These numbers took a long search to find and are only balanced for
// OXUDE_RULES. This file pins them and re-derives the balance criteria, so a
// parameter change fails here unless the criteria still hold with it.
//
// If you change a preset on purpose: run `npm run balance`, then update the
// snapshot below. If a criterion then fails, the change is not shippable.

const RULES = { turnOrder: OXUDE_RULES.turnOrder, deal: OXUDE_RULES.deal } as const;
const stakesAt = (ante: number): Stakes => ({ ...OXUDE_RULES.stakes, ante });
const at = (a: Agent, b: Agent, ante: number) => seatAveragedNet(a, b, { ...RULES, stakes: stakesAt(ante) });

/** The shipped parameters. Changing a preset means changing this snapshot too. */
const SNAPSHOT: Record<PresetName, StrategyParams> = {
  Anchor: { foldBelow: "pot-odds", raiseAtOrAbove: 0.55, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: "pot-odds", foldToRaiseBelow: 0.45 },
  Hammer: { foldBelow: "pot-odds", raiseAtOrAbove: 0.45, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: "pot-odds", foldToRaiseBelow: 0.45 },
  Mirage: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: 0.32, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.45 },
  Bully: { foldBelow: 0, raiseAtOrAbove: 0.35, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.55 },
};

/** Who must beat whom, over the whole ante range. */
const LOOP: [PresetName, PresetName][] = [
  ["Anchor", "Mirage"],
  ["Hammer", "Anchor"],
  ["Hammer", "Mirage"],
  ["Mirage", "Bully"],
  ["Bully", "Anchor"],
  ["Bully", "Hammer"],
];

const PROBES: [string, Agent][] = [
  ["AlwaysRaise", () => "raise"],
  ["AlwaysCall", () => "call"],
  ["AlwaysFold", () => "fold"],
  ["Fold0.3Call", makeStrategy({ foldBelow: 0.35, raiseAtOrAbove: 1, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.35 })],
  ["Fold<.5R.7", makeStrategy({ foldBelow: 0.45, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.45 })],
];

const ANTES = [3, 3.5, 4, 4.5, 5];
const SPREAD_LIMIT = 1.5;
const MAX_PROBE_BEATS = 2;
const vsField = (a: Agent, ante: number) => PRESET_NAMES.reduce((s, n) => s + at(a, PRESETS[n], ante), 0) / PRESET_NAMES.length;

describe("shipped presets", () => {
  it("parameters match the snapshot", () => {
    expect(PRESET_PARAMS).toEqual(SNAPSHOT);
    expect(PRESET_NAMES).toEqual(["Anchor", "Hammer", "Mirage", "Bully"]);
  });

  it("are balanced for the rules they claim", () => {
    expect(OXUDE_RULES).toEqual({ turnOrder: "alternating", deal: "independent", stakes: { ante: 4, baseBet: 10, raisedBet: 20 } });
  });

  it.each(ANTES)("the loop holds at ante %s", (ante) => {
    for (const [winner, loser] of LOOP) expect(at(PRESETS[winner], PRESETS[loser], ante)).toBeGreaterThan(0);
  });

  it.each(ANTES)("the spread stays under %s at ante %s", (ante) => {
    const avgs = PRESET_NAMES.map((n) => vsField(PRESETS[n], ante));
    expect(Math.max(...avgs) - Math.min(...avgs)).toBeLessThan(SPREAD_LIMIT);
  });

  it.each(ANTES)("no simple strategy beats the field at ante %s", (ante) => {
    for (const [name, probe] of PROBES) {
      const beaten = PRESET_NAMES.filter((n) => at(probe, PRESETS[n], ante) > 1e-9).length;
      expect(vsField(probe, ante), `${name} average at ante ${ante}`).toBeLessThanOrEqual(1e-9);
      expect(beaten, `${name} beats at ante ${ante}`).toBeLessThanOrEqual(MAX_PROBE_BEATS);
    }
  });

  it("AlwaysRaise never beats a preset, and loses to all four at the shipped ante", () => {
    // Folding to a raise in the same round is what takes its edge away.
    for (const ante of ANTES) {
      for (const n of PRESET_NAMES) expect(at(() => "raise", PRESETS[n], ante)).toBeLessThanOrEqual(1e-9);
    }
    for (const n of PRESET_NAMES) expect(at(() => "raise", PRESETS[n], OXUDE_RULES.stakes.ante)).toBeLessThan(0);
    // It only reaches a tie at the top of the range, against Bully at ante 5.
    expect(at(() => "raise", PRESETS.Bully, 5)).toBeCloseTo(0, 9);
  });

  it("exactly one preset bluffs, and bluffing pays for it", () => {
    const bluffers = PRESET_NAMES.filter((n) => PRESET_PARAMS[n].bluffAtOrBelow !== null);
    expect(bluffers).toEqual(["Mirage"]);
    const honest = makeStrategy({ ...PRESET_PARAMS.Mirage, bluffAtOrBelow: null });
    const field = (a: Agent) =>
      PRESET_NAMES.filter((n) => n !== "Mirage").reduce((s, n) => s + at(a, PRESETS[n], 4), 0) / 3;
    expect(field(PRESETS.Mirage) - field(honest)).toBeGreaterThan(0.2);
  });

  it("position is worth nothing over a match, and little per round", () => {
    for (const n of PRESET_NAMES) {
      const opts = { ...RULES, stakes: OXUDE_RULES.stakes } as const;
      // The round-1 leader coin cancels position exactly.
      expect(expectedNet(PRESETS[n], PRESETS[n], opts)).toBeCloseTo(0, 12);
      // With a fixed first leader it stays small.
      expect(Math.abs(expectedNet(PRESETS[n], PRESETS[n], { ...opts, firstLeader: "A" }))).toBeLessThan(0.25);
    }
  });
});
