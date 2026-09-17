import type { Action, Agent, RoundOutcome, Seat, View } from "./types.js";

export const EDGES = [0.3, 0.4, 0.5, 0.6, 0.7] as const;
export const ANTE = 10;
export const BASE_BET = 10;
export const RAISED_BET = 20;
export const MAX_ROUNDS = 3;
export const ROUNDS_TO_WIN = 2;

export type Stakes = {
  /** Paid by a lone folder to the opponent. */
  ante: number;
  /** Flip bet when neither agent raised. */
  baseBet: number;
  /** Flip bet when either agent raised. */
  raisedBet: number;
};

export const CLASSIC_STAKES: Stakes = { ante: ANTE, baseBet: BASE_BET, raisedBet: RAISED_BET };

type PerSeat<T> = { A: T; B: T };

/** State between rounds. Shared by the simulator and the exact calculator so they cannot drift. */
export type MatchState = {
  /** The next round to play, 1-based. */
  roundNumber: number;
  nets: PerSeat<number>;
  roundsWon: PerSeat<number>;
  raiseCounts: PerSeat<number>;
  raisedLastRound: PerSeat<boolean>;
};

export const INITIAL_STATE: MatchState = Object.freeze({
  roundNumber: 1,
  nets: { A: 0, B: 0 },
  roundsWon: { A: 0, B: 0 },
  raiseCounts: { A: 0, B: 0 },
  raisedLastRound: { A: false, B: false },
});

export function isMatchOver(state: MatchState): boolean {
  return (
    state.roundNumber > MAX_ROUNDS ||
    state.roundsWon.A >= ROUNDS_TO_WIN ||
    state.roundsWon.B >= ROUNDS_TO_WIN
  );
}

export function matchWinner(state: MatchState): Seat | null {
  if (state.roundsWon.A >= ROUNDS_TO_WIN) return "A";
  if (state.roundsWon.B >= ROUNDS_TO_WIN) return "B";
  return null;
}

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
export function complementEdge(edge: number): number {
  return Math.round((1 - edge) * 100) / 100;
}

/**
 * Asks both agents for their action. Simultaneous: each sees only its own
 * edge and the state before this round.
 */
export function decideRound(
  agentA: Agent,
  agentB: Agent,
  state: MatchState,
  edgeA: number,
): { edgeB: number; actions: PerSeat<Action> } {
  const edgeB = complementEdge(edgeA);
  const { roundNumber, nets, roundsWon, raiseCounts, raisedLastRound } = state;
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
  return {
    edgeB,
    actions: {
      A: checkAction(agentA(Object.freeze(viewA)), "A"),
      B: checkAction(agentB(Object.freeze(viewB)), "B"),
    },
  };
}

export type Resolution =
  | { outcome: Extract<RoundOutcome, "both-folded"> }
  | { outcome: Extract<RoundOutcome, "one-folded">; winner: Seat; bet: number }
  /** The winner is decided by a flip A wins with probability A's edge. */
  | { outcome: Extract<RoundOutcome, "flipped">; bet: number };

export function resolveActions(actions: PerSeat<Action>, stakes: Stakes): Resolution {
  const { A, B } = actions;
  if (A === "fold" && B === "fold") return { outcome: "both-folded" };
  if (A === "fold" || B === "fold") {
    return { outcome: "one-folded", winner: A === "fold" ? "B" : "A", bet: stakes.ante };
  }
  return { outcome: "flipped", bet: A === "raise" || B === "raise" ? stakes.raisedBet : stakes.baseBet };
}

/** State after a round: `bet` moves from loser to winner (nothing moves if winner is null). */
export function advanceState(
  state: MatchState,
  actions: PerSeat<Action>,
  winner: Seat | null,
  bet: number,
): MatchState {
  const nets = { ...state.nets };
  const roundsWon = { ...state.roundsWon };
  if (winner !== null) {
    const loser: Seat = winner === "A" ? "B" : "A";
    nets[winner] += bet;
    nets[loser] -= bet;
    roundsWon[winner]++;
  }
  return {
    roundNumber: state.roundNumber + 1,
    nets,
    roundsWon,
    raiseCounts: {
      A: state.raiseCounts.A + (actions.A === "raise" ? 1 : 0),
      B: state.raiseCounts.B + (actions.B === "raise" ? 1 : 0),
    },
    raisedLastRound: { A: actions.A === "raise", B: actions.B === "raise" },
  };
}

function checkAction(action: Action, seat: Seat): Action {
  if (action !== "fold" && action !== "call" && action !== "raise") {
    throw new Error(`agent ${seat} returned invalid action: ${String(action)}`);
  }
  return action;
}
