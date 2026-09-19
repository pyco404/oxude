import { mulberry32, netDistribution, PRESET_NAMES, PRESETS, type PresetName } from "../src/index.js";
import { CEILING_BANDS, MIN_STAKE, STARTING_BALANCE } from "../src/db/schema.js";

/**
 * Would autoplay last a rental, or bust in the first hour?
 *
 * An agent starts at the starting balance, plays a match every so often
 * against the house roster in its band, and stops when it cannot cover the
 * minimum stake. Match outcomes come from the exact calculator: every edge
 * draw and flip enumerated (src/exact.ts), not sampled hands, so the only
 * randomness here is which outcome a match lands on.
 *
 * What it assumes: opponents are drawn evenly from the four presets and can
 * always cover the stake (the house roster is many agents and matchmaking
 * skips anyone too poor to play), and the agent plays its ceiling, which is
 * its band's maximum. Real matchmaking pairs on rating rather than evenly,
 * which narrows the spread between presets but not the size of the swings.
 *
 * Usage: npx tsx scripts/simulate-autoplay.ts [--agents 20000] [--hours 168]
 */

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const AGENTS = arg("--agents", 20_000);
const HOURS = arg("--hours", 168);
/** Minutes between matches. */
const PACES = [3, 5, 10, 15, 30];
const CEILINGS = CEILING_BANDS.map((b) => b.max);

/**
 * Draws from a distribution in constant time, exactly: Vose's alias method,
 * which keeps each outcome's probability rather than rounding it into buckets.
 * The edge here is hundredths of a chip a match, so rounding would drown it.
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

/** One match's net for this preset against an even mix of the roster, exactly. */
function mixedNetDistribution(preset: PresetName): Map<number, number> {
  const mixed = new Map<number, number>();
  for (const opponent of PRESET_NAMES) {
    const dist = netDistribution(PRESETS[preset], PRESETS[opponent]);
    for (const [net, p] of dist) mixed.set(net, (mixed.get(net) ?? 0) + p / PRESET_NAMES.length);
  }
  return mixed;
}

/**
 * What a match is worth once the ceiling clamps it. A ceiling cuts wins as
 * well as losses, so a preset that wins in big lumps and loses in small ones
 * is worth less in a low band than its raw expected net suggests.
 */
const clampedMean = (dist: Map<number, number>, stake: number) =>
  [...dist].reduce((s, [net, p]) => s + p * Math.max(-stake, Math.min(stake, net)), 0);

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
 * Plays one agent to the horizon or to bust, and returns the match it busted
 * on (or null). The longest pace decides how many matches fit, and every
 * shorter pace is a prefix of the same run: an agent that busts on match 400
 * busted at every pace, just at a different hour.
 */
function playToBust(
  draw: (rng: () => number) => number,
  ceiling: number,
  matches: number,
  rng: () => number,
  options: { start?: number; fraction?: number } = {},
): number | null {
  let balance = options.start ?? STARTING_BALANCE;
  for (let played = 1; played <= matches; played++) {
    // A fraction, when asked for: stake with the balance rather than a fixed ceiling.
    const wanted = options.fraction ? Math.max(MIN_STAKE, Math.round(balance * options.fraction)) : ceiling;
    const stake = Math.min(balance, wanted, ceiling);
    const net = draw(rng);
    balance += Math.max(-stake, Math.min(stake, net));
    if (balance < MIN_STAKE) return played;
  }
  return null;
}

const matchesAt = (paceMinutes: number) => Math.floor((HOURS * 60) / paceMinutes);
const longest = matchesAt(Math.min(...PACES));

console.log(`Autoplay over ${HOURS}h, ${AGENTS.toLocaleString()} agents per case, starting balance ${STARTING_BALANCE}, bust below ${MIN_STAKE}.`);
console.log(`Match outcomes are exact (every draw and flip enumerated); opponents are an even mix of the four presets.\n`);

console.log("Per match, exactly, against the roster:");
for (const preset of PRESET_NAMES) {
  const { mean, sd } = stats(mixedNetDistribution(preset));
  console.log(`  ${preset.padEnd(7)} expected ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}  swing (sd) ${sd.toFixed(1)}`);
}

for (const ceiling of CEILINGS) {
  const band = CEILING_BANDS.find((b) => b.max === ceiling)!.name;
  console.log(`\n\nBand ${band} (ceiling ${ceiling}) — a match stakes the lower of the two ceilings and what both can cover`);

  // Bust times for every preset, from one run each at the finest pace.
  const bustsByPreset = new Map<PresetName, (number | null)[]>();
  for (const preset of PRESET_NAMES) {
    const draw = sampler(mixedNetDistribution(preset));
    const rng = mulberry32(0x5eed + ceiling * 977 + PRESET_NAMES.indexOf(preset) * 31);
    const busts: (number | null)[] = [];
    for (let i = 0; i < AGENTS; i++) busts.push(playToBust(draw, ceiling, longest, rng));
    bustsByPreset.set(preset, busts);
  }
  const all = [...bustsByPreset.values()].flat();

  console.log("  per match at this ceiling, after clamping:");
  for (const preset of PRESET_NAMES) {
    const dist = mixedNetDistribution(preset);
    const clamped = clampedMean(dist, ceiling);
    console.log(
      `    ${preset.padEnd(7)} raw ${stats(dist).mean >= 0 ? "+" : ""}${stats(dist).mean.toFixed(3)}  ->  clamped ${clamped >= 0 ? "+" : ""}${clamped.toFixed(3)}`,
    );
  }
  console.log(`  pace     matches   survive 168h   median matches to bust   median time to bust`);
  for (const pace of PACES) {
    const matches = matchesAt(pace);
    // Busting later than this pace's horizon means surviving it.
    const bustedWithin = all.filter((b): b is number => b !== null && b <= matches);
    const survived = all.length - bustedWithin.length;
    const medianMatches = median(bustedWithin);
    const hours = medianMatches === null ? null : (medianMatches * pace) / 60;
    const time = hours === null ? "—" : hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`;
    console.log(
      `  ${String(pace).padStart(2)} min  ${String(matches).padStart(7)}   ${((survived / all.length) * 100).toFixed(1).padStart(10)}%   ${String(medianMatches ?? "—").padStart(22)}   ${time.padStart(19)}`,
    );
  }

  // Where the presets differ, at the pace that plays the most matches.
  const matches = longest;
  console.log(`  by preset, at ${Math.min(...PACES)} min (${matches} matches):`);
  for (const preset of PRESET_NAMES) {
    const busts = bustsByPreset.get(preset)!;
    const bustedWithin = busts.filter((b): b is number => b !== null && b <= matches);
    const survived = busts.length - bustedWithin.length;
    console.log(
      `    ${preset.padEnd(7)} survive ${((survived / busts.length) * 100).toFixed(1).padStart(5)}%   median matches to bust ${String(median(bustedWithin) ?? "—").padStart(6)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// What would keep most of them alive? Same machinery, two levers: how much of
// its balance an agent stakes, and how much it starts with.
// ---------------------------------------------------------------------------

const survivalRate = (
  preset: PresetName,
  ceiling: number,
  matches: number,
  options: { start?: number; fraction?: number },
  seed: number,
) => {
  const draw = sampler(mixedNetDistribution(preset));
  const rng = mulberry32(seed);
  let survived = 0;
  for (let i = 0; i < AGENTS; i++) if (playToBust(draw, ceiling, matches, rng, options) === null) survived++;
  return survived / AGENTS;
};

const across = (ceiling: number, matches: number, options: { start?: number; fraction?: number }) => {
  const rates = PRESET_NAMES.map((p, i) => survivalRate(p, ceiling, matches, options, 0xc0ffee + i * 131 + ceiling));
  return rates.reduce((a, b) => a + b, 0) / rates.length;
};

console.log(`\n\nStaking a fraction of the balance instead of a flat ceiling (survival over ${HOURS}h, averaged over the presets)`);
console.log("  pace     matches   flat ceiling      20%      10%       5%");
for (const pace of PACES) {
  const matches = matchesAt(pace);
  const ceiling = 20;
  const flat = across(ceiling, matches, {});
  const cells = [0.2, 0.1, 0.05].map((f) => `${(across(ceiling, matches, { fraction: f }) * 100).toFixed(1)}%`.padStart(8));
  console.log(`  ${String(pace).padStart(2)} min  ${String(matches).padStart(7)}   ${`${(flat * 100).toFixed(1)}%`.padStart(12)} ${cells.join(" ")}`);
}
console.log("  (band 10-20; a stake is never below the minimum of 10, which is what still busts them)");

console.log(`\n\nStarting balance, flat ceiling 20 (survival over ${HOURS}h, averaged over the presets)`);
console.log("  pace     matches       180      360      720     1440");
for (const pace of PACES) {
  const matches = matchesAt(pace);
  const cells = [180, 360, 720, 1440].map((start) => `${(across(20, matches, { start }) * 100).toFixed(1)}%`.padStart(8));
  console.log(`  ${String(pace).padStart(2)} min  ${String(matches).padStart(7)} ${cells.join(" ")}`);
}
