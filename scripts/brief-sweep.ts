import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OXUDE_RULES,
  policyAgent,
  PRESET_NAMES,
  PRESETS,
  seatAveragedNet,
  validatePolicy,
  SITUATIONS,
  EDGE_KEYS,
  type Policy,
} from "../src/index.js";
import { elicitPolicy, type PolicyCallLog } from "../src/agents/llm.js";

// Asks the model for one policy per brief, then rates every table with the
// exact calculator. The question this answers: does the brief change how the
// model plays, or does it play its own way regardless?
//
// Usage: ANTHROPIC_API_KEY=... npm run brief-sweep [-- --force] [-- --dry-run]
// Results are cached per brief, so a rerun costs nothing for briefs already done.

const OUT = "policies/elicited";
const LOGS = ".search-results/brief-logs";
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

export const BRIEFS: { name: string; text: string }[] = [
  { name: "minimal", text: "" },
  { name: "aggressive", text: "Play aggressively. Put your opponent under pressure and make them fold." },
  { name: "cautious", text: "Play cautiously. Protect your stack and avoid unnecessary risk." },
  { name: "deceptive", text: "Be deceptive. Your opponent cannot see your edge, so make your play hard to read." },
  { name: "maximise", text: "Maximise expected value. Nothing else matters." },
  { name: "never-fold", text: "Folding is for cowards. Never give up a round without a fight." },
  { name: "exploit-bully", text: "Your opponent raises almost every round and folds when raised at. Beat that opponent." },
  { name: "exploit-caller", text: "Your opponent calls almost everything and rarely folds. Beat that opponent." },
  { name: "nonsense", text: "The moon is in Capricorn and the tide is out. Let the colour of the cards guide you toward harmony." },
  { name: "contradictory", text: "Be extremely aggressive and extremely cautious at the same time. Never fold, but avoid all risk." },
];

/** Deterministic stand-in so the pipeline can be exercised without spending anything. */
function stubClient(seedText: string) {
  let h = 0;
  for (const c of seedText) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pick = (i: number) => (["fold", "call", "raise"] as const)[(h >>> (i % 8)) % 3]!;
  const parsed = Object.fromEntries(
    SITUATIONS.map((s, si) => [s, Object.fromEntries(EDGE_KEYS.map((k, ki) => [k, pick(si * 5 + ki)]))]),
  );
  return {
    messages: {
      parse: async () => ({
        content: [{ type: "text", text: JSON.stringify(parsed) }],
        usage: { input_tokens: 700, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        stop_reason: "end_turn",
        parsed_output: parsed,
      }),
    },
  } as never;
}

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

type Row = { name: string; policy: Policy; cells: number[]; field: number; cost: number; fallback: string | null };
const rows: Row[] = [];
let spend = 0;

for (const brief of BRIEFS) {
  const policyPath = join(OUT, `${brief.name}.json`);
  let policy: Policy | null = null;
  let cost = 0;
  let fallback: string | null = null;

  if (existsSync(policyPath) && !force) {
    policy = validatePolicy(JSON.parse(readFileSync(policyPath, "utf8")));
    console.log(`${brief.name.padEnd(14)} cached`);
  } else {
    const { log } = await elicitPolicy({
      ...(brief.text ? { brief: brief.text } : {}),
      ...(dryRun ? { client: stubClient(brief.name) } : {}),
      onLog: (entry: PolicyCallLog) =>
        writeFileSync(join(LOGS, `${brief.name}.json`), JSON.stringify(entry, null, 1)),
    });
    cost = log.costUsd;
    spend += cost;
    fallback = log.fallback ? `${log.fallback.preset}: ${log.fallback.reason}` : null;
    if (log.policy) {
      policy = log.policy;
      writeFileSync(policyPath, JSON.stringify({ _brief: brief.text, ...log.policy }, null, 1) + "\n");
    }
    console.log(
      `${brief.name.padEnd(14)} ${log.latencyMs}ms $${cost.toFixed(4)}${fallback ? `  FALLBACK ${fallback}` : ""}`,
    );
  }
  if (!policy) continue;

  const agent = policyAgent(policy);
  const cells = PRESET_NAMES.map((n) => seatAveragedNet(agent, PRESETS[n], OXUDE_RULES));
  rows.push({ name: brief.name, policy, cells, field: cells.reduce((a, b) => a + b, 0) / cells.length, cost, fallback });
}

const pad = (s: string, n = 11) => s.padStart(n);
const fmt = (x: number) => (Math.abs(x) < 1e-9 ? " 0.000" : (x >= 0 ? "+" : "") + x.toFixed(3));
rows.sort((a, b) => b.field - a.field);

console.log(`\nExact expected net per match against the shipped presets${dryRun ? " (DRY RUN - stub tables, not the model)" : ""}:`);
console.log(pad("brief", 15) + PRESET_NAMES.map((n) => pad(n)).join("") + pad("field") + "   beats");
for (const r of rows) {
  const beaten = PRESET_NAMES.filter((_, i) => r.cells[i]! > 1e-9);
  console.log(pad(r.name, 15) + r.cells.map((c) => pad(fmt(c))).join("") + pad(fmt(r.field)) + "   " + (beaten.join(",") || "none"));
}

if (rows.length > 1) {
  const fields = rows.map((r) => r.field);
  const spread = Math.max(...fields) - Math.min(...fields);
  // How much do the tables themselves differ? 30 cells per policy.
  const cellCount = SITUATIONS.length * EDGE_KEYS.length;
  let differing = 0;
  let pairs = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      pairs++;
      for (const s of SITUATIONS) {
        for (const k of EDGE_KEYS) if (rows[i]!.policy[s][k] !== rows[j]!.policy[s][k]) differing++;
      }
    }
  }
  console.log(`\nSpread across briefs: ${spread.toFixed(3)} (best ${rows[0]!.name} ${fmt(rows[0]!.field)}, worst ${rows[rows.length - 1]!.name} ${fmt(rows[rows.length - 1]!.field)})`);
  console.log(`Tables differ on ${(differing / pairs).toFixed(1)} of ${cellCount} cells on average between two briefs.`);
  console.log(`For scale: the four presets span ${(0.084 - -0.053).toFixed(3)} against the same field, and AlwaysRaise sits at -1.479.`);
  console.log(`Total spent this run: $${spend.toFixed(4)}`);
}
