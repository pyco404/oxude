import type { Agent } from "./types.js";

/** Rule 1 only applies when the agent's own edge is below this. */
export const INTIMIDATION_EDGE = 0.6;

export type StrategyParams = {
  /** Fold when myEdge < foldBelow. */
  foldBelow: number;
  /** Raise when myEdge >= raiseAtOrAbove. */
  raiseAtOrAbove: number;
  /** Bluff-raise when myEdge <= bluffAtOrBelow; null disables bluffing. */
  bluffAtOrBelow: number | null;
  /** Fold (with a weak edge) once the opponent has raised this many times. */
  foldAfterOppRaises: number;
};

/** Shared factory for presets and, later, custom player strategies. The rule order matters. */
export function makeStrategy(params: StrategyParams): Agent {
  const { foldBelow, raiseAtOrAbove, bluffAtOrBelow, foldAfterOppRaises } = params;
  return (view) => {
    if (view.oppRaiseCount >= foldAfterOppRaises && view.myEdge < INTIMIDATION_EDGE) return "fold";
    if (bluffAtOrBelow !== null && view.myEdge <= bluffAtOrBelow) return "raise";
    if (view.myEdge < foldBelow) return "fold";
    if (view.myEdge >= raiseAtOrAbove) return "raise";
    return "call";
  };
}

export const PRESET_PARAMS = {
  Reckless: { foldBelow: 0.0, raiseAtOrAbove: 0.55, bluffAtOrBelow: null, foldAfterOppRaises: 1 },
  Steady: { foldBelow: 0.35, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, foldAfterOppRaises: 1 },
  Patient: { foldBelow: 0.35, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, foldAfterOppRaises: 2 },
  Tricky: { foldBelow: 0.45, raiseAtOrAbove: 0.55, bluffAtOrBelow: 0.32, foldAfterOppRaises: 99 },
} as const satisfies Record<string, StrategyParams>;

export type PresetName = keyof typeof PRESET_PARAMS;

export const PRESET_NAMES = Object.keys(PRESET_PARAMS) as PresetName[];

export const PRESETS: Record<PresetName, Agent> = {
  Reckless: makeStrategy(PRESET_PARAMS.Reckless),
  Steady: makeStrategy(PRESET_PARAMS.Steady),
  Patient: makeStrategy(PRESET_PARAMS.Patient),
  Tricky: makeStrategy(PRESET_PARAMS.Tricky),
};
