import {
  CLASSIC_RULES,
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

/** Presets plus probe agents that are not presets. */
const AGENTS: [string, Agent][] = [
  ...PRESET_NAMES.map((n): [string, Agent] => [n, PRESETS[n]]),
  ["AlwaysRaise", () => "raise"],
];
const NAMES = AGENTS.map(([n]) => n);

const RULESETS: [string, MatchRules][] = [
  ["Classic rules", CLASSIC_RULES],
  ["Raise-at-risk rules (fold to a raise still flips)", RAISE_AT_RISK_RULES],
];

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
const pad = (s: string, n = 12) => s.padStart(n);

function run(rules: MatchRules) {
  const master = mulberry32(MASTER_SEED);
  // seatA[i][j] = average net of agent i sitting as A against agent j as B.
  const seatA = AGENTS.map(([, a]) =>
    AGENTS.map(([, b]) => {
      let total = 0;
      for (let k = 0; k < MATCHES; k++) total += playMatch(a, b, { seed: nextUint32(master), rules }).nets.A;
      return total / MATCHES;
    }),
  );
  // Seat-averaged: i's net vs j over both seatings (B's net = -A's net).
  const matrix = seatA.map((row, i) => row.map((x, j) => (x - seatA[j]![i]!) / 2));
  return { seatA, matrix };
}

function printMatrix(m: number[][], withOverall: number) {
  console.log(pad("row vs col") + NAMES.map((n) => pad(n)).join("") + pad("presets avg"));
  m.forEach((row, i) => {
    const avg = row.slice(0, withOverall).reduce((s, x) => s + x, 0) / withOverall;
    console.log(pad(NAMES[i]!) + row.map((x) => pad(fmt(x))).join("") + pad(fmt(avg)));
  });
}

console.log(`${MATCHES} matches per ordered pairing, master seed ${MASTER_SEED}`);
const presetCount = PRESET_NAMES.length;

for (const [title, rules] of RULESETS) {
  const { matrix } = run(rules);
  console.log(`\n=== ${title} ===`);
  console.log("Average net of row vs column (both seatings); 'presets avg' = mean over the preset columns:");
  printMatrix(matrix, presetCount);

  // Preset-only view: the loop and spread as originally specified.
  const overall = PRESET_NAMES.map((_, i) => matrix[i]!.slice(0, presetCount).reduce((s, x) => s + x, 0) / presetCount);
  const spread = Math.max(...overall) - Math.min(...overall);
  console.log(`Preset spread best-worst (presets only): ${spread.toFixed(3)}`);
  const beats: string[] = [];
  for (let i = 0; i < presetCount; i++) {
    for (let j = i + 1; j < presetCount; j++) {
      const v = matrix[i]![j]!;
      const [w, l] = v >= 0 ? [NAMES[i], NAMES[j]] : [NAMES[j], NAMES[i]];
      beats.push(`${w} > ${l} (${Math.abs(v).toFixed(2)})`);
    }
  }
  console.log(`Head-to-head: ${beats.join(", ")}`);
}
