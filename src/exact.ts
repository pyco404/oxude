import {
  advanceState,
  decideRound,
  dealOutcomes,
  winProbabilityA,
  freezeStakes,
  initialState,
  isMatchOver,
  OXUDE_RULES,
  resolveActions,
  type MatchState,
  type Deal,
  type Stakes,
  type TurnOrder,
} from "./round.js";
import type { Agent, Seat } from "./types.js";

export type ExactOptions = {
  /** Defaults to OXUDE_RULES.stakes. */
  stakes?: Readonly<Stakes>;
  /** Defaults to OXUDE_RULES.turnOrder. */
  turnOrder?: TurnOrder;
  /** Defaults to OXUDE_RULES.deal. */
  deal?: Deal;
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
  const stakes = freezeStakes(options.stakes ?? OXUDE_RULES.stakes);
  const deal = options.deal ?? OXUDE_RULES.deal;
  const outcomes = dealOutcomes(deal);
  // Agents are pure functions of their view, and a view depends only on the
  // state and this round's draw, so each distinct state is evaluated once.
  const memo = new Map<string, number>();
  const value = (state: MatchState): number => {
    if (isMatchOver(state)) return 0;
    const key = stateKey(state);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let total = 0;
    for (const outcome of outcomes) {
      const edges = { A: outcome.A, B: outcome.B };
      const { actions } = decideRound(agentA, agentB, state, edges, stakes);
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
        const pWin = winProbabilityA(edges, deal);
        ev = pWin * aWins + (1 - pWin) * bWins;
      }
      total += outcome.p * ev;
    }
    memo.set(key, total);
    return total;
  };
  if ((options.turnOrder ?? OXUDE_RULES.turnOrder) === "simultaneous") return value(initialState(null));
  if (options.firstLeader) return value(initialState(options.firstLeader));
  return (value(initialState("A")) + value(initialState("B"))) / 2;
}

function stateKey(s: MatchState): string {
  return [
    s.roundNumber,
    s.nets.A,
    s.nets.B,
    s.roundsWon.A,
    s.roundsWon.B,
    s.raiseCounts.A,
    s.raiseCounts.B,
    +s.raisedLastRound.A,
    +s.raisedLastRound.B,
    s.nextLeader ?? "-",
  ].join(",");
}

/** Exact expected net of `agent` against `opponent`, averaged over both seatings. */
export function seatAveragedNet(agent: Agent, opponent: Agent, options: ExactOptions = {}): number {
  return (expectedNet(agent, opponent, options) - expectedNet(opponent, agent, options)) / 2;
}
