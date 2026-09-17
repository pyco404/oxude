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
  readonly myNet: number;
};

export type Agent = (view: View) => Action;

export type RoundOutcome =
  /** Both folded: no flip, no money moves, nobody wins the round. */
  | "both-folded"
  /** Exactly one folded: the folder pays the ante and loses the round. */
  | "one-folded"
  /**
   * One side raised, the other folded, and the rules flip anyway
   * (any `foldToRaise` other than "classic"). `bet` is what moved.
   */
  | "folded-to-raise"
  /** Neither folded: the weighted coin was flipped. */
  | "flipped";

export type FlipLog = {
  /** Probability that A wins; equal to A's edge. */
  probabilityAWins: number;
  /** PRNG draw in [0, 1). A wins when roll < probabilityAWins. */
  roll: number;
  winner: Seat;
};

export type RoundLog = {
  roundNumber: number;
  edges: { A: number; B: number };
  actions: { A: Action; B: Action };
  outcome: RoundOutcome;
  /**
   * Amount that changed hands this round: 0 if both folded, the ante if one
   * folded, otherwise the bet (base or raised).
   */
  bet: number;
  /** Present when the coin was flipped ("flipped" or "folded-to-raise"). */
  flip: FlipLog | null;
  /** Round winner; null if both folded. */
  winner: Seat | null;
  /** State after this round resolved. */
  nets: { A: number; B: number };
  roundsWon: { A: number; B: number };
  raiseCounts: { A: number; B: number };
};

export type FoldToRaiseRule =
  /** The folder pays the ante and the raiser wins the round, no flip. */
  | "classic"
  /**
   * Flip anyway. Raiser wins: folder pays the ante. Raiser loses: raiser pays
   * the raised bet. Tested and rejected: folding beats calling at every edge.
   */
  | "raiser-risks-raise"
  /** Flip anyway, for the ante only: the winner takes the ante from the loser. */
  | "flip-for-ante";

export type MatchRules = {
  /** What happens when exactly one agent raises and the other folds. */
  foldToRaise: FoldToRaiseRule;
};

export type MatchLog = {
  seed: number;
  rules: MatchRules;
  names: { A: string; B: string };
  rounds: RoundLog[];
  roundsWon: { A: number; B: number };
  nets: { A: number; B: number };
  /** Seat that reached the required round wins, or null (e.g. 1-1 after a both-fold round). */
  winner: Seat | null;
  endReason: "round-wins" | "max-rounds";
};
