import {
  EDGES,
  MAX_ROUNDS,
  ROUNDS_TO_WIN,
  complementEdge,
  expectedNet,
  type Action,
  type Agent,
  type Stakes,
  type TurnOrder,
} from "../src/index.js";

// Fast exact evaluator for agents whose decision depends only on their edge,
// whether the opponent raised last round, what the opponent did this round,
// and the stakes -- which is everything makeStrategy reads. It runs a memoised
// DP over (round, round wins, last-round raises, leader) instead of walking the
// full tree. selfCheck() verifies it against the general exact calculator.

const FOLD = 0, CALL = 1, RAISE = 2;
const CODE: Record<Action, number> = { fold: FOLD, call: CALL, raise: RAISE };
/** Situation: 0 = acting first (or simultaneous), 1 = facing a call, 2 = facing a raise. */
const FACING: (Action | null)[] = [null, "call", "raise"];
const E = EDGES.length;

/** Actions indexed by [pressured][facing][edge index], flattened. */
export type DecisionTable = Uint8Array;
const at = (t: DecisionTable, pressured: number, facing: number, edge: number) => t[(pressured * 3 + facing) * E + edge]!;

// B's edge is always the complement, and EDGES is symmetric, so B's index is the mirror.
for (let i = 0; i < E; i++) {
  if (complementEdge(EDGES[i]!) !== EDGES[E - 1 - i]) throw new Error("EDGES must be symmetric for table-eval");
}

export function tableFor(agent: Agent, stakes: Readonly<Stakes>): DecisionTable {
  const t = new Uint8Array(2 * 3 * E);
  for (let p = 0; p < 2; p++)
    for (let f = 0; f < 3; f++)
      for (let i = 0; i < E; i++) {
        const action = agent({
          myEdge: EDGES[i]!,
          oppRaisedLastRound: p === 1,
          oppRaiseCount: p,
          myRoundsWon: 0,
          oppRoundsWon: 0,
          roundNumber: 2,
          myNet: 0,
          stakes,
          oppActionThisRound: FACING[f]!,
          myActionThisRound: null,
        });
        t[(p * 3 + f) * E + i] = CODE[action];
      }
  return t;
}

/** Expected net for A. Alternating play averages over the round-1 leader coin. */
export function tableNet(tA: DecisionTable, tB: DecisionTable, stakes: Readonly<Stakes>, turnOrder: TurnOrder): number {
  const { ante, baseBet, raisedBet } = stakes;
  const memo = new Float64Array(2 * 2 * 2 * 2 * 2 * 2 * (MAX_ROUNDS + 1));
  const done = new Uint8Array(memo.length);
  // leader: 0 = A, 1 = B, 2 = simultaneous
  const value = (round: number, wA: number, wB: number, lastA: number, lastB: number, leader: number): number => {
    if (round > MAX_ROUNDS || wA >= ROUNDS_TO_WIN || wB >= ROUNDS_TO_WIN) return 0;
    const key = ((((round * 2 + wA) * 2 + wB) * 2 + lastA) * 2 + lastB) * 3 + leader;
    if (key < memo.length && done[key]) return memo[key]!;
    let total = 0;
    for (let i = 0; i < E; i++) {
      const edgeA = EDGES[i]!;
      const j = E - 1 - i;
      let aAct: number, bAct: number;
      if (leader === 2) {
        aAct = at(tA, lastB, 0, i);
        bAct = at(tB, lastA, 0, j);
      } else {
        const [tL, tR, iL, iR, pL, pR] = leader === 0 ? [tA, tB, i, j, lastB, lastA] : [tB, tA, j, i, lastA, lastB];
        let lAct: number, rAct: number;
        const first = at(tL, pL, 0, iL);
        if (first === FOLD) {
          lAct = FOLD;
          rAct = CALL;
        } else {
          let reply = at(tR, pR, first === RAISE ? 2 : 1, iR);
          if (first === RAISE && reply === RAISE) reply = CALL;
          if (first === CALL && reply === RAISE) {
            lAct = at(tL, pL, 2, iL) === FOLD ? FOLD : CALL;
            rAct = RAISE;
          } else {
            lAct = first;
            rAct = reply;
          }
        }
        [aAct, bAct] = leader === 0 ? [lAct, rAct] : [rAct, lAct];
      }
      const nextLeader = leader === 2 ? 2 : 1 - leader;
      const nA = aAct === RAISE ? 1 : 0;
      const nB = bAct === RAISE ? 1 : 0;
      let ev: number;
      if (aAct === FOLD && bAct === FOLD) {
        ev = value(round + 1, wA, wB, nA, nB, nextLeader);
      } else if (aAct === FOLD) {
        ev = -ante + value(round + 1, wA, wB + 1, nA, nB, nextLeader);
      } else if (bAct === FOLD) {
        ev = ante + value(round + 1, wA + 1, wB, nA, nB, nextLeader);
      } else {
        const bet = aAct === RAISE || bAct === RAISE ? raisedBet : baseBet;
        ev =
          edgeA * (bet + value(round + 1, wA + 1, wB, nA, nB, nextLeader)) +
          (1 - edgeA) * (-bet + value(round + 1, wA, wB + 1, nA, nB, nextLeader));
      }
      total += ev;
    }
    const v = total / E;
    if (key < memo.length) {
      memo[key] = v;
      done[key] = 1;
    }
    return v;
  };
  if (turnOrder === "simultaneous") return value(1, 0, 0, 0, 0, 2);
  return (value(1, 0, 0, 0, 0, 0) + value(1, 0, 0, 0, 0, 1)) / 2;
}

export const tableSeatAveraged = (tX: DecisionTable, tY: DecisionTable, stakes: Readonly<Stakes>, turnOrder: TurnOrder) =>
  (tableNet(tX, tY, stakes, turnOrder) - tableNet(tY, tX, stakes, turnOrder)) / 2;

/** Throws unless the fast evaluator matches the general exact calculator on the given pairs. */
export function selfCheck(pairs: [Agent, Agent][], stakes: Readonly<Stakes>, turnOrder: TurnOrder): number {
  let worst = 0;
  for (const [a, b] of pairs) {
    const fast = tableNet(tableFor(a, stakes), tableFor(b, stakes), stakes, turnOrder);
    const slow = expectedNet(a, b, { stakes, turnOrder });
    worst = Math.max(worst, Math.abs(fast - slow));
  }
  if (worst > 1e-9) throw new Error(`table-eval disagrees with expectedNet by ${worst}`);
  return worst;
}
