import { describe, expect, it } from "vitest";
import { makeStrategy, PRESET_PARAMS, PRESETS, type Action, type PresetName, type View } from "../src/index.js";

function view(myEdge: number, oppRaisedLastRound = false, oppRaiseCount = oppRaisedLastRound ? 1 : 0): View {
  return { myEdge, oppRaisedLastRound, oppRaiseCount, myRoundsWon: 0, oppRoundsWon: 0, roundNumber: 2, myNet: 0 };
}

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
      Reckless: { foldBelow: 0.0, raiseAtOrAbove: 0.55, bluffAtOrBelow: null, foldIfOppRaisedLastRound: true },
      Steady: { foldBelow: 0.35, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, foldIfOppRaisedLastRound: true },
      Patient: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, foldIfOppRaisedLastRound: true },
      Tricky: { foldBelow: 0.45, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, foldIfOppRaisedLastRound: false },
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
    const agent = makeStrategy({ foldBelow: 0.5, raiseAtOrAbove: 0.9, bluffAtOrBelow: 0.4, foldIfOppRaisedLastRound: false });
    expect(agent(view(0.3))).toBe("raise");
  });

  it("rule order: when both fold-below and raise match, fold wins", () => {
    const agent = makeStrategy({ foldBelow: 0.8, raiseAtOrAbove: 0.5, bluffAtOrBelow: null, foldIfOppRaisedLastRound: false });
    expect(agent(view(0.7))).toBe("fold");
  });
});
