import { OXUDE_RULES } from "./round.js";
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
  /**
   * Turn-based only: when the opponent has already raised this round, fold if
   * myEdge is below this, otherwise call. "pot-odds": fold when calling the
   * raised bet is worth less than paying the ante. null: always call a raise.
   */
  foldToRaiseBelow: FoldThreshold | null;
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
 *   0. facing a raise this round (turn-based): fold below foldToRaiseBelow, else call
 *   1. bluff, if bluffUnderPressure                       -> raise
 *   2. opponent raised last round and edge below pressureFoldBelow -> fold
 *   3. bluff                                              -> raise
 *   4. edge below foldBelow                               -> fold
 *   5. edge >= raiseAtOrAbove                             -> raise
 *   6. otherwise                                          -> call
 * With bluffUnderPressure false and numeric thresholds this is the original order.
 */
export function makeStrategy(params: StrategyParams): Agent {
  const { foldBelow, raiseAtOrAbove, bluffAtOrBelow, bluffUnderPressure, pressureFoldBelow, foldToRaiseBelow } =
    params;
  return ({ myEdge, oppRaisedLastRound, oppActionThisRound, stakes }) => {
    if (oppActionThisRound === "raise") {
      const folds = foldToRaiseBelow !== null && isBelow(myEdge, foldToRaiseBelow, stakes.raisedBet, stakes.ante);
      return folds ? "fold" : "call";
    }
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

/**
 * Anchor calls down and raises only a strong edge; Hammer raises from even
 * money up; Mirage raises its worst edge and its best (the bluffer); Bully
 * raises almost everything and folds when raised at. All four fold to a raise
 * below 0.45 except Bully, which needs 0.55.
 *
 * Balanced for OXUDE_RULES (alternating turns, independent draw, ante 4).
 * Do not edit these without re-running the balance criteria: test/balance.test.ts
 * pins them and re-checks the loop, the spread and the probes at ante 3, 4 and 5.
 */
export const PRESET_PARAMS = {
  Anchor: { foldBelow: "pot-odds", raiseAtOrAbove: 0.55, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: "pot-odds", foldToRaiseBelow: 0.45 },
  Hammer: { foldBelow: "pot-odds", raiseAtOrAbove: 0.45, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: "pot-odds", foldToRaiseBelow: 0.45 },
  Mirage: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: 0.32, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.45 },
  Bully: { foldBelow: 0, raiseAtOrAbove: 0.35, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.55 },
} as const satisfies Record<string, StrategyParams>;

export type PresetName = keyof typeof PRESET_PARAMS;

export const PRESET_NAMES = Object.keys(PRESET_PARAMS) as PresetName[];

/** Re-exported for callers that reach for the rules through the presets. */
export { OXUDE_RULES };

/**
 * Fingerprint of the shipped numbers, recorded with every match as provenance.
 * A replay does not depend on it: matches replay from each agent's stored
 * table, so a retune changes this string without breaking old transcripts.
 */
export const PRESET_VERSION = `p${fnv1a(JSON.stringify(PRESET_PARAMS)).toString(16).padStart(8, "0")}`;

/** Small non-cryptographic hash, inline so the core stays dependency-free. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const PRESETS: Record<PresetName, Agent> = {
  Anchor: makeStrategy(PRESET_PARAMS.Anchor),
  Hammer: makeStrategy(PRESET_PARAMS.Hammer),
  Mirage: makeStrategy(PRESET_PARAMS.Mirage),
  Bully: makeStrategy(PRESET_PARAMS.Bully),
};
