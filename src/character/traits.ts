import type { MatchLog, Seat } from "../types.js";

/**
 * Personality measured from real play: how often an agent bluffs, folds and
 * raises, and what it does once raised at. Read from match logs, which already
 * hold both hands and every decision - so it describes what the agent did,
 * not what its table says it would.
 *
 * Kept as raw counts, so new matches add to them without re-reading old ones;
 * rates and words are derived on read. Presentation only.
 */

export type TraitCounts = {
  decisions: number;
  folds: number;
  /** Decisions where a raise was allowed: not answering a raise. */
  raiseChances: number;
  raises: number;
  /** Rounds it held a weak hand - more likely to lose than win - and could have raised. */
  weakChances: number;
  /** Of those, the rounds it raised anyway: bluffs. */
  bluffs: number;
  /** The same counts again, for decisions made after the opponent raised last round. */
  pressured: number;
  pressuredFolds: number;
  pressuredRaiseChances: number;
  pressuredRaises: number;
};

export const EMPTY_COUNTS: TraitCounts = {
  decisions: 0,
  folds: 0,
  raiseChances: 0,
  raises: 0,
  weakChances: 0,
  bluffs: 0,
  pressured: 0,
  pressuredFolds: 0,
  pressuredRaiseChances: 0,
  pressuredRaises: 0,
};

export const addCounts = (a: TraitCounts, b: TraitCounts): TraitCounts =>
  Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof TraitCounts] + b[k as keyof TraitCounts]])) as TraitCounts;

const other = (s: Seat): Seat => (s === "A" ? "B" : "A");

/** One match, from one seat. */
export function countMatch(log: MatchLog, seat: Seat): TraitCounts {
  const c = { ...EMPTY_COUNTS };
  const opp = other(seat);
  for (const [i, round] of log.rounds.entries()) {
    // Under pressure: the opponent's effective action last round was a raise, as the engine sees it.
    const pressured = i > 0 && log.rounds[i - 1]!.actions[opp] === "raise";
    // A weak hand: more likely to lose than win. Raising a strong hand into a
    // stronger one is a raise that lost, not a bluff.
    const weak = round.edges[seat] < 0.5;
    let couldRaise = false;
    let raisedFree = false;
    for (const [j, move] of round.sequence.entries()) {
      if (move.seat !== seat) continue;
      const facingRaise = round.sequence[j - 1]?.seat === opp && round.sequence[j - 1]?.action === "raise";
      // A raise answering a raise counts as the call it becomes.
      const action = facingRaise && move.action === "raise" ? "call" : move.action;
      c.decisions++;
      if (action === "fold") c.folds++;
      if (pressured) {
        c.pressured++;
        if (action === "fold") c.pressuredFolds++;
      }
      if (!facingRaise) {
        couldRaise = true;
        c.raiseChances++;
        if (pressured) c.pressuredRaiseChances++;
        if (action === "raise") {
          c.raises++;
          raisedFree = true;
          if (pressured) c.pressuredRaises++;
        }
      }
    }
    if (weak && couldRaise) {
      c.weakChances++;
      if (raisedFree) c.bluffs++;
    }
  }
  return c;
}

/** How many decisions before a trait is shown. At 60, a rate near 30% is known to within about six points. */
export const MIN_DECISIONS = 60;
/** How many decisions under pressure before that trait is shown. */
export const MIN_PRESSURED = 20;
/** How many weak hands it must have held before its bluffing is judged. */
export const MIN_WEAK = 15;

export type Trait = { rate: number; word: string } | null;
export type Traits = {
  decisions: number;
  bluff: Trait;
  fold: Trait;
  aggression: Trait;
  /** How it plays once raised at, against how it plays otherwise. */
  underPressure: { word: "holds firm" | "backs down" | "pushes back"; foldShift: number; raiseShift: number } | null;
  /** "not enough hands yet" until the minimum is reached, then null. */
  note: string | null;
};

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
const band = (r: number, words: [number, string][]) => words.find(([limit]) => r <= limit)?.[1] ?? words[words.length - 1]![1];

/** Rates and words from the counts, each shown only once there are enough hands behind it. */
export function traitsFrom(c: TraitCounts): Traits {
  const enough = c.decisions >= MIN_DECISIONS;
  const bluffRate = rate(c.bluffs, c.weakChances);
  const foldRate = rate(c.folds, c.decisions);
  const raiseRate = rate(c.raises, c.raiseChances);

  let underPressure: Traits["underPressure"] = null;
  const calm = { decisions: c.decisions - c.pressured, folds: c.folds - c.pressuredFolds, chances: c.raiseChances - c.pressuredRaiseChances, raises: c.raises - c.pressuredRaises };
  if (c.pressured >= MIN_PRESSURED && calm.decisions >= MIN_PRESSURED) {
    const foldShift = rate(c.pressuredFolds, c.pressured) - rate(calm.folds, calm.decisions);
    const raiseShift = rate(c.pressuredRaises, c.pressuredRaiseChances) - rate(calm.raises, calm.chances);
    // Ten points is well outside what chance moves at these counts; less than that is holding firm.
    const word = raiseShift > 0.1 ? "pushes back" : foldShift > 0.1 ? "backs down" : "holds firm";
    underPressure = { word, foldShift, raiseShift };
  }

  return {
    decisions: c.decisions,
    bluff: enough && c.weakChances >= MIN_WEAK ? { rate: bluffRate, word: band(bluffRate, [[0.02, "never bluffs"], [0.2, "bluffs now and then"], [0.45, "bluffs often"], [1, "bluffs relentlessly"]]) } : null,
    fold: enough ? { rate: foldRate, word: band(foldRate, [[0.05, "almost never folds"], [0.15, "rarely folds"], [0.3, "folds when it should"], [1, "folds readily"]]) } : null,
    aggression: enough ? { rate: raiseRate, word: band(raiseRate, [[0.2, "passive"], [0.4, "measured"], [0.65, "aggressive"], [1, "relentless"]]) } : null,
    underPressure,
    note: enough ? null : "not enough hands yet",
  };
}
