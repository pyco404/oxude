import {
  CLASSIC_RULES,
  FLIP_FOR_ANTE_RULES,
  makeStrategy,
  mulberry32,
  nextUint32,
  playMatch,
  PRESET_NAMES,
  PRESETS,
  RAISE_AT_RISK_RULES,
  type Agent,
  type MatchRules,
} from "../src/index.js";

const MATCHES = 20_000;
const MASTER_SEED = Number(process.env.BALANCE_SEED ?? 0x0de5eed);
const SPREAD_LIMIT = 1.5;

/** Simple non-preset strategies used to look for exploits. */
const PROBES: [string, Agent][] = [
  ["AlwaysRaise", () => "raise"],
  ["Fold0.3Call", makeStrategy({ foldBelow: 0.35, raiseAtOrAbove: Infinity, bluffAtOrBelow: null, foldAfterOppRaises: Infinity })],
  ["Fold<.5R.7", makeStrategy({ foldBelow: 0.45, raiseAtOrAbove: 0.65, bluffAtOrBelow: null, foldAfterOppRaises: Infinity })],
];
const PROBE_NOTES: Record<string, string> = {
  "Fold0.3Call": "fold on 0.3, otherwise call, never raise",
  "Fold<.5R.7": "fold below 0.5, call on 0.5 and 0.6, raise on 0.7",
};

const AGENTS: [string, Agent][] = [...PRESET_NAMES.map((n): [string, Agent] => [n, PRESETS[n]]), ...PROBES];
const NAMES = AGENTS.map(([n]) => n);
const P = PRESET_NAMES.length;

/** Relations the preset loop must show: [winner, loser]. */
const EXPECTED_LOOP: [string, string][] = [
  ["Reckless", "Patient"],
  ["Steady", "Reckless"],
  ["Steady", "Patient"],
  ["Patient", "Tricky"],
  ["Tricky", "Reckless"],
  ["Tricky", "Steady"],
];

const ALL_RULESETS: Record<string, MatchRules> = {
  classic: CLASSIC_RULES,
  "raiser-risks-raise": RAISE_AT_RISK_RULES,
  "flip-for-ante": FLIP_FOR_ANTE_RULES,
};
const selected = process.env.BALANCE_RULES?.split(",") ?? Object.keys(ALL_RULESETS);

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
const pad = (s: string, n = 12) => s.padStart(n);

/** matrix[i][j] = average net of agent i against agent j, averaged over both seatings. */
function run(rules: MatchRules): number[][] {
  const master = mulberry32(MASTER_SEED);
  const seatA = AGENTS.map(([, a]) =>
    AGENTS.map(([, b]) => {
      let total = 0;
      for (let k = 0; k < MATCHES; k++) total += playMatch(a, b, { seed: nextUint32(master), rules }).nets.A;
      return total / MATCHES;
    }),
  );
  return seatA.map((row, i) => row.map((x, j) => (x - seatA[j]![i]!) / 2));
}

console.log(`${MATCHES} matches per ordered pairing, master seed ${MASTER_SEED}`);
for (const [note, text] of Object.entries(PROBE_NOTES)) console.log(`  ${note}: ${text}`);

for (const key of selected) {
  const rules = ALL_RULESETS[key];
  if (!rules) throw new Error(`unknown ruleset ${key}; expected one of ${Object.keys(ALL_RULESETS).join(", ")}`);
  const m = run(rules);
  const vsPresets = m.map((row) => row.slice(0, P).reduce((s, x) => s + x, 0) / P);

  console.log(`\n=== Rules: ${key} ===`);
  console.log("Average net of row vs column (both seatings):");
  console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join("") + pad("vs presets"));
  m.forEach((row, i) => {
    if (i === P) console.log(pad("-- probes --"));
    console.log(pad(NAMES[i]!) + row.slice(0, P).map((x) => pad(fmt(x))).join("") + pad(fmt(vsPresets[i]!)));
  });

  const idx = (n: string) => NAMES.indexOf(n);
  const presetAvgs = vsPresets.slice(0, P);
  const spread = Math.max(...presetAvgs) - Math.min(...presetAvgs);
  const loop = EXPECTED_LOOP.map(([w, l]) => ({ w, l, v: m[idx(w)]![idx(l)]! }));
  const brokenLoop = loop.filter((x) => x.v <= 0);

  const checks: [string, boolean, string][] = [];
  const ar = idx("AlwaysRaise");
  const arBeaten = m[ar]!.slice(0, P).filter((x) => x > 0).length;
  checks.push([
    "1. AlwaysRaise does not beat the presets",
    vsPresets[ar]! <= 0,
    `avg ${fmt(vsPresets[ar]!)}, beats ${arBeaten}/${P} presets`,
  ]);
  for (const [name] of PROBES.slice(1)) {
    const i = idx(name);
    const beaten = m[i]!.slice(0, P).filter((x) => x > 0).length;
    checks.push([
      `2. ${name} does not beat the preset field`,
      beaten < P && vsPresets[i]! <= 0,
      `avg ${fmt(vsPresets[i]!)}, beats ${beaten}/${P} presets`,
    ]);
  }
  checks.push([
    "3a. Preset loop holds",
    brokenLoop.length === 0,
    loop.map((x) => `${x.w}>${x.l} ${fmt(x.v)}`).join(", "),
  ]);
  checks.push([`3b. Preset spread < ${SPREAD_LIMIT}`, spread < SPREAD_LIMIT, `spread ${spread.toFixed(3)}`]);

  console.log("\nShip criteria:");
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
}
