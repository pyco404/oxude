import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import type { Db } from "./client.js";
import { recordEvent } from "./events.js";
import { standings } from "./standings.js";
import { GRACE_MS, nextSeason, RENEWAL_REMINDER_MS, seasonAt, seasonByKey, type Season } from "../season.js";
import { agents, seasonStandings, seasons, type AgentRow } from "./schema.js";

/**
 * The season boundary: closing one season and lapsing the agents nobody
 * renewed.
 *
 * None of this enforces the boundary. A rental's end is checked where every
 * match is recorded (src/db/rental.ts), so an agent stops playing at the
 * boundary to the millisecond whether or not this has run. What runs here is
 * the tidying after it - freezing the standings, switching autoplay off,
 * lapsing agents once their grace is over - and it is written so that running
 * it late, running it twice, or dying halfway through are all harmless.
 */

/** Makes sure a season has its row. Harmless to call again. */
export async function ensureSeason(db: Db, season: Season): Promise<void> {
  await db
    .insert(seasons)
    .values({ key: season.key, startsAt: season.start, endsAt: season.end })
    .onConflictDoNothing();
}

/**
 * The hook for what changes between seasons on chain. Runs inside the closing
 * transaction, once per boundary, after the old season's standings are frozen.
 *
 * On devnet it does nothing: there is no chip rate. On mainnet this is where
 * the next season's rate is set - computed from the published TWAP, checked
 * against the ±50% band and the tokens-per-chip ceiling, written to the next
 * season's `chip_rate`, and queued for the program through the outbox in this
 * same transaction, so the ledger and the chain agree on it or neither has it
 * (docs/economy.md, The chip rate).
 */
export async function onSeasonBoundary(_db: Db, _closing: Season, _next: Season): Promise<void> {}

export type CloseResult = { closed: boolean; expired: number; autoplayStopped: number; standings: number };

/**
 * Closes a season: freezes its standings, marks every rental that ended with
 * it as expired, and switches autoplay off for every player agent. Exactly
 * once: the season's row is locked and its status checked first, so a second
 * run - after a restart, or from a second instance - finds it closed and does
 * nothing. Everything is one transaction, so a run that dies halfway leaves
 * nothing half-done and the next attempt starts clean.
 */
export async function closeSeason(db: Db, key: string, now = new Date()): Promise<CloseResult> {
  const season = seasonByKey(key);
  if (now.getTime() < season.end.getTime()) throw new Error(`season ${key} has not ended`);
  await ensureSeason(db, season);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`season:${key}`}, 0))`);
    const [row] = await tx.select().from(seasons).where(eq(seasons.key, key)).for("update");
    if (row!.status === "closed") return { closed: false, expired: 0, autoplayStopped: 0, standings: 0 };

    // Lock every player agent still in play before counting anything. A match
    // being recorded right now holds its agents' locks: it either commits
    // first, and is counted, or waits for this and is then refused by the
    // rental check (or, for an agent already renewed, lands in the next season).
    const players = await tx
      .select()
      .from(agents)
      .where(and(isNotNull(agents.ownerId), isNull(agents.retiredAt)))
      .orderBy(asc(agents.id))
      .for("update");

    // Final placement: frozen now, never recomputed. The grace period that
    // follows cannot change it - an agent renewed tomorrow plays in the next
    // season, not this one.
    const table = await standings(t, { season: key });
    if (table.length > 0) {
      await tx
        .insert(seasonStandings)
        .values(
          table.map((s, i) => ({
            season: key,
            agentId: s.agentId,
            rank: i + 1,
            rankedMatches: s.rankedMatches,
            rankedNet: s.rankedNet,
            rankedStaked: s.rankedStaked,
            rankedNetReal: s.rankedNetReal,
            totalMatches: s.totalMatches,
            totalNet: s.totalNet,
          })),
        )
        .onConflictDoNothing();
    }

    // Expired: the rental ended with this season and was not renewed. Nothing
    // on the row changes - expiry is its end having passed - but it is
    // recorded, with the moment the grace period runs out.
    const graceEnds = new Date(season.end.getTime() + GRACE_MS);
    let expired = 0;
    for (const p of players) {
      if (p.rentalEndsAt !== null && p.rentalEndsAt.getTime() <= season.end.getTime()) {
        await recordEvent(t, p.id, "expired", "season", `renew by ${graceEnds.toISOString()}`);
        expired++;
      }
    }

    // Autoplay stops for everyone at the boundary, renewed or not: a new
    // season is played only once the owner says so. Band and floor stay.
    let autoplayStopped = 0;
    for (const p of players) {
      if (!p.autoplay) continue;
      await tx
        .update(agents)
        .set({ autoplay: false, autoplayStoppedReason: "season", autoplayStoppedAt: now })
        .where(eq(agents.id, p.id));
      await recordEvent(t, p.id, "autoplay-off", "season", `season ${key} ended`);
      autoplayStopped++;
    }

    const next = nextSeason(season);
    await onSeasonBoundary(t, season, next);
    await ensureSeason(t, next);
    await tx.update(seasons).set({ status: "closed", closedAt: now }).where(eq(seasons.key, key));
    return { closed: true, expired, autoplayStopped, standings: table.length };
  });
}

/**
 * Retires every agent whose grace period is over: expired, not renewed within
 * GRACE_MS of its end. Its record is kept and its balance stays withdrawable.
 * Each agent lapses once: only agents not yet retired are touched, in one
 * statement that both chooses and retires them.
 */
export async function lapseExpired(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - GRACE_MS);
  return db.transaction(async (tx) => {
    const lapsed = await tx
      .update(agents)
      .set({ retiredAt: now, retiredReason: "lapsed", autoplay: false })
      .where(and(isNotNull(agents.ownerId), isNull(agents.retiredAt), lte(agents.rentalEndsAt, cutoff)))
      .returning({ id: agents.id });
    for (const { id } of lapsed) await recordEvent(tx as unknown as Db, id, "lapsed", "season", "not renewed within the grace period");
    return lapsed.map((r) => r.id);
  });
}

export type SeasonTick = { closed: { key: string; result: CloseResult }[]; lapsed: string[] };

/**
 * One pass: close every season that has ended and is still open, oldest
 * first; make sure the current season has its row; lapse whoever's grace is
 * over. Runs at startup and then every minute, so a boundary missed while the
 * api was down is closed as soon as it is back.
 */
export async function seasonTick(db: Db, now = new Date()): Promise<SeasonTick> {
  const ended = await db
    .select({ key: seasons.key })
    .from(seasons)
    .where(and(eq(seasons.status, "open"), lte(seasons.endsAt, now)))
    .orderBy(asc(seasons.key));
  const closed: SeasonTick["closed"] = [];
  for (const { key } of ended) closed.push({ key, result: await closeSeason(db, key, now) });
  await ensureSeason(db, seasonAt(now));
  return { closed, lapsed: await lapseExpired(db, now) };
}

export function startSeasons(
  db: Db,
  options: { pollMs?: number; onLog?: (line: string) => void; onError?: (error: unknown) => void } = {},
): { stop: () => void } {
  const pollMs = options.pollMs ?? 60_000;
  const log = options.onLog ?? (() => {});
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const once = async () => {
    try {
      const result = await seasonTick(db);
      for (const { key, result: r } of result.closed) {
        if (r.closed) {
          log(`season: closed ${key} - ${r.standings} standings frozen, ${r.expired} expired, autoplay stopped for ${r.autoplayStopped}`);
        }
      }
      if (result.lapsed.length) log(`season: ${result.lapsed.length} lapsed after the grace period: ${result.lapsed.map((id) => id.slice(0, 8)).join(", ")}`);
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void once(), pollMs + randomInt(Math.max(1, Math.round(pollMs / 10))));
  };
  void once();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Renewal.
// ---------------------------------------------------------------------------

export type RentalState =
  /** Rented for the current season, not yet renewed. */
  | "active"
  /** Renewed: it carries on into the next season. */
  | "renewed"
  /** The season ended without a renewal: cannot play, can still be renewed until `graceEndsAt`. */
  | "expired"
  /** Retired because the grace period passed. Record kept, balance withdrawable. */
  | "lapsed"
  /** Retired for another reason: it ran out, or was withdrawn in full. */
  | "retired"
  /** A house agent: not rented, never ends. */
  | "house";

export type RentalStatus = {
  state: RentalState;
  /** The season in play now. */
  season: { key: string; number: number; endsAt: Date };
  /** When this agent's rental ends. Null for a house agent. */
  endsAt: Date | null;
  /** While expired: the last moment it can be renewed. */
  graceEndsAt: Date | null;
  canRenew: boolean;
  /** Within 72 hours of the end and not renewed: time to ask the owner. */
  remind: boolean;
};

/** Where an agent's rental stands, for its owner. */
export function rentalStatus(row: Pick<AgentRow, "ownerId" | "retiredAt" | "retiredReason" | "rentalEndsAt">, now = new Date()): RentalStatus {
  const current = seasonAt(now);
  const season = { key: current.key, number: current.number, endsAt: current.end };
  const base = { season, endsAt: row.rentalEndsAt, graceEndsAt: null, canRenew: false, remind: false };
  if (row.ownerId === null || row.rentalEndsAt === null) return { ...base, state: "house" };
  if (row.retiredAt !== null) return { ...base, state: row.retiredReason === "lapsed" ? "lapsed" : "retired" };
  const end = row.rentalEndsAt.getTime();
  if (end > current.end.getTime()) return { ...base, state: "renewed" };
  if (end > now.getTime()) {
    return { ...base, state: "active", canRenew: true, remind: end - now.getTime() <= RENEWAL_REMINDER_MS };
  }
  // Past its end and not retired: expired. Renewable while the grace lasts; after
  // that it is waiting for the lapse pass, which retires it within a minute.
  const graceEndsAt = new Date(end + GRACE_MS);
  return { ...base, state: "expired", graceEndsAt, canRenew: now.getTime() < graceEndsAt.getTime() };
}

export class RenewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Renews a rental, once per season: an active one into the next season, or an
 * expired one, within its grace period, into the season now running - with its
 * record, balance, band and floor exactly as they were. Autoplay is left off:
 * the owner switches it back on.
 *
 * Free on devnet. On mainnet renewal costs rent, which is why it is once per
 * season and never a standing switch.
 */
export async function renewAgent(db: Db, agentId: string, ownerId: string, now = new Date()): Promise<RentalStatus> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
    if (!row) throw new RenewError(404, "no such agent");
    if (row.ownerId !== ownerId) throw new RenewError(403, "that agent belongs to someone else");
    const status = rentalStatus(row, now);
    if (!status.canRenew) {
      const why: Record<RentalState, string> = {
        renewed: "it is already renewed for the next season",
        lapsed: "its rental lapsed after the grace period; rent a new agent",
        retired: "it is retired",
        house: "house agents are not rented",
        expired: "the 24-hour grace period is over",
        active: "it cannot be renewed right now",
      };
      throw new RenewError(409, `can't renew: ${why[status.state]}`);
    }
    const current = seasonAt(now);
    // Active: through the end of next season. Expired: through the end of this one.
    const through = status.state === "active" ? nextSeason(current) : current;
    await tx.update(agents).set({ rentalEndsAt: through.end }).where(eq(agents.id, agentId));
    await recordEvent(
      tx as unknown as Db,
      agentId,
      "renewed",
      "owner",
      `${status.state === "expired" ? "from expiry, " : ""}through season ${through.key}`,
    );
    const [after] = await tx.select().from(agents).where(eq(agents.id, agentId));
    return rentalStatus(after!, now);
  });
}
