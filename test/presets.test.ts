import { describe, expect, it } from "vitest";
import { makeStrategy, PRESET_PARAMS, PRESETS, type Action, type PresetName, type View } from "../src/index.js";

function view(myEdge: number, oppRaiseCount = 0): View {
  return { myEdge, oppRaiseCount, myRoundsWon: 0, oppRoundsWon: 0, roundNumber: 1, myNet: 0 };
}

type Case = [edge: number, oppRaises: number, expected: Action, rule: string];

const CASES: Record<PresetName, Case[]> = {
  Reckless: [
    // foldAfterOppRaises 1, no bluff, foldBelow 0, raise >= 0.55
    [0.5, 1, "fold", "1: intimidated"],
    [0.3, 1, "fold", "1: intimidated (weakest)"],
    [0.6, 1, "raise", "1 skipped at edge 0.60 -> 4"],
    [0.3, 0, "call", "2 off, 3 never (foldBelow 0) -> 5"],
    [0.5, 0, "call", "5: call"],
    [0.6, 0, "raise", "4: raise"],
    [0.7, 0, "raise", "4: raise"],
  ],
  Steady: [
    // foldAfterOppRaises 1, bluff <= 0.32, foldBelow 0.35, raise >= 0.55
    [0.3, 1, "fold", "1 beats bluff"],
    [0.4, 1, "fold", "1: intimidated"],
    [0.6, 3, "raise", "1 skipped at 0.60 -> 4"],
    [0.3, 0, "raise", "2: bluff"],
    [0.34, 0, "fold", "3: fold (between bluff and foldBelow)"],
    [0.4, 0, "call", "5: call"],
    [0.5, 0, "call", "5: call"],
    [0.55, 0, "raise", "4: boundary is inclusive"],
    [0.7, 0, "raise", "4: raise"],
  ],
  Patient: [
    // foldAfterOppRaises 2, no bluff, foldBelow 0.35, raise >= 0.65
    [0.5, 1, "call", "1 needs 2 raises -> 5"],
    [0.5, 2, "fold", "1: intimidated"],
    [0.3, 0, "fold", "2 off -> 3: fold"],
    [0.35, 0, "call", "3: boundary is exclusive -> 5"],
    [0.6, 0, "call", "5: 0.60 is below raise threshold"],
    [0.6, 2, "call", "1 skipped at 0.60 -> 5"],
    [0.65, 0, "raise", "4: boundary is inclusive"],
    [0.7, 2, "raise", "4: raise"],
  ],
  Tricky: [
    // foldAfterOppRaises 99, bluff <= 0.32, foldBelow 0.45, raise >= 0.55
    [0.3, 50, "raise", "1 never fires -> 2: bluff"],
    [0.3, 99, "fold", "1 fires at exactly 99"],
    [0.32, 0, "raise", "2: bluff boundary is inclusive"],
    [0.4, 0, "fold", "3: fold"],
    [0.4, 10, "fold", "3: fold"],
    [0.5, 0, "call", "5: call"],
    [0.6, 0, "raise", "4: raise"],
    [0.7, 5, "raise", "4: raise"],
  ],
};

describe("presets", () => {
  for (const [name, cases] of Object.entries(CASES) as [PresetName, Case[]][]) {
    describe(name, () => {
      it.each(cases)("edge %s, opp raises %s -> %s (%s)", (edge, raises, expected) => {
        expect(PRESETS[name](view(edge, raises))).toBe(expected);
      });
    });
  }

  it("parameters are exactly as specified", () => {
    expect(PRESET_PARAMS).toEqual({
      Reckless: { foldBelow: 0.0, raiseAtOrAbove: 0.55, bluffAtOrBelow: null, foldAfterOppRaises: 1 },
      Steady: { foldBelow: 0.35, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, foldAfterOppRaises: 1 },
      Patient: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, foldAfterOppRaises: 2 },
      Tricky: { foldBelow: 0.45, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, foldAfterOppRaises: 99 },
    });
  });

  it("presets are built by the shared factory", () => {
    for (const name of Object.keys(PRESET_PARAMS) as PresetName[]) {
      const rebuilt = makeStrategy(PRESET_PARAMS[name]);
      for (const edge of [0.3, 0.4, 0.5, 0.6, 0.7]) {
        for (const raises of [0, 1, 2, 3, 99]) {
          expect(PRESETS[name](view(edge, raises))).toBe(rebuilt(view(edge, raises)));
        }
      }
    }
  });

  it("rule order: when both bluff and fold-below match, bluff wins", () => {
    const agent = makeStrategy({ foldBelow: 0.5, raiseAtOrAbove: 0.9, bluffAtOrBelow: 0.4, foldAfterOppRaises: 99 });
    expect(agent(view(0.3))).toBe("raise");
  });

  it("rule order: when both fold-below and raise match, fold wins", () => {
    const agent = makeStrategy({ foldBelow: 0.8, raiseAtOrAbove: 0.5, bluffAtOrBelow: null, foldAfterOppRaises: 99 });
    expect(agent(view(0.7))).toBe("fold");
  });
});
