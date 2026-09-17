import { describe, expect, it } from "vitest";
import {
  callIsWorseThanFold,
  EDGES,
  makeStrategy,
  OXUDE_RULES,
  playMatch,
  PRESET_NAMES,
  PRESET_PARAMS,
  PRESETS,
  type Action,
  type PresetName,
  type Stakes,
  type StrategyParams,
  type View,
} from "../src/index.js";

const SHIPPED: Stakes = OXUDE_RULES.stakes;

function view(
  myEdge: number,
  opts: { pressured?: boolean; facing?: Action | null; stakes?: Stakes } = {},
): View {
  const { pressured = false, facing = null, stakes = SHIPPED } = opts;
  return {
    myEdge,
    oppRaisedLastRound: pressured,
    oppRaiseCount: pressured ? 1 : 0,
    myRoundsWon: 0,
    oppRoundsWon: 0,
    roundNumber: 2,
    myNet: 0,
    stakes,
    oppActionThisRound: facing,
    myActionThisRound: facing === "raise" ? "call" : null,
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

const short = (a: Action) => a[0];
/** Actions for edges 0.3..0.7 in one situation. */
const rowFor = (name: PresetName, opts: Parameters<typeof view>[1]) =>
  EDGES.map((e) => short(PRESETS[name](view(e, opts)))).join("");

/** The shipped behaviour: acting first / after an opponent raise last round / facing a raise. */
const EXPECTED: Record<PresetName, [first: string, pressured: string, facingRaise: string]> = {
  Anchor: ["cccrr", "fccrr", "ffccc"],
  Hammer: ["ccrrr", "fcrrr", "ffccc"],
  Mirage: ["rcccr", "rcccr", "ffccc"],
  Bully: ["crrrr", "crrrr", "fffcc"],
};

describe("presets", () => {
  it.each(PRESET_NAMES)("%s behaves as shipped at the balanced stakes", (name) => {
    const [first, pressured, facingRaise] = EXPECTED[name];
    expect(rowFor(name, {})).toBe(first);
    expect(rowFor(name, { pressured: true })).toBe(pressured);
    expect(rowFor(name, { facing: "raise" })).toBe(facingRaise);
    // Facing a call is the same decision as acting first.
    expect(rowFor(name, { facing: "call" })).toBe(first);
  });

  it("Mirage is the bluffer: it raises its worst edge and its best, and calls between", () => {
    expect(EXPECTED.Mirage[0]).toBe("rcccr");
    expect(PRESET_PARAMS.Mirage.bluffAtOrBelow).toBe(0.32);
    // Nobody else raises an edge below 0.5 while declining a stronger one.
    for (const name of PRESET_NAMES) {
      if (name === "Mirage") continue;
      const row = EXPECTED[name][0];
      const polarised = [...row].some((a, i) => a === "r" && [...row].slice(i + 1).some((b) => b !== "r"));
      expect(polarised).toBe(false);
    }
  });

  it("Bully raises almost everything and backs down when raised at", () => {
    expect(EXPECTED.Bully[0]).toBe("crrrr");
    expect(EXPECTED.Bully[2]).toBe("fffcc");
  });

  it("pot-odds presets follow the stakes rather than a fixed edge", () => {
    // Anchor's folds are priced: at ante 3 the worst edge is no longer worth a call.
    expect(rowFor("Anchor", { stakes: { ...SHIPPED, ante: 3 } })).toBe("fccrr");
    expect(rowFor("Anchor", { stakes: { ...SHIPPED, ante: 4 } })).toBe("cccrr");
    expect(rowFor("Anchor", { pressured: true, stakes: { ...SHIPPED, ante: 3 } })).toBe("ffcrr");
    // At the classic ante of 10 folding never beats calling, so it never folds.
    expect(rowFor("Anchor", { stakes: { ante: 10, baseBet: 10, raisedBet: 20 } })).toBe("cccrr");
    expect(rowFor("Anchor", { pressured: true, stakes: { ante: 10, baseBet: 10, raisedBet: 20 } })).toBe("cccrr");
  });

  it("presets are built by the shared factory", () => {
    for (const name of PRESET_NAMES) {
      const rebuilt = makeStrategy(PRESET_PARAMS[name]);
      for (const e of EDGES) {
        for (const pressured of [false, true]) {
          for (const facing of [null, "call", "raise"] as const) {
            expect(PRESETS[name](view(e, { pressured, facing }))).toBe(rebuilt(view(e, { pressured, facing })));
          }
        }
      }
    }
  });
});

describe("strategy rules", () => {
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
    expect(EDGES.map((e) => agent(view(e, { pressured: true })))).toEqual(["fold", "fold", "call", "call", "call"]);
    expect(EDGES.map((e) => agent(view(e)))).toEqual(["call", "call", "call", "call", "call"]);
  });

  it("bluffUnderPressure puts the bluff ahead of the pressure fold", () => {
    const params: StrategyParams = { ...BASE, bluffAtOrBelow: 0.32, pressureFoldBelow: 0.6 };
    expect(makeStrategy(params)(view(0.3, { pressured: true }))).toBe("fold");
    expect(makeStrategy({ ...params, bluffUnderPressure: true })(view(0.3, { pressured: true }))).toBe("raise");
    expect(makeStrategy({ ...params, bluffUnderPressure: true })(view(0.4, { pressured: true }))).toBe("fold");
  });

  it("facing a raise, only foldToRaiseBelow applies", () => {
    const facing = (edge: number, params: Partial<StrategyParams>, ante = 4) =>
      makeStrategy({ ...BASE, raiseAtOrAbove: 0.25, bluffAtOrBelow: 0.32, bluffUnderPressure: true, ...params })(
        view(edge, { pressured: true, facing: "raise", stakes: { ante, baseBet: 10, raisedBet: 20 } }),
      );
    expect(EDGES.map((e) => facing(e, {}))).toEqual(["call", "call", "call", "call", "call"]);
    expect(EDGES.map((e) => facing(e, { foldToRaiseBelow: 0.45 }))).toEqual(["fold", "fold", "call", "call", "call"]);
    expect(EDGES.map((e) => facing(e, { foldToRaiseBelow: "pot-odds" }))).toEqual(["fold", "call", "call", "call", "call"]);
    expect(EDGES.map((e) => facing(e, { foldToRaiseBelow: "pot-odds" }, 3))).toEqual(["fold", "fold", "call", "call", "call"]);
  });
});

describe("pot odds", () => {
  it("callIsWorseThanFold compares (2e - 1) * bet with -ante, ties call", () => {
    expect(callIsWorseThanFold(0.3, 20, 10)).toBe(false);
    expect(callIsWorseThanFold(0.3, 20, 4)).toBe(true);
    expect(callIsWorseThanFold(0.4, 20, 4)).toBe(false);
    expect(callIsWorseThanFold(0.3, 10, 4)).toBe(false);
    expect(callIsWorseThanFold(0.3, 10, 3)).toBe(true);
    expect(callIsWorseThanFold(0.5, 20, 0)).toBe(false);
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
});
