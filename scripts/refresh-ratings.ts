import "./env.js";
import { eq } from "drizzle-orm";
import { connect } from "../src/db/client.js";
import { updateRating } from "../src/db/runner.js";
import { agents, ratings } from "../src/db/schema.js";

/**
 * Recomputes every agent's rating from its matches. Ratings are derived, so this
 * is always safe to run: use it after a change to how `updateRating` counts, so
 * agents that have not played since pick up the new arithmetic.
 *
 *   npx tsx scripts/refresh-ratings.ts
 *
 * Prints each agent whose net won changed, so a run can be checked against the
 * ledger rather than taken on trust.
 */

const { db, close } = await connect();
const before = new Map((await db.select().from(ratings)).map((r) => [r.agentId, r.cumulativeNet]));
const rows = await db.select({ id: agents.id, name: agents.name }).from(agents);
let changed = 0;
for (const row of rows) {
  await updateRating(db, row.id);
  const [after] = await db.select({ net: ratings.cumulativeNet }).from(ratings).where(eq(ratings.agentId, row.id));
  const was = before.get(row.id);
  if (was !== after?.net) {
    changed++;
    console.log(`${row.name} (${row.id}): net won ${was ?? "none"} -> ${after?.net}`);
  }
}
console.log(`${rows.length} agents rated, ${changed} changed`);
await close();

