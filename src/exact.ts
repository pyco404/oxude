import {
  advanceState,
  CLASSIC_STAKES,
  decideRound,
  EDGES,
  INITIAL_STATE,
  isMatchOver,
  resolveActions,
  type MatchState,
  type Stakes,
} from "./round.js";
import type { Agent } from "./types.js";

export type ExactOptions = {
  /** Defaults to CLASSIC_STAKES. */
  stakes?: Stakes;
};

/**
 * Exact expected net for seat A, enumerating every edge draw and flip
 * outcome with the same round logic the simulator uses. No sampling noise:
 * a tie is exactly 0 (up to float rounding).
 *
 * Agents must be deterministic functions of their view, which every
 * `makeStrategy` agent is.
 */
export function expectedNet(agentA: Agent, agentB: Agent, options: ExactOptions = {}): number {
  const stakes = options.stakes ?? CLASSIC_STAKES;
  const value = (state: MatchState): number => {
    if (isMatchOver(state)) return 0;
    let total = 0;
    for (const edgeA of EDGES) {
      const { actions } = decideRound(agentA, agentB, state, edgeA);
      const resolution = resolveActions(actions, stakes);
      let ev: number;
      if (resolution.outcome === "both-folded") {
        ev = value(advanceState(state, actions, null, 0));
      } else if (resolution.outcome === "one-folded") {
        const { winner, bet } = resolution;
        ev = (winner === "A" ? bet : -bet) + value(advanceState(state, actions, winner, bet));
      } else {
        const { bet } = resolution;
        const aWins = bet + value(advanceState(state, actions, "A", bet));
        const bWins = -bet + value(advanceState(state, actions, "B", bet));
        ev = edgeA * aWins + (1 - edgeA) * bWins;
      }
      total += ev;
    }
    return total / EDGES.length;
  };
  return value(INITIAL_STATE);
}

/** Exact expected net of `agent` against `opponent`, averaged over both seatings. */
export function seatAveragedNet(agent: Agent, opponent: Agent, options: ExactOptions = {}): number {
  return (expectedNet(agent, opponent, options) - expectedNet(opponent, agent, options)) / 2;
}
