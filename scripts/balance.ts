import { mulberry32, nextUint32, playMatch, PRESET_NAMES, PRESETS } from "../src/index.js";
import { agentsFor, analyse, fmt, NAMES, P, PROBE_NOTES, stakesFromEnv } from "./analysis.js";

// Usage: npm run balance [-- --no-sim]; ANTE=5 RAISED_BET=25 BASE_BET=10 BALANCE_SEED=1 to vary.
const MATCHES = 20_000;
const MASTER_SEED = Number(process.env.BALANCE_SEED ?? 0x0de5eed);
const SIMULATE = !process.argv.includes("--no-sim");

const stakes = stakesFromEnv();
const a = analyse(stakes);
const pad = (s: string, n = 12) => s.padStart(n);

console.log(`Stakes: ante ${stakes.ante}, base bet ${stakes.baseBet}, raised bet ${stakes.raisedBet}`);
for (const [name, text] of Object.entries(PROBE_NOTES)) console.log(`  ${name}: ${text}`);

console.log("\nExact expected net of row vs column (both seatings):");
console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join("") + pad("vs presets"));
a.matrix.forEach((row, i) => {
  if (i === P) console.log(pad("-- probes --"));
  console.log(pad(NAMES[i]!) + row.map((x) => pad(fmt(x))).join("") + pad(fmt(a.field[i]!.avg)));
});

console.log("\nShip criteria (exact):");
for (const c of a.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}: ${c.detail}`);

if (SIMULATE) {
  // Cross-check: simulated seat-averaged means should sit within a few standard errors of exact.
  const master = mulberry32(MASTER_SEED);
  let worst = { z: 0, label: "" };
  for (const [i, [rowName, agent]] of agentsFor(PRESETS).entries()) {
    for (const [j, colName] of PRESET_NAMES.entries()) {
      if (rowName === colName) continue;
      let sum = 0;
      let sq = 0;
      for (let k = 0; k < MATCHES; k++) {
        const asA = playMatch(agent, PRESETS[colName], { seed: nextUint32(master), stakes }).nets.A;
        const asB = -playMatch(PRESETS[colName], agent, { seed: nextUint32(master), stakes }).nets.A;
        const net = (asA + asB) / 2;
        sum += net;
        sq += net * net;
      }
      const mean = sum / MATCHES;
      const se = Math.sqrt((sq / MATCHES - mean * mean) / MATCHES);
      const z = Math.abs(mean - a.matrix[i]![j]!) / se;
      if (z > worst.z) worst = { z, label: `${rowName} vs ${colName}: sim ${fmt(mean)} exact ${fmt(a.matrix[i]![j]!)}` };
    }
  }
  const verdict = worst.z < 4 ? "agrees" : "DISAGREES";
  console.log(`\nSimulation cross-check (${MATCHES} matches per seating, seed ${MASTER_SEED}): ${verdict}`);
  console.log(`  largest deviation ${worst.z.toFixed(2)} standard errors (${worst.label})`);
}
