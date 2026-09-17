import type { Agent } from "./types.js";

/** A fold threshold: a fixed edge, or "pot-odds" to derive it from the stakes. */
export type FoldThreshold = number | "pot-odds";

export type StrategyParams = {
  /**
   * Fold when myEdge is below this. "pot-odds": fold when calling the base
   * bet is worth less than paying the ante.
   */
  foldBelow: FoldThreshold;
  /** Raise when myEdge >= raiseAtOrAbove (1 or more: never). */
  raiseAtOrAbove: number;
  /** Bluff-raise when myEdge <= bluffAtOrBelow; null disables bluffing. */
  bluffAtOrBelow: number | null;
  /** Bluff even when the opponent raised last round (the bluff is checked before the pressure fold). */
  bluffUnderPressure: boolean;
  /**
   * When the opponent raised last round, fold if myEdge is below this.
   * "pot-odds": fold when calling the raised bet is worth less than paying
   * the ante. null: ignore pressure.
   */
  pressureFoldBelow: FoldThreshold | null;
};

/**
 * True when calling `bet` at `edge` is worth less in expectation than folding
 * for the ante: (2e - 1) * bet < -ante. Computed in whole percent so a tie at
 * a 2dp edge is exact; ties call.
 */
export function callIsWorseThanFold(edge: number, bet: number, ante: number): boolean {
  const pct = Math.round(edge * 100);
  return (2 * pct - 100) * bet < -100 * ante;
}

function isBelow(edge: number, threshold: FoldThreshold, bet: number, ante: number): boolean {
  return threshold === "pot-odds" ? callIsWorseThanFold(edge, bet, ante) : edge < threshold;
}

/**
 * Shared factory for presets and custom strategies. Rule order:
 *   1. bluff, if bluffUnderPressure                       -> raise
 *   2. opponent raised last round and edge below pressureFoldBelow -> fold
 *   3. bluff                                              -> raise
 *   4. edge below foldBelow                               -> fold
 *   5. edge >= raiseAtOrAbove                             -> raise
 *   6. otherwise                                          -> call
 * With bluffUnderPressure false and numeric thresholds this is the original order.
 */
export function makeStrategy(params: StrategyParams): Agent {
  const { foldBelow, raiseAtOrAbove, bluffAtOrBelow, bluffUnderPressure, pressureFoldBelow } = params;
  return ({ myEdge, oppRaisedLastRound, stakes }) => {
    const bluff = bluffAtOrBelow !== null && myEdge <= bluffAtOrBelow;
    if (bluff && bluffUnderPressure) return "raise";
    if (
      oppRaisedLastRound &&
      pressureFoldBelow !== null &&
      isBelow(myEdge, pressureFoldBelow, stakes.raisedBet, stakes.ante)
    ) {
      return "fold";
    }
    if (bluff) return "raise";
    if (isBelow(myEdge, foldBelow, stakes.baseBet, stakes.ante)) return "fold";
    if (myEdge >= raiseAtOrAbove) return "raise";
    return "call";
  };
}

export const PRESET_PARAMS = {
  Reckless: { foldBelow: 0.0, raiseAtOrAbove: 0.55, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: 0.6 },
  Steady: { foldBelow: 0.35, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, bluffUnderPressure: false, pressureFoldBelow: 0.6 },
  Patient: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: 0.6 },
  Tricky: { foldBelow: 0.45, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, bluffUnderPressure: false, pressureFoldBelow: null },
} as const satisfies Record<string, StrategyParams>;

export type PresetName = keyof typeof PRESET_PARAMS;

export const PRESET_NAMES = Object.keys(PRESET_PARAMS) as PresetName[];

export const PRESETS: Record<PresetName, Agent> = {
  Reckless: makeStrategy(PRESET_PARAMS.Reckless),
  Steady: makeStrategy(PRESET_PARAMS.Steady),
  Patient: makeStrategy(PRESET_PARAMS.Patient),
  Tricky: makeStrategy(PRESET_PARAMS.Tricky),
};
