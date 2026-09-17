import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  makeStrategy,
  OXUDE_RULES,
  policyAgent,
  PRESET_NAMES,
  PRESETS,
  seatAveragedNet,
  validatePolicy,
  type Agent,
  type Stakes,
} from "../src/index.js";

// Scores policy tables against the shipped presets with the exact calculator,
// on the same scale the presets are balanced on.
// Usage: npm run score-policies [-- <dir or file>...]

const stakes: Stakes = OXUDE_RULES.stakes;
const opts = { stakes, turnOrder: OXUDE_RULES.turnOrder, deal: OXUDE_RULES.deal } as const;
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const paths = (args.length ? args : ["policies"]).flatMap((p) =>
  p.endsWith(".json") ? [p] : readdirSync(p).filter((f) => f.endsWith(".json")).map((f) => join(p, f)),
);

const entrants: [string, Agent, string][] = paths.map((path) => {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { _brief?: string };
  return [basename(path, ".json"), policyAgent(validatePolicy(raw)), raw._brief ?? ""];
});

/** Reference points: the simple strategies the presets already beat. */
const BASELINES: [string, Agent][] = [
  ["AlwaysRaise", () => "raise"],
  ["AlwaysCall", () => "call"],
  ["PotOddsBot", makeStrategy({ foldBelow: "pot-odds", raiseAtOrAbove: 0.55, bluffAtOrBelow: null, bluffUnderPressure: false, pressureFoldBelow: "pot-odds", foldToRaiseBelow: "pot-odds" })],
];

const pad = (s: string, n = 11) => s.padStart(n);
const fmt = (x: number) => (Math.abs(x) < 1e-9 ? " 0.000" : (x >= 0 ? "+" : "") + x.toFixed(3));

console.log(`Exact expected net per match against the shipped presets (${opts.turnOrder}, ${opts.deal}, ante ${stakes.ante}).`);
console.log(pad("entrant", 14) + PRESET_NAMES.map((n) => pad(n)).join("") + pad("field") + pad("beats"));
const rows: [string, number[], string][] = [];
for (const [name, agent, brief] of [...entrants, ...BASELINES.map(([n, a]): [string, Agent, string] => [n, a, "baseline"])]) {
  const cells = PRESET_NAMES.map((n) => seatAveragedNet(agent, PRESETS[n], opts));
  rows.push([name, cells, brief]);
  const avg = cells.reduce((a, b) => a + b, 0) / cells.length;
  const beaten = PRESET_NAMES.filter((_, i) => cells[i]! > 1e-9);
  console.log(pad(name, 14) + cells.map((c) => pad(fmt(c))).join("") + pad(fmt(avg)) + pad(beaten.length ? beaten.join(",") : "none", 18));
}

console.log(`\nFor scale, the presets against each other:`);
console.log(pad("preset", 14) + PRESET_NAMES.map((n) => pad(n)).join("") + pad("field"));
for (const p of PRESET_NAMES) {
  const cells = PRESET_NAMES.map((n) => seatAveragedNet(PRESETS[p], PRESETS[n], opts));
  console.log(pad(p, 14) + cells.map((c) => pad(fmt(c))).join("") + pad(fmt(cells.reduce((a, b) => a + b, 0) / 4)));
}

const briefs = entrants.filter(([, , b]) => b);
if (briefs.length) {
  console.log(`\nBriefs:`);
  for (const [name, , brief] of briefs) console.log(`  ${name}: ${brief}`);
}
