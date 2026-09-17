import { mulberry32 } from "./rng.js";
import type { Action, Agent, MatchLog, RoundLog, Seat, View } from "./types.js";

export const EDGES = [0.3, 0.4, 0.5, 0.6, 0.7] as const;
export const ANTE = 10;
export const BASE_BET = 10;
export const RAISED_BET = 20;
export const MAX_ROUNDS = 3;
export const ROUNDS_TO_WIN = 2;

/**
 * Identity at runtime; at compile time rejects any object carrying keys
 * beyond `View`, even when built by spreading. This is what stops an
 * opponent edge from ever being smuggled into a view.
 */
export function exactView<T extends View>(
  view: T & Record<Exclude<keyof T, keyof View>, never>,
): View {
  return view;
}

/** Complement rounded to 2dp, so B's edge is the same double as the literal (1 - 0.7 !== 0.3). */
function complementEdge(edge: number): number {
  return Math.round((1 - edge) * 100) / 100;
}

export type MatchOptions = {
  seed: number;
  names?: { A: string; B: string };
};

export function playMatch(agentA: Agent, agentB: Agent, options: MatchOptions): MatchLog {
  const { seed } = options;
  const rng = mulberry32(seed);

  const nets = { A: 0, B: 0 };
  const roundsWon = { A: 0, B: 0 };
  const raiseCounts = { A: 0, B: 0 };
  const raisedLastRound = { A: false, B: false };
  const rounds: RoundLog[] = [];

  for (let roundNumber = 1; roundNumber <= MAX_ROUNDS; roundNumber++) {
    // RNG draw order is fixed: edge first, then (only if needed) the flip.
    const edgeIndex = Math.floor(rng() * EDGES.length);
    const edgeA = EDGES[edgeIndex];
    if (edgeA === undefined) throw new Error(`edge index out of range: ${edgeIndex}`);
    const edgeB = complementEdge(edgeA);

    const viewA = exactView({
      myEdge: edgeA,
      myRoundsWon: roundsWon.A,
      oppRoundsWon: roundsWon.B,
      roundNumber,
      oppRaiseCount: raiseCounts.B,
      oppRaisedLastRound: raisedLastRound.B,
      myNet: nets.A,
    });
    const viewB = exactView({
      myEdge: edgeB,
      myRoundsWon: roundsWon.B,
      oppRoundsWon: roundsWon.A,
      roundNumber,
      oppRaiseCount: raiseCounts.A,
      oppRaisedLastRound: raisedLastRound.A,
      myNet: nets.B,
    });

    // Simultaneous choice: neither agent sees the other's current action,
    // and raise counts are only updated once both have chosen.
    const actionA = checkAction(agentA(Object.freeze(viewA)), "A");
    const actionB = checkAction(agentB(Object.freeze(viewB)), "B");
    if (actionA === "raise") raiseCounts.A++;
    if (actionB === "raise") raiseCounts.B++;
    raisedLastRound.A = actionA === "raise";
    raisedLastRound.B = actionB === "raise";

    let outcome: RoundLog["outcome"];
    let bet = 0;
    let winner: Seat | null = null;
    let flip: RoundLog["flip"] = null;

    if (actionA === "fold" && actionB === "fold") {
      outcome = "both-folded";
    } else if (actionA === "fold" || actionB === "fold") {
      outcome = "one-folded";
      bet = ANTE;
      winner = actionA === "fold" ? "B" : "A";
    } else {
      outcome = "flipped";
      bet = actionA === "raise" || actionB === "raise" ? RAISED_BET : BASE_BET;
      const roll = rng();
      winner = roll < edgeA ? "A" : "B";
      flip = { probabilityAWins: edgeA, roll, winner };
    }

    if (winner !== null) {
      const loser: Seat = winner === "A" ? "B" : "A";
      nets[winner] += bet;
      nets[loser] -= bet;
      roundsWon[winner]++;
    }

    rounds.push({
      roundNumber,
      edges: { A: edgeA, B: edgeB },
      actions: { A: actionA, B: actionB },
      outcome,
      bet,
      flip,
      winner,
      nets: { ...nets },
      roundsWon: { ...roundsWon },
      raiseCounts: { ...raiseCounts },
    });

    if (roundsWon.A >= ROUNDS_TO_WIN || roundsWon.B >= ROUNDS_TO_WIN) break;
  }

  const matchWinner: Seat | null =
    roundsWon.A >= ROUNDS_TO_WIN ? "A" : roundsWon.B >= ROUNDS_TO_WIN ? "B" : null;

  return {
    seed,
    names: options.names ?? { A: "A", B: "B" },
    rounds,
    roundsWon,
    nets,
    winner: matchWinner,
    endReason: matchWinner !== null ? "round-wins" : "max-rounds",
  };
}

function checkAction(action: Action, seat: Seat): Action {
  if (action !== "fold" && action !== "call" && action !== "raise") {
    throw new Error(`agent ${seat} returned invalid action: ${String(action)}`);
  }
  return action;
}
