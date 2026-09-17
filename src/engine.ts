import { mulberry32 } from "./rng.js";
import {
  advanceState,
  decideRound,
  EDGES,
  freezeStakes,
  initialState,
  OXUDE_RULES,
  isMatchOver,
  matchWinner,
  resolveActions,
  winProbabilityA,
  complementEdge,
  type Deal,
  type Stakes,
  type TurnOrder,
} from "./round.js";
import type { Agent, MatchLog, RoundLog, Seat } from "./types.js";

export type MatchOptions = {
  seed: number;
  names?: { A: string; B: string };
  /** Defaults to OXUDE_RULES.stakes (ante 4, base 10, raised 20). */
  stakes?: Readonly<Stakes>;
  /** Defaults to OXUDE_RULES.turnOrder ("alternating"). */
  turnOrder?: TurnOrder;
  /** Defaults to OXUDE_RULES.deal ("independent"). */
  deal?: Deal;
};

function drawEdge(rng: () => number): number {
  const index = Math.floor(rng() * EDGES.length);
  const edge = EDGES[index];
  if (edge === undefined) throw new Error(`edge index out of range: ${index}`);
  return edge;
}

export function playMatch(agentA: Agent, agentB: Agent, options: MatchOptions): MatchLog {
  const { seed } = options;
  const stakes = freezeStakes(options.stakes ?? OXUDE_RULES.stakes);
  const turnOrder = options.turnOrder ?? OXUDE_RULES.turnOrder;
  const deal = options.deal ?? OXUDE_RULES.deal;
  const rng = mulberry32(seed);
  // Alternating play draws the round-1 leader first; simultaneous play draws nothing extra.
  const firstLeader: Seat | null = turnOrder === "alternating" ? (rng() < 0.5 ? "A" : "B") : null;
  const rounds: RoundLog[] = [];
  let state = initialState(firstLeader);

  while (!isMatchOver(state)) {
    // RNG draw order is fixed: A's edge, then B's (independent deal only), then (only if needed) the flip.
    const edgeA = drawEdge(rng);
    const edgeB = deal === "independent" ? drawEdge(rng) : complementEdge(edgeA);
    const edges = { A: edgeA, B: edgeB };
    const pWin = winProbabilityA(edges, deal);

    const leader = state.nextLeader;
    const { actions, sequence } = decideRound(agentA, agentB, state, edges, stakes);
    const resolution = resolveActions(actions, stakes);

    let winner: Seat | null = null;
    let bet = 0;
    let flip: RoundLog["flip"] = null;
    if (resolution.outcome === "one-folded") {
      ({ winner, bet } = resolution);
    } else if (resolution.outcome === "flipped") {
      const roll = rng();
      winner = roll < pWin ? "A" : "B";
      bet = resolution.bet;
      flip = { probabilityAWins: pWin, roll, winner };
    }

    const roundNumber = state.roundNumber;
    state = advanceState(state, actions, winner, bet);
    rounds.push({
      roundNumber,
      leader,
      sequence,
      edges,
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
    deal,
    firstLeader,
    names: options.names ?? { A: "A", B: "B" },
    rounds,
    roundsWon: { ...state.roundsWon },
    nets: { ...state.nets },
    winner,
    endReason: winner !== null ? "round-wins" : "max-rounds",
  };
}
