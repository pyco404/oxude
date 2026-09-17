import { mulberry32, nextUint32, PRESET_NAMES } from "../src/index.js";
import { connect, migrate } from "../src/db/client.js";
import { agents, ratings } from "../src/db/schema.js";
import { leaderboard, runMatch, updateRating } from "../src/db/runner.js";

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
const rows = await db
  .insert(agents)
  .values(
    Array.from({ length: AGENTS }, (_, i) => ({
      name: name(i),
      // Equal numbers of each preset, so the roster spans the loop.
      presetName: PRESET_NAMES[i % PRESET_NAMES.length]!,
    })),
  )
  .returning({ id: agents.id, name: agents.name, presetName: agents.presetName });
await db.insert(ratings).values(rows.map((r) => ({ agentId: r.id })));
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
console.log(`\nTop of the ladder after ${MATCHES} matches:`);
for (const [i, row] of board.entries()) {
  console.log(
    `${String(i + 1).padStart(3)}. ${row.name.padEnd(18)} ${(row.presetName ?? "policy").padEnd(8)} ` +
      `${row.rollingNet50 >= 0 ? "+" : ""}${row.rollingNet50.toFixed(2)} over ${row.matchesPlayed} matches`,
  );
}

const byPreset = new Map<string, { n: number; sum: number }>();
for (const row of await leaderboard(db, AGENTS)) {
  const k = row.presetName ?? "policy";
  const e = byPreset.get(k) ?? { n: 0, sum: 0 };
  e.n++;
  e.sum += row.rollingNet50;
  byPreset.set(k, e);
}
console.log(`\nMean rolling net by preset (what the ladder thinks of each):`);
for (const [preset, { n, sum }] of byPreset) console.log(`  ${preset.padEnd(8)} ${(sum / n).toFixed(3)} across ${n} agents`);
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s total`);
await close();
