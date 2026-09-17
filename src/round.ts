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

export const CLASSIC_STAKES: Readonly<Stakes> = Object.freeze({ ante: ANTE, baseBet: BASE_BET, raisedBet: RAISED_BET });

/** Frozen copy, safe to hand to agents inside views. */
export function freezeStakes(stakes: Readonly<Stakes>): Readonly<Stakes> {
  return Object.freeze({ ante: stakes.ante, baseBet: stakes.baseBet, raisedBet: stakes.raisedBet });
}

type PerSeat<T> = { A: T; B: T };

/**
 * "simultaneous": both agents choose at once (classic).
 * "alternating": one agent leads each round and the other responds, with at
 * most one raise per round; if the responder raises after a call the leader
 * answers with fold or call. Leadership alternates every round.
 */
export type TurnOrder = "simultaneous" | "alternating";

export const other = (seat: Seat): Seat => (seat === "A" ? "B" : "A");

/** State between rounds. Shared by the simulator and the exact calculator so they cannot drift. */
export type MatchState = {
  /** The next round to play, 1-based. */
  roundNumber: number;
  nets: PerSeat<number>;
  roundsWon: PerSeat<number>;
  raiseCounts: PerSeat<number>;
  raisedLastRound: PerSeat<boolean>;
  /** Alternating play: who leads the next round. Null in simultaneous play. */
  nextLeader: Seat | null;
};

export const INITIAL_STATE: MatchState = Object.freeze({
  roundNumber: 1,
  nets: { A: 0, B: 0 },
  roundsWon: { A: 0, B: 0 },
  raiseCounts: { A: 0, B: 0 },
  raisedLastRound: { A: false, B: false },
  nextLeader: null,
});

export function initialState(firstLeader: Seat | null): MatchState {
  return firstLeader === null ? INITIAL_STATE : Object.freeze({ ...INITIAL_STATE, nextLeader: firstLeader });
}

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

type Decision = { edgeB: number; actions: PerSeat<Action>; sequence: { seat: Seat; action: Action }[] };

function viewFor(
  seat: Seat,
  state: MatchState,
  edge: number,
  stakes: Readonly<Stakes>,
  mine: Action | null,
  opp: Action | null,
): View {
  const o = other(seat);
  return Object.freeze(
    exactView({
      myEdge: edge,
      myRoundsWon: state.roundsWon[seat],
      oppRoundsWon: state.roundsWon[o],
      roundNumber: state.roundNumber,
      oppRaiseCount: state.raiseCounts[o],
      oppRaisedLastRound: state.raisedLastRound[o],
      myNet: state.nets[seat],
      stakes,
      oppActionThisRound: opp,
      myActionThisRound: mine,
    }),
  );
}

/**
 * Asks the agents for their actions this round. Each view carries only the
 * agent's own edge, the state before this round, and (turn-based) what the
 * opponent has already done this round.
 */
export function decideRound(
  agentA: Agent,
  agentB: Agent,
  state: MatchState,
  edgeA: number,
  stakes: Readonly<Stakes>,
): Decision {
  const edgeB = complementEdge(edgeA);
  const edges = { A: edgeA, B: edgeB };
  const agents = { A: agentA, B: agentB };
  const ask = (seat: Seat, mine: Action | null, opp: Action | null) =>
    checkAction(agents[seat](viewFor(seat, state, edges[seat], stakes, mine, opp)), seat);

  const leader = state.nextLeader;
  if (leader === null) {
    const actions = { A: ask("A", null, null), B: ask("B", null, null) };
    return { edgeB, actions, sequence: [{ seat: "A", action: actions.A }, { seat: "B", action: actions.B }] };
  }

  const responder = other(leader);
  const first = ask(leader, null, null);
  const sequence: Decision["sequence"] = [{ seat: leader, action: first }];
  if (first === "fold") {
    // The responder never acts; recorded as a call so resolution awards it the ante.
    return { edgeB, actions: seatActions(leader, "fold", "call"), sequence };
  }
  const reply = ask(responder, null, first);
  const second: Action = first === "raise" && reply === "raise" ? "call" : reply; // one raise per round
  sequence.push({ seat: responder, action: second });
  if (first === "call" && second === "raise") {
    const answer: Action = ask(leader, first, second) === "fold" ? "fold" : "call"; // no re-raise
    sequence.push({ seat: leader, action: answer });
    return { edgeB, actions: seatActions(leader, answer, "raise"), sequence };
  }
  return { edgeB, actions: seatActions(leader, first, second), sequence };
}

function seatActions(leader: Seat, leaderAction: Action, responderAction: Action): PerSeat<Action> {
  return leader === "A"
    ? { A: leaderAction, B: responderAction }
    : { A: responderAction, B: leaderAction };
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
    nextLeader: state.nextLeader === null ? null : other(state.nextLeader),
  };
}

function checkAction(action: Action, seat: Seat): Action {
  if (action !== "fold" && action !== "call" && action !== "raise") {
    throw new Error(`agent ${seat} returned invalid action: ${String(action)}`);
  }
  return action;
}
