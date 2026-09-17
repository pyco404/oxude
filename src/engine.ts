import { mulberry32 } from "./rng.js";
import {
  advanceState,
  CLASSIC_STAKES,
  decideRound,
  EDGES,
  freezeStakes,
  initialState,
  isMatchOver,
  matchWinner,
  resolveActions,
  type Stakes,
  type TurnOrder,
} from "./round.js";
import type { Agent, MatchLog, RoundLog, Seat } from "./types.js";

export type MatchOptions = {
  seed: number;
  names?: { A: string; B: string };
  /** Defaults to CLASSIC_STAKES (ante 10, base 10, raised 20). */
  stakes?: Readonly<Stakes>;
  /** Defaults to "simultaneous". */
  turnOrder?: TurnOrder;
};

export function playMatch(agentA: Agent, agentB: Agent, options: MatchOptions): MatchLog {
  const { seed } = options;
  const stakes = freezeStakes(options.stakes ?? CLASSIC_STAKES);
  const turnOrder = options.turnOrder ?? "simultaneous";
  const rng = mulberry32(seed);
  // Alternating play draws the round-1 leader first; simultaneous play draws nothing extra.
  const firstLeader: Seat | null = turnOrder === "alternating" ? (rng() < 0.5 ? "A" : "B") : null;
  const rounds: RoundLog[] = [];
  let state = initialState(firstLeader);

  while (!isMatchOver(state)) {
    // RNG draw order is fixed: edge first, then (only if needed) the flip.
    const edgeIndex = Math.floor(rng() * EDGES.length);
    const edgeA = EDGES[edgeIndex];
    if (edgeA === undefined) throw new Error(`edge index out of range: ${edgeIndex}`);

    const leader = state.nextLeader;
    const { edgeB, actions, sequence } = decideRound(agentA, agentB, state, edgeA, stakes);
    const resolution = resolveActions(actions, stakes);

    let winner: Seat | null = null;
    let bet = 0;
    let flip: RoundLog["flip"] = null;
    if (resolution.outcome === "one-folded") {
      ({ winner, bet } = resolution);
    } else if (resolution.outcome === "flipped") {
      const roll = rng();
      winner = roll < edgeA ? "A" : "B";
      bet = resolution.bet;
      flip = { probabilityAWins: edgeA, roll, winner };
    }

    const roundNumber = state.roundNumber;
    state = advanceState(state, actions, winner, bet);
    rounds.push({
      roundNumber,
      leader,
      sequence,
      edges: { A: edgeA, B: edgeB },
      actions,
      outcome: resolution.outcome,
      bet,
      flip,
      winner,
      nets: { ...state.nets },
      roundsWon: { ...state.roundsWon },
      raiseCounts: { ...state.raiseCounts },
    });
  }

  const winner = matchWinner(state);
  return {
    seed,
    stakes: { ...stakes },
    turnOrder,
    firstLeader,
    names: options.names ?? { A: "A", B: "B" },
    rounds,
    roundsWon: { ...state.roundsWon },
    nets: { ...state.nets },
    winner,
    endReason: winner !== null ? "round-wins" : "max-rounds",
  };
}
