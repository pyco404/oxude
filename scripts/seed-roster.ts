import { mulberry32, nextUint32, PRESET_NAMES } from "../src/index.js";
import { connect, migrate } from "../src/db/client.js";
import { createAgent, leaderboard, runMatch, updateRating } from "../src/db/runner.js";
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

const FIRST = ["Quiet", "Iron", "Amber", "Swift", "Hollow", "Bright", "Salt", "Copper", "Grey", "Rapid", "Still", "North"];
const SECOND = ["Fox", "Anvil", "Harbor", "Lantern", "Falcon", "Ledger", "Crow", "Mint", "Spire", "Drift", "Ash", "Vale"];
const name = (i: number) =>
  `${FIRST[Math.floor(rng() * FIRST.length)]}${SECOND[Math.floor(rng() * SECOND.length)]}-${String(i).padStart(3, "0")}`;

const { db, close } = await connect();
if (process.argv.includes("--migrate")) await migrate(db);

const started = Date.now();
const rows = [];
for (let i = 0; i < AGENTS; i++) {
  // Equal numbers of each preset, each carrying its own snapshotted table.
  rows.push(await createAgent(db, { name: name(i), presetName: PRESET_NAMES[i % PRESET_NAMES.length]! }));
}
console.log(`true ratings: ${await refreshTrueRatings(db)} agents rated against the roster`);
console.log(`${rows.length} agents created (${PRESET_NAMES.join(", ")} in equal numbers)`);

// Random pairing for the seed run: matchmaking needs ratings that do not exist yet.
for (let k = 0; k < MATCHES; k++) {
  const a = rows[Math.floor(rng() * rows.length)]!;
  let b = rows[Math.floor(rng() * rows.length)]!;
  while (b.id === a.id) b = rows[Math.floor(rng() * rows.length)]!;
  await runMatch(db, a.id, b.id, { seed: nextUint32(rng) });
  if ((k + 1) % 500 === 0) console.log(`  ${k + 1}/${MATCHES} matches (${((Date.now() - started) / 1000).toFixed(0)}s)`);
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
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s total`);
await close();
