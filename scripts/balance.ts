import { mulberry32, nextUint32, playMatch, PRESET_NAMES, PRESETS, type PresetName } from "../src/index.js";

const MATCHES = 20_000;
const MASTER_SEED = Number(process.env.BALANCE_SEED ?? 0x0de5eed);

// seatA[i][j] = average net of preset i sitting as A against preset j as B.
const seatA: number[][] = PRESET_NAMES.map(() => PRESET_NAMES.map(() => 0));
const master = mulberry32(MASTER_SEED);

for (const [i, a] of PRESET_NAMES.entries()) {
  for (const [j, b] of PRESET_NAMES.entries()) {
    let total = 0;
    for (let k = 0; k < MATCHES; k++) {
      const log = playMatch(PRESETS[a], PRESETS[b], { seed: nextUint32(master) });
      total += log.nets.A;
    }
    seatA[i]![j] = total / MATCHES;
  }
}

// Seat-averaged: i's net vs j over both seatings (i as A, and i as B where B's net = -A's net).
const matrix = PRESET_NAMES.map((_, i) => PRESET_NAMES.map((_, j) => (seatA[i]![j]! - seatA[j]![i]!) / 2));
const overall = matrix.map((row) => row.reduce((s, x) => s + x, 0) / row.length);

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
const pad = (s: string, n = 10) => s.padStart(n);

function printMatrix(title: string, m: number[][]) {
  console.log(`\n${title}`);
  console.log(pad("row vs col") + PRESET_NAMES.map((n) => pad(n)).join(""));
  for (const [i, name] of PRESET_NAMES.entries()) {
    console.log(pad(name) + m[i]!.map((x) => pad(fmt(x))).join(""));
  }
}

console.log(`${MATCHES} matches per ordered pairing, master seed ${MASTER_SEED}`);
printMatrix("Row preset seated as A (raw):", seatA);
printMatrix("Average net of row vs column (both seatings):", matrix);

console.log("\nOverall average net (both seatings):");
const ranked = PRESET_NAMES.map((n, i) => [n, overall[i]!] as [PresetName, number]).sort((x, y) => y[1] - x[1]);
for (const [name, avg] of ranked) console.log(`${pad(name)} ${fmt(avg)}`);
const spread = ranked[0]![1] - ranked[ranked.length - 1]![1];
console.log(`\nSpread best-worst: ${spread.toFixed(3)}`);

console.log("\nHead-to-head:");
for (let i = 0; i < PRESET_NAMES.length; i++) {
  for (let j = i + 1; j < PRESET_NAMES.length; j++) {
    const v = matrix[i]![j]!;
    const [w, l] = v >= 0 ? [PRESET_NAMES[i], PRESET_NAMES[j]] : [PRESET_NAMES[j], PRESET_NAMES[i]];
    console.log(`  ${w} beats ${l} by ${Math.abs(v).toFixed(3)}`);
  }
}
