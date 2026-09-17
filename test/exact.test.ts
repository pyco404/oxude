import { describe, expect, it } from "vitest";
import {
  CLASSIC_RULES as CLASSIC,
  CLASSIC_STAKES,
  expectedNet,
  makeStrategy,
  mulberry32,
  nextUint32,
  playMatch,
  PRESET_NAMES,
  PRESETS,
  seatAveragedNet,
  type Agent,
  type Stakes,
} from "../src/index.js";
import { constantAgent } from "./helpers.js";

const call = constantAgent("call");
const raise = constantAgent("raise");
const fold = constantAgent("fold");

describe("exact calculator", () => {
  it("matches closed-form values", () => {
    // Symmetric flips are worth nothing, whatever the bet.
    expect(expectedNet(call, call, CLASSIC)).toBeCloseTo(0, 12);
    expect(expectedNet(raise, call, CLASSIC)).toBeCloseTo(0, 12);
    // A lone folder loses the ante twice, then the match is over.
    expect(expectedNet(fold, call, CLASSIC)).toBeCloseTo(-2 * CLASSIC_STAKES.ante, 12);
    expect(expectedNet(raise, fold, { ...CLASSIC, stakes: { ante: 3, baseBet: 10, raisedBet: 20 } })).toBeCloseTo(6, 12);
    // Nobody ever wins a round: three rounds, no money.
    expect(expectedNet(fold, fold, CLASSIC)).toBe(0);
  });

  it("gives zero for an agent against itself", () => {
    for (const name of PRESET_NAMES) {
      expect(expectedNet(PRESETS[name], PRESETS[name], CLASSIC)).toBeCloseTo(0, 12);
      expect(seatAveragedNet(PRESETS[name], PRESETS[name], CLASSIC)).toBeCloseTo(0, 12);
    }
  });

  it("is antisymmetric when seat-averaged", () => {
    for (const a of PRESET_NAMES) {
      for (const b of PRESET_NAMES) {
        expect(seatAveragedNet(PRESETS[a], PRESETS[b], CLASSIC)).toBeCloseTo(-seatAveragedNet(PRESETS[b], PRESETS[a], CLASSIC), 12);
      }
    }
  });

  it("agrees with simulation within sampling error", () => {
    const stakesList: Stakes[] = [CLASSIC_STAKES, { ante: 5, baseBet: 10, raisedBet: 25 }];
    const agents: Agent[] = [...PRESET_NAMES.map((n) => PRESETS[n]), raise];
    const master = mulberry32(31337);
    const N = 20_000;
    for (const stakes of stakesList) {
      for (const [i, a] of agents.entries()) {
        const b = agents[(i + 1) % agents.length]!;
        let sum = 0;
        let sq = 0;
        for (let k = 0; k < N; k++) {
          const net = playMatch(a, b, { ...CLASSIC, seed: nextUint32(master), stakes }).nets.A;
          sum += net;
          sq += net * net;
        }
        const mean = sum / N;
        const se = Math.sqrt((sq / N - mean * mean) / N);
        expect(Math.abs(mean - expectedNet(a, b, { ...CLASSIC, stakes }))).toBeLessThan(4 * se);
      }
    }
  });

  it("AlwaysRaise never loses in expectation under classic rules", () => {
    // Under simultaneous play with the classic ante nobody can answer a raise,
    // so raising is free: it ties anyone who never folds and beats anyone who does.
    const folder = makeStrategy({
      foldBelow: 0.35,
      raiseAtOrAbove: 0.55,
      bluffAtOrBelow: null,
      bluffUnderPressure: false,
      pressureFoldBelow: 0.6,
      foldToRaiseBelow: null,
    });
    expect(seatAveragedNet(raise, folder, CLASSIC)).toBeGreaterThan(0);
    expect(seatAveragedNet(raise, call, CLASSIC)).toBeCloseTo(0, 12);
    for (const name of PRESET_NAMES) expect(seatAveragedNet(raise, PRESETS[name], CLASSIC)).toBeGreaterThanOrEqual(-1e-12);
  });

  it("scales with stakes", () => {
    const doubled: Stakes = { ante: 20, baseBet: 20, raisedBet: 40 };
    for (const a of PRESET_NAMES) {
      for (const b of PRESET_NAMES) {
        expect(expectedNet(PRESETS[a], PRESETS[b], { ...CLASSIC, stakes: doubled })).toBeCloseTo(
          2 * expectedNet(PRESETS[a], PRESETS[b], CLASSIC),
          10,
        );
      }
    }
  });
});

describe("stakes in the simulator", () => {
  const stakes: Stakes = { ante: 4, baseBet: 10, raisedBet: 15 };

  it("defaults to classic stakes and records the stakes in the log", () => {
    expect(playMatch(call, call, { ...CLASSIC, seed: 1 }).stakes).toEqual(CLASSIC.stakes);
    expect(playMatch(call, call, { ...CLASSIC, seed: 1, stakes }).stakes).toEqual(stakes);
  });

  it("a lone fold moves the ante", () => {
    const log = playMatch(fold, raise, { ...CLASSIC, seed: 2, stakes });
    expect(log.rounds.map((r) => r.bet)).toEqual([4, 4]);
    expect(log.nets).toEqual({ A: -8, B: 8 });
  });

  it("flips use the base or raised bet", () => {
    expect(playMatch(call, call, { ...CLASSIC, seed: 3, stakes }).rounds.every((r) => r.bet === 10)).toBe(true);
    expect(playMatch(call, raise, { ...CLASSIC, seed: 3, stakes }).rounds.every((r) => r.bet === 15)).toBe(true);
  });

  it("does not alias the caller's stakes object", () => {
    const mine = { ...stakes };
    const log = playMatch(call, call, { ...CLASSIC, seed: 1, stakes: mine });
    mine.ante = 99;
    expect(log.stakes.ante).toBe(4);
  });
});
