import { EDGE_KEYS, type Policy, type Situation } from "../agents/policy.js";

/**
 * How a decision table plays, as a handful of numbers a face can be drawn
 * from. Read from the table's cells, never from a preset's name, so a table
 * written from a brief gets a face from what it actually does.
 *
 * Presentation only. Nothing here is read by the engine, matchmaking, the
 * ledger, ratings or the chain.
 */
export type Style = {
  /** Raises, as a share of the cells where a raise is possible. Anchor 0.4, Hammer 0.6, Bully 0.8. */
  aggression: number;
  /**
   * Raising its weakest hands while only calling hands in the middle: the
   * bluffer's polarised pattern. Share of the raising rows that do it. Mirage 1,
   * the others 0. Raising from low all the way up is aggression, not a bluff.
   */
  bluff: number;
  /** Folds to a raise, as a share of the facing-a-raise cells. Bully 0.6, the others 0.4. */
  backsDown: number;
  /** Folds anywhere, as a share of every cell. */
  caution: number;
  /**
   * How it changes when the opponent raised last round: positive pushes back
   * (raises more), negative rattles (folds more), 0 holds firm. -1 to 1.
   */
  pressure: number;
};

/** The rows where acting means choosing between fold, call and raise. */
const OPEN_ROWS: Situation[] = ["lead", "leadUnderPressure", "vsCall", "vsCallUnderPressure"];
const RAISED_ROWS: Situation[] = ["vsRaise", "vsRaiseUnderPressure"];
/** Each calm row with its under-pressure twin. */
const PRESSURE_PAIRS: [Situation, Situation][] = [
  ["lead", "leadUnderPressure"],
  ["vsCall", "vsCallUnderPressure"],
  ["vsRaise", "vsRaiseUnderPressure"],
];

const cells = (policy: Policy, rows: Situation[]) => rows.flatMap((r) => EDGE_KEYS.map((k) => policy[r][k]!));
const share = (actions: string[], action: string) => actions.filter((a) => a === action).length / actions.length;

export function styleOf(policy: Policy): Style {
  const open = cells(policy, OPEN_ROWS);

  // A row bluffs when it raises one of its two weakest edges and yet does not
  // raise some stronger edge: raising low for a reason other than strength.
  const bluffRows = OPEN_ROWS.filter((row) => {
    const acts = EDGE_KEYS.map((k) => policy[row][k]!);
    const lowRaise = acts.findIndex((a, i) => i < 2 && a === "raise");
    return lowRaise >= 0 && acts.slice(lowRaise + 1).some((a) => a !== "raise");
  });

  let shift = 0;
  for (const [calm, pressed] of PRESSURE_PAIRS) {
    for (const k of EDGE_KEYS) {
      const before = policy[calm][k]!;
      const after = policy[pressed][k]!;
      if (before === after) continue;
      const rank = { fold: 0, call: 1, raise: 2 } as const;
      shift += rank[after] - rank[before];
    }
  }
  const pressureCells = PRESSURE_PAIRS.length * EDGE_KEYS.length;

  return {
    aggression: share(open, "raise"),
    bluff: bluffRows.length / OPEN_ROWS.length,
    backsDown: share(cells(policy, RAISED_ROWS), "fold"),
    caution: share(cells(policy, [...OPEN_ROWS, ...RAISED_ROWS]), "fold"),
    // Scaled so a table that moves a third of its cells one step reads as fully rattled or defiant.
    pressure: Math.max(-1, Math.min(1, (shift / pressureCells) * 3)),
  };
}
