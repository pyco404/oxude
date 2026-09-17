import { describe, expect, it } from "vitest";
import {
  callIsWorseThanFold,
  CLASSIC_STAKES,
  EDGES,
  makeStrategy,
  playMatch,
  PRESET_PARAMS,
  PRESETS,
  type Action,
  type PresetName,
  type Stakes,
  type StrategyParams,
  type View,
} from "../src/index.js";

function view(
  myEdge: number,
  oppRaisedLastRound = false,
  oppRaiseCount = oppRaisedLastRound ? 1 : 0,
  stakes: Stakes = CLASSIC_STAKES,
): View {
  return {
    myEdge,
    oppRaisedLastRound,
    oppRaiseCount,
    myRoundsWon: 0,
    oppRoundsWon: 0,
    roundNumber: 2,
    myNet: 0,
    stakes,
    oppActionThisRound: null,
    myActionThisRound: null,
  };
}

const BASE: StrategyParams = {
  foldBelow: 0,
  raiseAtOrAbove: 1,
  bluffAtOrBelow: null,
  bluffUnderPressure: false,
  pressureFoldBelow: null,
  foldToRaiseBelow: null,
};

type Case = [edge: number, oppRaisedLast: boolean, expected: Action, rule: string];

const CASES: Record<PresetName, Case[]> = {
  Reckless: [
    // pressure-fold on, no bluff, foldBelow 0, raise >= 0.55
    [0.5, true, "fold", "1: pressured"],
    [0.3, true, "fold", "1: pressured (weakest)"],
    [0.6, true, "raise", "1 skipped at edge 0.60 -> 4"],
    [0.3, false, "call", "2 off, 3 never (foldBelow 0) -> 5"],
    [0.5, false, "call", "5: call"],
    [0.6, false, "raise", "4: raise"],
    [0.7, false, "raise", "4: raise"],
  ],
  Steady: [
    // pressure-fold on, bluff <= 0.32, foldBelow 0.35, raise >= 0.55
    [0.3, true, "fold", "1 beats bluff"],
    [0.4, true, "fold", "1: pressured"],
    [0.6, true, "raise", "1 skipped at 0.60 -> 4"],
    [0.3, false, "raise", "2: bluff"],
    [0.34, false, "fold", "3: fold (between bluff and foldBelow)"],
    [0.4, false, "call", "5: call"],
    [0.5, false, "call", "5: call"],
    [0.55, false, "raise", "4: boundary is inclusive"],
    [0.7, false, "raise", "4: raise"],
  ],
  Patient: [
    // pressure-fold on, no bluff, foldBelow 0.35, raise >= 0.65
    [0.5, true, "fold", "1: pressured"],
    [0.3, false, "fold", "2 off -> 3: fold"],
    [0.35, false, "call", "3: boundary is exclusive -> 5"],
    [0.5, false, "call", "5: call"],
    [0.6, false, "call", "5: 0.60 is below raise threshold"],
    [0.6, true, "call", "1 skipped at 0.60 -> 5"],
    [0.65, false, "raise", "4: boundary is inclusive"],
    [0.7, true, "raise", "4: raise"],
  ],
  Tricky: [
    // pressure-fold off, bluff <= 0.32, foldBelow 0.45, raise >= 0.55
    [0.3, true, "raise", "1 off -> 2: bluff"],
    [0.32, false, "raise", "2: bluff boundary is inclusive"],
    [0.4, false, "fold", "3: fold"],
    [0.4, true, "fold", "1 off -> 3: fold"],
    [0.5, true, "call", "1 off -> 5: call"],
    [0.6, false, "raise", "4: raise"],
    [0.7, true, "raise", "4: raise"],
  ],
};

describe("presets", () => {
  for (const [name, cases] of Object.entries(CASES) as [PresetName, Case[]][]) {
    describe(name, () => {
      it.each(cases)("edge %s, opp raised last round %s -> %s (%s)", (edge, raised, expected) => {
        expect(PRESETS[name](view(edge, raised))).toBe(expected);
      });
    });
  }

  it("rule 1 ignores the cumulative raise count", () => {
    for (const name of Object.keys(PRESET_PARAMS) as PresetName[]) {
      for (const edge of [0.3, 0.4, 0.5]) {
        // Many earlier raises, but none last round: same as a clean history.
        expect(PRESETS[name](view(edge, false, 5))).toBe(PRESETS[name](view(edge, false, 0)));
      }
    }
  });

  it("parameters are exactly as specified", () => {
    expect(PRESET_PARAMS).toEqual({
      Reckless: { foldBelow: 0.0, raiseAtOrAbove: 0.55, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: 0.6, foldToRaiseBelow: null },
      Steady: { foldBelow: 0.35, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, bluffUnderPressure: false, pressureFoldBelow: 0.6, foldToRaiseBelow: null },
      Patient: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: 0.6, foldToRaiseBelow: null },
      Tricky: { foldBelow: 0.45, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: null },
    });
  });

  it("presets are built by the shared factory", () => {
    for (const name of Object.keys(PRESET_PARAMS) as PresetName[]) {
      const rebuilt = makeStrategy(PRESET_PARAMS[name]);
      for (const edge of [0.3, 0.4, 0.5, 0.6, 0.7]) {
        for (const raised of [false, true]) {
          expect(PRESETS[name](view(edge, raised))).toBe(rebuilt(view(edge, raised)));
        }
      }
    }
  });

  it("rule order: when both bluff and fold-below match, bluff wins", () => {
    const agent = makeStrategy({ ...BASE, foldBelow: 0.5, raiseAtOrAbove: 0.9, bluffAtOrBelow: 0.4 });
    expect(agent(view(0.3))).toBe("raise");
  });

  it("rule order: when both fold-below and raise match, fold wins", () => {
    const agent = makeStrategy({ ...BASE, foldBelow: 0.8, raiseAtOrAbove: 0.5 });
    expect(agent(view(0.7))).toBe("fold");
  });

  it("the pressure threshold is a parameter", () => {
    const agent = makeStrategy({ ...BASE, pressureFoldBelow: 0.45 });
    expect(EDGES.map((e) => agent(view(e, true)))).toEqual(["fold", "fold", "call", "call", "call"]);
    expect(EDGES.map((e) => agent(view(e, false)))).toEqual(["call", "call", "call", "call", "call"]);
  });

  it("bluffUnderPressure puts the bluff ahead of the pressure fold", () => {
    const params: StrategyParams = { ...BASE, bluffAtOrBelow: 0.32, pressureFoldBelow: 0.6 };
    expect(makeStrategy(params)(view(0.3, true))).toBe("fold");
    expect(makeStrategy({ ...params, bluffUnderPressure: true })(view(0.3, true))).toBe("raise");
    // Only the bluff edge moves; other pressured edges still fold.
    expect(makeStrategy({ ...params, bluffUnderPressure: true })(view(0.4, true))).toBe("fold");
  });
});

describe("pot odds", () => {
  it("callIsWorseThanFold compares (2e - 1) * bet with -ante, ties call", () => {
    expect(callIsWorseThanFold(0.3, 20, 10)).toBe(false); // -8 vs -10
    expect(callIsWorseThanFold(0.3, 20, 4)).toBe(true); // -8 vs -4
    expect(callIsWorseThanFold(0.4, 20, 4)).toBe(false); // -4 vs -4: tie calls
    expect(callIsWorseThanFold(0.3, 10, 4)).toBe(false); // -4 vs -4: tie calls
    expect(callIsWorseThanFold(0.3, 10, 3)).toBe(true); // -4 vs -3
    expect(callIsWorseThanFold(0.4, 20, 3)).toBe(true); // -4 vs -3
    expect(callIsWorseThanFold(0.5, 20, 0)).toBe(false);
  });

  it("pot-odds folds follow the stakes, not a fixed edge", () => {
    const agent = makeStrategy({ ...BASE, foldBelow: "pot-odds", pressureFoldBelow: "pot-odds" });
    const at = (ante: number, pressured: boolean) =>
      EDGES.map((e) => agent(view(e, pressured, 1, { ante, baseBet: 10, raisedBet: 20 })));
    // Classic ante 10: folding never beats calling.
    expect(at(10, false)).toEqual(["call", "call", "call", "call", "call"]);
    expect(at(10, true)).toEqual(["call", "call", "call", "call", "call"]);
    // Ante 3: base bet break-even is 0.35, raised is 0.425.
    expect(at(3, false)).toEqual(["fold", "call", "call", "call", "call"]);
    expect(at(3, true)).toEqual(["fold", "fold", "call", "call", "call"]);
    // Ante 5: base break-even 0.25, raised 0.375.
    expect(at(5, false)).toEqual(["call", "call", "call", "call", "call"]);
    expect(at(5, true)).toEqual(["fold", "call", "call", "call", "call"]);
  });

  it("pot-odds pressure fold is ignored when the opponent did not raise", () => {
    const agent = makeStrategy({ ...BASE, pressureFoldBelow: "pot-odds" });
    expect(agent(view(0.3, false, 0, { ante: 3, baseBet: 10, raisedBet: 20 }))).toBe("call");
    expect(agent(view(0.3, true, 1, { ante: 3, baseBet: 10, raisedBet: 20 }))).toBe("fold");
  });

  it("agents read the stakes the match was played with", () => {
    const stakes: Stakes = { ante: 3, baseBet: 10, raisedBet: 20 };
    const seen: Stakes[] = [];
    const spy = (v: View): Action => {
      seen.push(v.stakes);
      return "call";
    };
    playMatch(spy, spy, { seed: 1, stakes });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.ante === 3 && s.baseBet === 10 && s.raisedBet === 20)).toBe(true);
  });

  it("facing a raise this round, only foldToRaiseBelow applies", () => {
    const facing = (edge: number, params: Partial<StrategyParams>, ante = 4) =>
      makeStrategy({ ...BASE, raiseAtOrAbove: 0.25, bluffAtOrBelow: 0.32, bluffUnderPressure: true, ...params })({
        ...view(edge, true, 1, { ante, baseBet: 10, raisedBet: 20 }),
        oppActionThisRound: "raise",
      });
    // Never raises back and ignores bluff/pressure rules when facing a raise.
    expect(EDGES.map((e) => facing(e, {}))).toEqual(["call", "call", "call", "call", "call"]);
    expect(EDGES.map((e) => facing(e, { foldToRaiseBelow: 0.45 }))).toEqual(["fold", "fold", "call", "call", "call"]);
    // Pot odds at ante 4: calling 20 at 0.3 is worth -8 < -4; at 0.4 it ties and calls.
    expect(EDGES.map((e) => facing(e, { foldToRaiseBelow: "pot-odds" }))).toEqual(["fold", "call", "call", "call", "call"]);
    expect(EDGES.map((e) => facing(e, { foldToRaiseBelow: "pot-odds" }, 3))).toEqual(["fold", "fold", "call", "call", "call"]);
  });

  it("facing a call this round, the normal rules apply", () => {
    const agent = makeStrategy({ ...BASE, foldBelow: 0.35, raiseAtOrAbove: 0.65, foldToRaiseBelow: 0.99 });
    const v = (edge: number): View => ({ ...view(edge), oppActionThisRound: "call" });
    expect(EDGES.map((e) => agent(v(e)))).toEqual(["fold", "call", "call", "call", "raise"]);
  });
});
