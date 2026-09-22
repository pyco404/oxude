import { asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentTraits, matches, traitProgress } from "../db/schema.js";
import { addCounts, countMatch, EMPTY_COUNTS, traitsFrom, type TraitCounts, type Traits } from "./traits.js";

/**
 * Keeps every agent's measured traits current, in the background. Reads the
 * matches recorded since it last looked, adds their counts to both agents, and
 * moves its cursor - all in one transaction, so a match is counted exactly
 * once whatever happens to the process. The match path is never touched.
 *
 * Exhibitions count: house agents playing each other are real hands, and it is
 * how house agents - the opponents players meet most - get traits at all.
 */

const COLUMNS = Object.keys(EMPTY_COUNTS) as (keyof TraitCounts)[];

export type TraitPass = { matches: number; agents: number; lastSeq: number };

export async function updateTraits(db: Db, batch = 2000): Promise<TraitPass> {
  return db.transaction(async (tx) => {
    await tx.insert(traitProgress).values({ id: 1, lastSeq: 0 }).onConflictDoNothing();
    const [progress] = await tx.select().from(traitProgress).where(eq(traitProgress.id, 1)).for("update");
    const rows = await tx
      .select({ seq: matches.seq, a: matches.agentA, b: matches.agentB, log: matches.log })
      .from(matches)
      .where(gt(matches.seq, progress!.lastSeq))
      .orderBy(asc(matches.seq))
      .limit(batch);
    if (rows.length === 0) return { matches: 0, agents: 0, lastSeq: progress!.lastSeq };

    const perAgent = new Map<string, TraitCounts>();
    const add = (id: string, c: TraitCounts) => perAgent.set(id, addCounts(perAgent.get(id) ?? EMPTY_COUNTS, c));
    for (const r of rows) {
      // An old or odd log with no rounds counts as nothing, rather than stopping the pass.
      if (!Array.isArray(r.log?.rounds)) continue;
      add(r.a, countMatch(r.log, "A"));
      add(r.b, countMatch(r.log, "B"));
    }
    for (const [agentId, c] of perAgent) {
      const increments = Object.fromEntries(COLUMNS.map((k) => [k, sql`${agentTraits[k]} + ${c[k]}`]));
      await tx
        .insert(agentTraits)
        .values({ agentId, ...c })
        .onConflictDoUpdate({ target: agentTraits.agentId, set: { ...increments, updatedAt: new Date() } });
    }
    const lastSeq = rows[rows.length - 1]!.seq;
    await tx.update(traitProgress).set({ lastSeq }).where(eq(traitProgress.id, 1));
    return { matches: rows.length, agents: perAgent.size, lastSeq };
  });
}

/** Runs the pass on a loop: straight away while there is a backlog, then once a minute. */
export function startTraits(db: Db, options: { onError?: (e: unknown) => void; onLog?: (line: string) => void } = {}): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const once = async () => {
    let delay = 60_000;
    try {
      const r = await updateTraits(db);
      if (r.matches > 0) options.onLog?.(`traits: counted ${r.matches} matches for ${r.agents} agents, up to seq ${r.lastSeq}`);
      if (r.matches >= 2000) delay = 1_000;
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void once(), delay);
  };
  void once();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** An agent's traits, ready to show. An agent that has not played has none yet. */
export async function traitsOf(db: Db, agentId: string): Promise<Traits> {
  const [row] = await db.select().from(agentTraits).where(eq(agentTraits.agentId, agentId));
  const counts = row ? (Object.fromEntries(COLUMNS.map((k) => [k, row[k]])) as TraitCounts) : EMPTY_COUNTS;
  return traitsFrom(counts);
}
