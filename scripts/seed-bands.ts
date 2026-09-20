import { mulberry32 } from "../src/index.js";
import { PRESET_NAMES } from "../src/presets.js";
import { nameFactory } from "./names.js";
import { connect, migrate } from "../src/db/client.js";
import { createAgent } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";
import { STARTING_BALANCE, type BandName } from "../src/db/schema.js";

/**
 * Seeds house agents into the bands that have none, so a player who picks A or
 * C has someone to meet on day one. Band B already has a full roster.
 *
 * Minting is rate limited on chain: MINT_CAP is 18,000 per window of about ten
 * minutes, and each vault opens with STARTING_BALANCE. Eight agents at 900 is
 * 7,200, so one band per window leaves room for real rentals alongside it;
 * sixteen at once would take 14,400 of the 18,000 and leave only four rentals'
 * worth. So this seeds one band, waits out the window, then seeds the next.
 *
 *   npx tsx scripts/seed-bands.ts                 # A then C, waiting between
 *   npx tsx scripts/seed-bands.ts --band A        # just one
 *   npx tsx scripts/seed-bands.ts --wait 0        # no wait (local, no chain)
 */

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const COUNT = Number(arg("--count", "8"));
/** Slightly over one window of 1,500 slots at ~400ms, so the budget has reset. */
const WAIT_SECONDS = Number(arg("--wait", "660"));
const ONLY = arg("--band", "");
const BANDS: BandName[] = ONLY ? [ONLY as BandName] : ["A", "C"];

const { db, close } = await connect();
await migrate(db);
const nextName = nameFactory(mulberry32(Date.now() % 1_000_000));

for (const [i, band] of BANDS.entries()) {
  console.log(`\nBand ${band}: seeding ${COUNT} house agents at ${STARTING_BALANCE} (${COUNT * STARTING_BALANCE} minted)`);
  for (let k = 0; k < COUNT; k++) {
    const row = await createAgent(db, {
      name: nextName(),
      presetName: PRESET_NAMES[k % PRESET_NAMES.length]!,
      band,
    });
    console.log(`  ${row.name} (${PRESET_NAMES[k % PRESET_NAMES.length]})`);
  }
  if (i < BANDS.length - 1 && WAIT_SECONDS > 0) {
    console.log(`waiting ${WAIT_SECONDS}s for the mint window to reset before the next band`);
    await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));
  }
}

console.log(`\ntrue ratings: ${await refreshTrueRatings(db)} agents rated against the roster`);
await close();
