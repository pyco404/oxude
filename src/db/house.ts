import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import type { Db } from "./client.js";
import { runExhibition } from "./runner.js";
import { agents, bandByName, ledger, matches, type BandName } from "./schema.js";

/**
 * Exhibitions between house agents, so the platform is visibly running when no
 * player is. They stake nothing and settle nothing (see runExhibition); this
 * only decides who plays whom, and when.
 */

/**
 * Picks a pair that spreads play across the house roster rather than repeating
 * one matchup. Both agents are always in the same band and both can cover its
 * worst match, because runExhibition refuses anything else.
 *
 * That constraint is not decoration. Picking across the whole roster once bands
 * existed meant the least-played agent - a freshly seeded one, on zero plays -
 * was paired with someone in another band, refused, and left on zero plays, so
 * it was picked again next time. Exhibitions did not fail sometimes; they
 * stopped.
 */
export async function pickHousePair(
  db: Db,
  random: (n: number) => number = (n) => randomInt(n),
): Promise<[string, string] | null> {
  // Joined rather than correlated, as in playableBands.
  const balances = db
    .select({ agentId: ledger.agentId, balance: sql<number>`sum(${ledger.amount})::bigint`.as("balance") })
    .from(ledger)
    .groupBy(ledger.agentId)
    .as("balances");
  const rows = await db
    .select({ id: agents.id, band: agents.band, balance: balances.balance })
    .from(agents)
    .innerJoin(balances, eq(balances.agentId, agents.id))
    .where(and(isNull(agents.ownerId), isNull(agents.retiredAt)));

  // Only agents that could actually play their own band, and only bands with
  // at least two of them - a lone agent has nobody to meet.
  const bandOf = new Map<string, BandName>();
  const byBand = new Map<BandName, string[]>();
  for (const r of rows) {
    if (Number(r.balance) < bandByName(r.band).worstMatch) continue;
    bandOf.set(r.id, r.band);
    byBand.set(r.band, [...(byBand.get(r.band) ?? []), r.id]);
  }
  const house = [...byBand.values()].filter((ids) => ids.length >= 2).flat();
  if (house.length < 2) return null;

  // Recent history: roughly two rounds of the roster.
  const recent = await db
    .select({ a: matches.agentA, b: matches.agentB })
    .from(matches)
    .where(eq(matches.exhibition, true))
    .orderBy(desc(matches.seq))
    .limit(house.length * 2);
  const plays = new Map<string, number>(house.map((id) => [id, 0]));
  const met = new Map<string, number>();
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  for (const r of recent) {
    plays.set(r.a, (plays.get(r.a) ?? 0) + 1);
    plays.set(r.b, (plays.get(r.b) ?? 0) + 1);
    met.set(pairKey(r.a, r.b), (met.get(pairKey(r.a, r.b)) ?? 0) + 1);
  }

  const leastBy = (ids: string[], score: (id: string) => number) => {
    const best = Math.min(...ids.map(score));
    const tied = ids.filter((id) => score(id) === best);
    return tied[random(tied.length)]!;
  };
  // Whoever has played least goes next, against whoever it has met least,
  // then whoever has played least; ties at random.
  const first = leastBy(house, (id) => plays.get(id) ?? 0);
  // Its opponent comes from its own band only.
  const others = byBand.get(bandOf.get(first)!)!.filter((id) => id !== first);
  const second = leastBy(others, (id) => (met.get(pairKey(first, id)) ?? 0) * 1000 + (plays.get(id) ?? 0));
  return random(2) === 0 ? [first, second] : [second, first];
}

/** Plays one exhibition every `intervalMs` on average, jittered so it doesn't tick like a metronome. */
export function startHouseExhibitions(
  db: Db,
  options: { intervalMs: number; onMatch?: (matchId: string) => void; onError?: (error: unknown) => void },
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (stopped) return;
    const delay = Math.round(options.intervalMs * 0.5) + randomInt(Math.max(1, options.intervalMs));
    timer = setTimeout(() => void once(), delay);
  };
  const once = async () => {
    try {
      const pair = await pickHousePair(db);
      if (pair) {
        // Not folded into `onMatch?.(...)`: optional chaining would skip the match itself when no callback is given.
        const { match } = await runExhibition(db, pair[0], pair[1]);
        options.onMatch?.(match.id);
      }
    } catch (error) {
      options.onError?.(error);
    }
    next();
  };
  next();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
