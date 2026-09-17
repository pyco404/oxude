import { mulberry32, nextUint32, PRESET_NAMES } from "../src/index.js";
import { nameFactory } from "./names.js";
import { connect, migrate } from "../src/db/client.js";
import { bandOf, createAgent, leaderboard, runMatch, updateRating } from "../src/db/runner.js";
import { refreshTrueRatings, rosterProfile, trueRatingAgainst } from "../src/db/rating.js";
import { policyAgent } from "../src/agents/policy.js";

// Builds a roster with real records so the first player meets a populated
// ladder. Usage: npm run seed-roster [-- --agents 200 --matches 5000 --seed 1]
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const AGENTS = arg("--agents", 200);
const MATCHES = arg("--matches", 5000);
const rng = mulberry32(arg("--seed", 1));
/** Lets a run measure how busting behaves at other starting balances. */
const BALANCE = arg("--balance", 0);

const nextName = nameFactory(rng);

const { db, close } = await connect();
if (process.argv.includes("--migrate")) await migrate(db);

const started = Date.now();
// Ceilings spread across the bands, so every band has opponents.
const CEILINGS = [20, 40, 60];
const rows = [];
for (let i = 0; i < AGENTS; i++) {
  // Equal numbers of each preset, each carrying its own snapshotted table.
  rows.push(
    await createAgent(db, {
      name: nextName(),
      presetName: PRESET_NAMES[i % PRESET_NAMES.length]!,
      maxStake: CEILINGS[i % CEILINGS.length]!,
      ...(BALANCE > 0 ? { startingBalance: BALANCE } : {}),
    }),
  );
}
console.log(`true ratings: ${await refreshTrueRatings(db)} agents rated against the roster`);
console.log(`${rows.length} agents created (${PRESET_NAMES.join(", ")} in equal numbers)`);

// Random pairing within a band: matchmaking needs ratings that do not exist yet,
// but the bands are part of the shape being measured.
const byBand = new Map<string, typeof rows>();
for (const row of rows) {
  const band = bandOf(row.maxStake);
  byBand.set(band, [...(byBand.get(band) ?? []), row]);
}
const live = new Set(rows.map((r) => r.id));
const playedWhenRetired = new Map<string, number>();
const playedBy = new Map<string, number>();
let retirements = 0;
let played = 0;

for (let k = 0; k < MATCHES; k++) {
  const pool = [...byBand.values()].filter((band) => band.filter((r) => live.has(r.id)).length >= 2);
  if (pool.length === 0) break;
  const band = pool[Math.floor(rng() * pool.length)]!.filter((r) => live.has(r.id));
  const a = band[Math.floor(rng() * band.length)]!;
  let b = band[Math.floor(rng() * band.length)]!;
  while (b.id === a.id) b = band[Math.floor(rng() * band.length)]!;

  const { retired } = await runMatch(db, a.id, b.id, { seed: nextUint32(rng) });
  played++;
  for (const id of [a.id, b.id]) playedBy.set(id, (playedBy.get(id) ?? 0) + 1);
  for (const id of retired) {
    live.delete(id);
    retirements++;
    playedWhenRetired.set(id, playedBy.get(id) ?? 0);
  }
  if (played % 500 === 0) {
    console.log(
      `  ${played}/${MATCHES} matches (${((Date.now() - started) / 1000).toFixed(0)}s), ` +
        `${retirements} retired, ${live.size} still playing`,
    );
  }
}

for (const r of rows) await updateRating(db, r.id);
const board = await leaderboard(db, 10);
console.log(`\nLadder after ${MATCHES} matches (ranked on all-time net won):`);
for (const [i, row] of board.entries()) {
  console.log(
    `${String(i + 1).padStart(3)}. ${row.name.padEnd(18)} ${(row.presetName ?? "policy").padEnd(8)} ` +
      `${row.cumulativeNet >= 0 ? "+" : ""}${row.cumulativeNet} net over ${row.matchesPlayed} matches ` +
      `(recent form ${row.recentForm >= 0 ? "+" : ""}${row.recentForm.toFixed(2)})`,
  );
}

const byPreset = new Map<string, { n: number; sum: number; matches: number }>();
for (const row of await leaderboard(db, AGENTS)) {
  const k = row.presetName ?? "policy";
  const e = byPreset.get(k) ?? { n: 0, sum: 0, matches: 0 };
  e.n++;
  e.sum += row.cumulativeNet;
  e.matches += row.matchesPlayed;
  byPreset.set(k, e);
}
const profile = await rosterProfile(db);
console.log(`\nBy preset: what they won, next to what they are worth (exact):`);
for (const [preset, { n, sum, matches }] of byPreset) {
  const table = rows.find((r) => r.presetName === preset)!.policyTable!;
  const exact = trueRatingAgainst(policyAgent(table), profile);
  console.log(
    `  ${preset.padEnd(8)} net per match ${(sum / matches).toFixed(3)} over ${matches} matches, ` +
      `true rating ${exact >= 0 ? "+" : ""}${exact.toFixed(3)} (${n} agents)`,
  );
}
// What busting looks like at these numbers.
const bustedAt = [...playedWhenRetired.values()].sort((x, y) => x - y);
const median = bustedAt.length ? bustedAt[Math.floor(bustedAt.length / 2)]! : null;
console.log(`\nBusting, over ${played} matches:`);
console.log(`  ${retirements} of ${rows.length} agents retired (${((100 * retirements) / rows.length).toFixed(1)}%)`);
console.log(
  median === null
    ? "  nobody busted, so there is no median"
    : `  median matches before busting: ${median} (range ${bustedAt[0]}..${bustedAt[bustedAt.length - 1]})`,
);
const survivors = rows.filter((r) => live.has(r.id)).map((r) => playedBy.get(r.id) ?? 0);
const meanPlayed = survivors.length ? survivors.reduce((x, y) => x + y, 0) / survivors.length : 0;
console.log(`  survivors played ${meanPlayed.toFixed(0)} matches each on average`);

console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s total`);
await close();
