import type { Deal, Stakes, TurnOrder } from "./round.js";
export type Action = "fold" | "call" | "raise";

export type Seat = "A" | "B";

/**
 * Everything an agent is allowed to know when choosing an action.
 * There is deliberately no opponent-edge field; the engine builds views
 * through `exactView`, which rejects any extra property at compile time.
 */
export type View = {
  readonly myEdge: number;
  readonly myRoundsWon: number;
  readonly oppRoundsWon: number;
  /** 1-based. */
  readonly roundNumber: number;
  /** Raises the opponent made in earlier rounds (not the current one). */
  readonly oppRaiseCount: number;
  /** Whether the opponent raised in the immediately previous round (false in round 1). */
  readonly oppRaisedLastRound: boolean;
  /**
   * The match's public price table. In simultaneous play the bet for this
   * round is unknown when choosing; in turn-based play, oppActionThisRound
   * shows whether a raise is already on the table.
   */
  readonly stakes: Readonly<Stakes>;
  /** Turn-based only: what the opponent already did this round; null when acting first or in simultaneous play. */
  readonly oppActionThisRound: Action | null;
  /** Turn-based only: my earlier action this round (the leader answering a raise); otherwise null. */
  readonly myActionThisRound: Action | null;
  readonly myNet: number;
};

export type Agent = (view: View) => Action;

export type RoundOutcome =
  /** Both folded: no flip, no money moves, nobody wins the round. */
  | "both-folded"
  /** Exactly one folded: the folder pays the ante and loses the round. */
  | "one-folded"
  /** Neither folded: the weighted coin was flipped. */
  | "flipped";

export type FlipLog = {
  /** Probability that A wins: A's edge (complementary deal) or 0.5 + edgeA - edgeB (independent). */
  probabilityAWins: number;
  /** PRNG draw in [0, 1). A wins when roll < probabilityAWins. */
  roll: number;
  winner: Seat;
};

export type RoundLog = {
  roundNumber: number;
  /** Turn-based: who acted first this round. Null in simultaneous play. */
  leader: Seat | null;
  /** Decisions in the order they were made (both at once in simultaneous play). */
  sequence: { seat: Seat; action: Action }[];
  edges: { A: number; B: number };
  /**
   * Final actions. In turn-based play these are effective: a re-raise counts
   * as a call, and a responder who never acted (the leader folded) is "call".
   */
  actions: { A: Action; B: Action };
  outcome: RoundOutcome;
  /**
   * Amount that changed hands this round: 0 if both folded, the ante if one
   * folded, otherwise the bet (base or raised).
   */
  bet: number;
  /** Present only when outcome is "flipped". */
  flip: FlipLog | null;
  /** Round winner; null if both folded. */
  winner: Seat | null;
  /** State after this round resolved. */
  nets: { A: number; B: number };
  roundsWon: { A: number; B: number };
  raiseCounts: { A: number; B: number };
};

export type MatchLog = {
  seed: number;
  stakes: Stakes;
  turnOrder: TurnOrder;
  deal: Deal;
  /** Turn-based: who led round 1 (then leadership alternates). Null in simultaneous play. */
  firstLeader: Seat | null;
  names: { A: string; B: string };
  rounds: RoundLog[];
  roundsWon: { A: number; B: number };
  nets: { A: number; B: number };
  /** Seat that reached the required round wins, or null (e.g. 1-1 after a both-fold round). */
  winner: Seat | null;
  endReason: "round-wins" | "max-rounds";
};
