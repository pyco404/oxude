import {
  CLASSIC_STAKES,
  makeStrategy,
  PRESET_NAMES,
  PRESETS,
  seatAveragedNet,
  type Agent,
  type PresetName,
  type Stakes,
  type Deal,
  type TurnOrder,
} from "../src/index.js";

export const SPREAD_LIMIT = 1.5;
/** Exact values within this of zero count as ties. */
export const TIE = 1e-9;
/** A probe may beat at most this many presets. */
export const MAX_PROBE_BEATS = 2;

/** Simple non-preset strategies used to look for exploits. */
export const PROBES: [string, Agent][] = [
  ["AlwaysRaise", () => "raise"],
  ["Fold0.3Call", makeStrategy({ foldBelow: 0.35, raiseAtOrAbove: 1, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.35 })],
  ["Fold<.5R.7", makeStrategy({ foldBelow: 0.45, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: null, foldToRaiseBelow: 0.45 })],
];
export const PROBE_NOTES: Record<string, string> = {
  "Fold0.3Call": "fold on 0.3 (also to a raise), otherwise call, never raise",
  "Fold<.5R.7": "fold below 0.5 (also to a raise), call on 0.5 and 0.6, raise on 0.7",
};

export const NAMES = [...PRESET_NAMES, ...PROBES.map(([n]) => n)];
export const agentsFor = (presets: Record<PresetName, Agent>): [string, Agent][] => [
  ...PRESET_NAMES.map((n): [string, Agent] => [n, presets[n]]),
  ...PROBES,
];
export const P = PRESET_NAMES.length;

/** Relations the preset loop must show: [winner, loser]. */
export const EXPECTED_LOOP: [string, string][] = [
  ["Reckless", "Patient"],
  ["Steady", "Reckless"],
  ["Steady", "Patient"],
  ["Patient", "Tricky"],
  ["Tricky", "Reckless"],
  ["Tricky", "Steady"],
];

export type FieldResult = { avg: number; beats: number };
export type Analysis = {
  stakes: Stakes;
  /** matrix[i][j] = exact seat-averaged net of AGENTS[i] vs PRESETS[j]. */
  matrix: number[][];
  field: FieldResult[];
  loop: { winner: string; loser: string; margin: number }[];
  loopHolds: boolean;
  spread: number;
  checks: { label: string; ok: boolean; detail: string }[];
};

export const fmt = (x: number) => (Math.abs(x) < TIE ? " 0.000" : (x >= 0 ? "+" : "") + x.toFixed(3));

export function analyse(
  stakes: Stakes = CLASSIC_STAKES,
  presets: Record<PresetName, Agent> = PRESETS,
  turnOrder: TurnOrder = "simultaneous",
  deal: Deal = "complementary",
): Analysis {
  const matrix = agentsFor(presets).map(([, a]) =>
    PRESET_NAMES.map((n) => seatAveragedNet(a, presets[n], { stakes, turnOrder, deal })),
  );
  const field = matrix.map((row) => ({
    avg: row.reduce((s, x) => s + x, 0) / P,
    beats: row.filter((x) => x > TIE).length,
  }));
  const idx = (n: string) => NAMES.indexOf(n);
  const loop = EXPECTED_LOOP.map(([winner, loser]) => ({ winner, loser, margin: matrix[idx(winner)]![idx(loser)]! }));
  const loopHolds = loop.every((x) => x.margin > TIE);
  const presetAvgs = field.slice(0, P).map((f) => f.avg);
  const spread = Math.max(...presetAvgs) - Math.min(...presetAvgs);

  const describe = (f: FieldResult) => `avg ${fmt(f.avg)}, beats ${f.beats}/${P}`;
  const ar = field[idx("AlwaysRaise")]!;
  const checks = [
    { label: "1. AlwaysRaise does not beat the presets", ok: ar.avg <= TIE, detail: describe(ar) },
    ...PROBES.slice(1).map(([name]) => {
      const f = field[idx(name)]!;
      return {
        label: `2. ${name} averages <= 0 and beats at most ${MAX_PROBE_BEATS}/${P}`,
        ok: f.avg <= TIE && f.beats <= MAX_PROBE_BEATS,
        detail: describe(f),
      };
    }),
    {
      label: "3a. Preset loop holds",
      ok: loopHolds,
      detail: loop.map((x) => `${x.winner}>${x.loser} ${fmt(x.margin)}`).join(", "),
    },
    { label: `3b. Preset spread < ${SPREAD_LIMIT}`, ok: spread < SPREAD_LIMIT, detail: `spread ${spread.toFixed(3)}` },
  ];
  return { stakes, matrix, field, loop, loopHolds, spread, checks };
}

export function stakesFromEnv(): Stakes {
  const num = (name: string, fallback: number) => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got ${raw}`);
    return v;
  };
  return {
    ante: num("ANTE", CLASSIC_STAKES.ante),
    baseBet: num("BASE_BET", CLASSIC_STAKES.baseBet),
    raisedBet: num("RAISED_BET", CLASSIC_STAKES.raisedBet),
  };
}
