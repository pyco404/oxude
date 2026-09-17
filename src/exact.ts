import {
  advanceState,
  CLASSIC_STAKES,
  decideRound,
  EDGES,
  freezeStakes,
  initialState,
  isMatchOver,
  resolveActions,
  type MatchState,
  type Stakes,
  type TurnOrder,
} from "./round.js";
import type { Agent, Seat } from "./types.js";

export type ExactOptions = {
  /** Defaults to CLASSIC_STAKES. */
  stakes?: Readonly<Stakes>;
  /** Defaults to "simultaneous". */
  turnOrder?: TurnOrder;
  /**
   * Alternating play only: fix who leads round 1 instead of the fair coin
   * the simulator uses. For measuring the value of position.
   */
  firstLeader?: Seat;
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
  const stakes = freezeStakes(options.stakes ?? CLASSIC_STAKES);
  const value = (state: MatchState): number => {
    if (isMatchOver(state)) return 0;
    let total = 0;
    for (const edgeA of EDGES) {
      const { actions } = decideRound(agentA, agentB, state, edgeA, stakes);
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
  if ((options.turnOrder ?? "simultaneous") === "simultaneous") return value(initialState(null));
  if (options.firstLeader) return value(initialState(options.firstLeader));
  return (value(initialState("A")) + value(initialState("B"))) / 2;
}

/** Exact expected net of `agent` against `opponent`, averaged over both seatings. */
export function seatAveragedNet(agent: Agent, opponent: Agent, options: ExactOptions = {}): number {
  return (expectedNet(agent, opponent, options) - expectedNet(opponent, agent, options)) / 2;
}
