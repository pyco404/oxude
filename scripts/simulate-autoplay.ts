import { mulberry32, netDistribution, PRESET_NAMES, PRESETS, type PresetName } from "../src/index.js";
import { STAKE_BANDS, STARTING_BALANCE, type BandName } from "../src/db/schema.js";

/**
 * Would a rental last a week of autoplay, or bust in the first hour?
 *
 * This simulates option B as built: bands are money scales, there is no
 * settlement clamp, and an agent must be able to cover its band's worst match
 * (A 30, B 60, C 90) to play in it at all. An agent starts at STARTING_BALANCE,
 * plays one match every PACE minutes against the house roster in its band, and
 * stops the moment its balance falls below that cover.
 *
 * Match outcomes are exact, not sampled hands: netDistribution enumerates every
 * edge draw and coin flip (src/exact.ts). A band is a uniform scale, so its net
 * distribution is band B's with every net multiplied by the band's factor -
 * exactly, not approximately, which is the whole reason bands are scales.
 *
 * What it assumes: opponents are drawn evenly from the four presets and can
 * always cover the match (the house roster is many agents, and matchmaking
 * skips anyone too poor). Real matchmaking pairs on rating instead, which
 * narrows the spread between presets but not the size of the swings.
 *
 * Usage: npx tsx scripts/simulate-autoplay.ts [--agents 20000] [--hours 168] [--pace 10]
 *        npx tsx scripts/simulate-autoplay.ts --emit    (rewrites src/survival.ts)
 *
 * `--emit` writes the table the rent screen quotes. The product must never
 * invent these numbers: they are measured here and generated into source, so
 * regenerating them is one command when the rules or the seed change.
 */

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const AGENTS = arg("--agents", 20_000);
const HOURS = arg("--hours", 168);
const START = arg("--start", STARTING_BALANCE);
const PACE = arg("--pace", 10);
/**
 * The seed for every run. Fixed, so the same code always produces the same
 * table: these numbers are quoted to players on the rent screen and written
 * into docs/economy.md, and they must not move unless a rule moves.
 *
 * It must never be derived from a tuning constant. An earlier version seeded
 * from `band.worstMatch`, so changing the cover rule reshuffled the random
 * stream at the same time as it changed the game - which made a reseeding
 * artefact indistinguishable from a real effect. Seeds come from positions in
 * the band, preset and starting-balance lists, which are stable.
 */
const SEED = arg("--seed", 0x5eed);
const EMIT = process.argv.includes("--emit");
const MATCHES = Math.floor((HOURS * 60) / PACE);

/**
 * Draws from a distribution in constant time, exactly: Vose's alias method,
 * which keeps each outcome's probability rather than rounding it into buckets.
 */
function sampler(dist: Map<number, number>) {
  const nets = [...dist.keys()];
  const n = nets.length;
  const scaled = nets.map((net) => dist.get(net)! * n);
  const prob = new Float64Array(n);
  const alias = new Int32Array(n);
  const small: number[] = [];
  const large: number[] = [];
  scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
  while (small.length && large.length) {
    const l = small.pop()!;
    const g = large.pop()!;
    prob[l] = scaled[l]!;
    alias[l] = g;
    scaled[g] = scaled[g]! + scaled[l]! - 1;
    (scaled[g]! < 1 ? small : large).push(g);
  }
  for (const i of [...small, ...large]) prob[i] = 1;
  return (rng: () => number): number => {
    const u = rng() * n;
    const i = u | 0;
    return nets[u - i < prob[i]! ? i : alias[i]!]!;
  };
}

/** One match's net for this preset against an even mix of the roster, at band B. */
function mixedNetDistribution(preset: PresetName): Map<number, number> {
  const mixed = new Map<number, number>();
  for (const opponent of PRESET_NAMES) {
    const dist = netDistribution(PRESETS[preset], PRESETS[opponent]);
    for (const [net, p] of dist) mixed.set(net, (mixed.get(net) ?? 0) + p / PRESET_NAMES.length);
  }
  return mixed;
}

/** The same distribution at another band's scale: every net times the factor. */
function atBand(dist: Map<number, number>, factor: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const [net, p] of dist) out.set(net * factor, (out.get(net * factor) ?? 0) + p);
  return out;
}

const stats = (dist: Map<number, number>) => {
  const mean = [...dist].reduce((s, [net, p]) => s + net * p, 0);
  const variance = [...dist].reduce((s, [net, p]) => s + p * (net - mean) ** 2, 0);
  return { mean, sd: Math.sqrt(variance) };
};

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * Plays one agent until it can no longer cover its band's worst match, or until
 * the horizon. Returns the match it stopped on, or null if it lasted.
 */
function playToBust(draw: (rng: () => number) => number, cover: number, matches: number, rng: () => number, start: number) {
  let balance = start;
  for (let played = 1; played <= matches; played++) {
    balance += draw(rng);
    if (balance < cover) return played;
  }
  return null;
}

console.log(`Option B autoplay: bands are money scales, no clamp, one match per ${PACE} min over ${HOURS}h (${MATCHES} matches).`);
console.log(`${AGENTS.toLocaleString()} agents per preset per band, starting balance ${START}.`);
console.log(`An agent stops when it can no longer cover its band's worst match.\n`);

console.log("Per match at band B, exactly, against an even mix of the roster:");
for (const preset of PRESET_NAMES) {
  const { mean, sd } = stats(mixedNetDistribution(preset));
  console.log(`  ${preset.padEnd(7)} expected ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}  swing (sd) ${sd.toFixed(1)}`);
}

console.log(`\n${"band".padEnd(6)}${"stakes".padEnd(14)}${"worst".padEnd(7)}${"cover".padEnd(7)}${"survive".padStart(9)}${"median matches".padStart(16)}${"median time".padStart(14)}`);
const survivalByBand = new Map<
  BandName,
  { overall: number; byPreset: Map<PresetName, number>; medianMatches: number | null; medianHours: number | null }
>();

for (const [bandIndex, band] of STAKE_BANDS.entries()) {
  const cover = band.worstMatch;
  const byPreset = new Map<PresetName, number>();
  const allBusts: (number | null)[] = [];
  for (const preset of PRESET_NAMES) {
    const draw = sampler(atBand(mixedNetDistribution(preset), band.factor));
    const rng = mulberry32(SEED + bandIndex * 977 + PRESET_NAMES.indexOf(preset) * 31);
    let survived = 0;
    for (let i = 0; i < AGENTS; i++) {
      const bust = playToBust(draw, cover, MATCHES, rng, START);
      allBusts.push(bust);
      if (bust === null) survived++;
    }
    byPreset.set(preset, survived / AGENTS);
  }
  const survivedAll = allBusts.filter((b) => b === null).length;
  const overall = survivedAll / allBusts.length;
  const busted = allBusts.filter((b): b is number => b !== null);
  const medMatches = median(busted);
  survivalByBand.set(band.name, {
    overall,
    byPreset,
    medianMatches: medMatches,
    medianHours: medMatches === null ? null : (medMatches * PACE) / 60,
  });
  const medTime = medMatches === null ? "—" : `${((medMatches * PACE) / 60).toFixed(1)} h`;
  const stakes = `${band.ante}/${band.baseBet}/${band.raisedBet}`;
  console.log(
    `${band.name.padEnd(6)}${stakes.padEnd(14)}${String(band.worstMatch).padEnd(7)}${String(cover).padEnd(7)}` +
      `${`${(overall * 100).toFixed(1)}%`.padStart(9)}${String(medMatches ?? "—").padStart(16)}${medTime.padStart(14)}`,
  );
}

console.log(`\nSurvival by preset (${HOURS}h at one match per ${PACE} min):`);
console.log(`  band  ${PRESET_NAMES.map((p) => p.padStart(9)).join("")}${"spread".padStart(11)}`);
for (const band of STAKE_BANDS) {
  const byPreset = survivalByBand.get(band.name)!.byPreset;
  const rates = PRESET_NAMES.map((p) => byPreset.get(p)!);
  const spread = Math.max(...rates) - Math.min(...rates);
  console.log(
    `  ${band.name.padEnd(5)} ${rates.map((r) => `${(r * 100).toFixed(1)}%`.padStart(9)).join("")}${`${(spread * 100).toFixed(1)} pts`.padStart(11)}`,
  );
}

// What a different seed would buy, so the 900 choice can be judged against its
// neighbours rather than taken on faith.
const STARTS = [360, 540, 720, 900, 1080, 1350, 1800];
console.log(`\nSurvival over ${HOURS}h by starting balance (averaged over the presets):`);
console.log(`  band  ${STARTS.map((b) => String(b).padStart(9)).join("")}`);
const sweepByBand = new Map<BandName, number[]>();
for (const [bandIndex, band] of STAKE_BANDS.entries()) {
  const means = STARTS.map((start, startIndex) => {
    const rates = PRESET_NAMES.map((preset, i) => {
      const draw = sampler(atBand(mixedNetDistribution(preset), band.factor));
      const rng = mulberry32(SEED + 0xc0ffee + bandIndex * 7919 + i * 131 + startIndex * 31);
      let survived = 0;
      for (let k = 0; k < AGENTS; k++) if (playToBust(draw, band.worstMatch, MATCHES, rng, start) === null) survived++;
      return survived / AGENTS;
    });
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  });
  sweepByBand.set(band.name, means);
  console.log(`  ${band.name.padEnd(5)} ${means.map((m) => `${(m * 100).toFixed(1)}%`.padStart(9)).join("")}`);
}

// ---------------------------------------------------------------------------
// The generated table. The rent screen quotes these, so they are measured here
// and written into source rather than typed in by hand.
// ---------------------------------------------------------------------------
if (EMIT) {
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const entries = STAKE_BANDS.map((band) => {
    const row = survivalByBand.get(band.name)!;
    const rates = PRESET_NAMES.map((p) => pct(row.byPreset.get(p)!));
    const byPreset = PRESET_NAMES.map((p, i) => `      ${p}: ${rates[i]!.toFixed(1)},`).join("\n");
    return `  ${band.name}: {
    overall: ${pct(row.overall).toFixed(1)},
    low: ${Math.min(...rates).toFixed(1)},
    high: ${Math.max(...rates).toFixed(1)},
    medianMatches: ${row.medianMatches ?? "null"},
    medianHours: ${row.medianHours === null ? "null" : row.medianHours.toFixed(1)},
    byPreset: {
${byPreset}
    },
  },`;
  }).join("\n");

  const sweepRows = STAKE_BANDS.map(
    (band) => `  ${band.name}: [${sweepByBand.get(band.name)!.map((m) => pct(m).toFixed(1)).join(", ")}],`,
  ).join("\n");

  const file = `// Generated by scripts/simulate-autoplay.ts --emit. Do not edit by hand.
//
// How often a rental lasts a week of autoplay, measured over ${AGENTS.toLocaleString()} agents per
// preset per band: one match every ${PACE} minutes for ${HOURS} hours from a starting
// balance of ${START}, with no settlement clamp, stopping when the agent can no
// longer cover its band's worst match. Outcomes are exact, not sampled, and the
// run is seeded with ${SEED}, so this file is reproducible: the same code always
// writes the same numbers.
//
// The rent screen and docs/economy.md both quote these, and neither may state a
// survival figure that is not in this file.
//
// Regenerate with: npx tsx scripts/simulate-autoplay.ts --emit
import type { PresetName } from "./presets.js";
import type { BandName } from "./db/schema.js";

export type BandSurvival = {
  /** Percentage of agents still playing after a week, across all presets. */
  overall: number;
  /** The worst and best preset in this band, for agents with no preset. */
  low: number;
  high: number;
  /** Half of the agents that busted had gone by here. */
  medianMatches: number | null;
  medianHours: number | null;
  byPreset: Record<PresetName, number>;
};

export const SURVIVAL_HOURS = ${HOURS};
export const SURVIVAL_PACE_MINUTES = ${PACE};
export const SURVIVAL_SEED_BALANCE = ${START};
/** The RNG seed this table was generated with. */
export const SURVIVAL_RNG_SEED = ${SEED};

export const SURVIVAL: Record<BandName, BandSurvival> = {
${entries}
};

/**
 * The starting balances swept, and survival at each one averaged over the four
 * presets. This is what a deposit-funded rental would need: on mainnet the
 * player picks the amount, so the 900 column stops being the only one that
 * matters. Percentages, in the same order as SURVIVAL_SEEDS_SWEPT.
 */
export const SURVIVAL_SEEDS_SWEPT = [${STARTS.join(", ")}] as const;

export const SURVIVAL_BY_SEED: Record<BandName, number[]> = {
${sweepRows}
};

/** What to tell someone renting this preset in this band, as a percentage. */
export function survivalFor(band: BandName, preset: PresetName | null): { low: number; high: number } {
  const row = SURVIVAL[band];
  if (preset === null) return { low: row.low, high: row.high };
  const exact = row.byPreset[preset];
  return { low: exact, high: exact };
}
`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync("src/survival.ts", file);
  console.log("\nwrote src/survival.ts");
}
