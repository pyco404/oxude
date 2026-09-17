import { describe, expect, it } from "vitest";
import {
  dealOutcomes,
  decideRound,
  expectedNet,
  freezeStakes,
  initialState,
  isMatchOver,
  makeStrategy,
  resolveActions,
  advanceState,
  type Agent,
  type Deal,
  type MatchState,
  type Stakes,
} from "../src/index.js";

// Regression guard for the finding that turned this game into one where
// bluffing exists: a bluff can only work if the opponent cannot infer your
// edge. Under the complementary deal B's edge is 1 - A's, so a weak raiser
// always faces a strong opponent and no bluff is ever folded to. Under the
// independent deal it can be. If the deal, the turn order or the fold rules
// change so that bluffs stop being folded to, these tests fail loudly.

const STAKES: Stakes = { ante: 4, baseBet: 10, raisedBet: 20 };

/** Raises its worst edge and its best, calls in between: a polarised bluffer. */
const BLUFFER: Agent = makeStrategy({
  foldBelow: 0.35,
  raiseAtOrAbove: 0.65,
  bluffAtOrBelow: 0.32,
  bluffUnderPressure: false,
  pressureFoldBelow: null,
  foldToRaiseBelow: 0.45,
});
/** Folds to a raise when calling is not worth the price. */
const RESPONDER: Agent = makeStrategy({
  foldBelow: "pot-odds",
  raiseAtOrAbove: 0.55,
  bluffAtOrBelow: null,
  bluffUnderPressure: false,
  pressureFoldBelow: "pot-odds",
  foldToRaiseBelow: 0.45,
});

type BluffStats = { bluffs: number; folded: number; foldedWhileAhead: number; wonPerFold: number };

/** Exact, probability-weighted bluff outcomes for `bluffer` (seat A) against `opponent`. */
function bluffStats(
  bluffer: Agent,
  opponent: Agent,
  deal: Deal,
  turnOrder: "alternating" | "simultaneous" = "alternating",
): BluffStats {
  const stakes = freezeStakes(STAKES);
  const out: BluffStats = { bluffs: 0, folded: 0, foldedWhileAhead: 0, wonPerFold: 0 };
  const walk = (state: MatchState, prob: number) => {
    if (isMatchOver(state)) return;
    for (const draw of dealOutcomes(deal)) {
      const p = prob * draw.p;
      const edges = { A: draw.A, B: draw.B };
      const { actions, sequence } = decideRound(bluffer, opponent, state, edges, stakes);
      const res = resolveActions(actions, stakes);
      // A bluff: A raises with an edge below 0.5, not as an answer to a raise.
      const raised = sequence.findIndex((x, i) => x.seat === "A" && x.action === "raise" && sequence[i - 1]?.action !== "raise");
      const isBluff = raised >= 0 && edges.A < 0.5;
      if (isBluff) {
        out.bluffs += p;
        if (res.outcome === "one-folded" && res.winner === "A") {
          out.folded += p;
          out.wonPerFold += p * res.bet;
          if (edges.B > edges.A) out.foldedWhileAhead += p;
        }
      }
      if (res.outcome === "both-folded") walk(advanceState(state, actions, null, 0), p);
      else if (res.outcome === "one-folded") walk(advanceState(state, actions, res.winner, res.bet), p);
      else {
        walk(advanceState(state, actions, "A", res.bet), p);
        walk(advanceState(state, actions, "B", res.bet), p);
      }
    }
  };
  if (turnOrder === "simultaneous") walk(initialState(null), 1);
  else for (const leader of ["A", "B"] as const) walk(initialState(leader), 0.5);
  return out;
}

describe("bluffing depends on hidden information", () => {
  it("independent deal: bluffs are folded to, including by the stronger hand", () => {
    const s = bluffStats(BLUFFER, RESPONDER, "independent");
    expect(s.bluffs).toBeGreaterThan(0);
    expect(s.folded / s.bluffs).toBeGreaterThan(0.1);
    // Some of those folds come from an opponent who would have won the flip.
    expect(s.foldedWhileAhead).toBeGreaterThan(0);
    // A fold pays the bluffer the ante.
    expect(s.wonPerFold / s.folded).toBeCloseTo(STAKES.ante, 9);
  });

  it("complementary deal: no bluff is ever folded to by a stronger hand", () => {
    const s = bluffStats(BLUFFER, RESPONDER, "complementary");
    expect(s.bluffs).toBeGreaterThan(0);
    // B's edge is 1 - A's, so a bluffer at 0.3 always faces 0.7, which never folds here.
    expect(s.foldedWhileAhead).toBe(0);
  });

  it("bluffing pays under the independent deal and not under the complementary one", () => {
    const honest: Agent = makeStrategy({
      foldBelow: 0.35,
      raiseAtOrAbove: 0.65,
      bluffAtOrBelow: null,
      bluffUnderPressure: false,
      pressureFoldBelow: null,
      foldToRaiseBelow: 0.45,
    });
    const value = (deal: Deal, agent: Agent) =>
      expectedNet(agent, RESPONDER, { stakes: STAKES, turnOrder: "alternating", deal });
    expect(value("independent", BLUFFER) - value("independent", honest)).toBeGreaterThan(0);
    expect(value("complementary", BLUFFER) - value("complementary", honest)).toBeLessThan(0);
  });

  it("simultaneous play kills the fold-to-a-bluff even with hidden information", () => {
    // Nobody can answer a raise in the same round, so a raise cannot make a
    // stronger hand fold: any fold is the folder acting on its own weak edge.
    const s = bluffStats(BLUFFER, RESPONDER, "independent", "simultaneous");
    expect(s.bluffs).toBeGreaterThan(0);
    expect(s.foldedWhileAhead).toBe(0);
  });
});
