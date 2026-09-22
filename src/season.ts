/**
 * Weekly seasons: Monday 00:00 UTC to the next Monday 00:00 UTC.
 *
 * Every rental ends at a season boundary, so there is one clock for the whole
 * game: the chip rate can only change when no rental is mid-week, and "final
 * placement" means the same moment for everyone.
 *
 * A season is named by the date its Monday falls on ("2026-09-21"), so any
 * instant maps to exactly one season by arithmetic alone - nothing needs to be
 * looked up to know which season a match belongs to.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const SEASON_MS = 7 * DAY_MS;
/**
 * How long an agent that was not renewed stays expired - unable to play, but
 * renewable with its record intact - before it lapses and retires. On mainnet
 * the auction window takes this place.
 */
export const GRACE_MS = DAY_MS;
/** How long before the end the owner is reminded to renew. */
export const RENEWAL_REMINDER_MS = 3 * DAY_MS;
/** The first season. Matches before it belong to no season and count only all-time. */
export const FIRST_SEASON = "2026-09-21";

export type Season = {
  /** The Monday it starts on, as YYYY-MM-DD. */
  key: string;
  /** 1 for the first season, counting weekly from there. */
  number: number;
  start: Date;
  end: Date;
};

/** The Monday 00:00 UTC at or before `at`. */
export function seasonStart(at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // getUTCDay: Sunday 0 ... Saturday 6. Days since Monday:
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS);
}

export function seasonAt(at: Date): Season {
  const start = seasonStart(at);
  return seasonFromStart(start);
}

/** The season with this key. Throws on anything that is not a Monday. */
export function seasonByKey(key: string): Season {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`not a season key: ${key}`);
  const start = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || seasonStart(start).getTime() !== start.getTime()) {
    throw new Error(`not a season key: ${key}`);
  }
  return seasonFromStart(start);
}

function seasonFromStart(start: Date): Season {
  const key = start.toISOString().slice(0, 10);
  const first = new Date(`${FIRST_SEASON}T00:00:00Z`).getTime();
  return {
    key,
    number: Math.round((start.getTime() - first) / SEASON_MS) + 1,
    start,
    end: new Date(start.getTime() + SEASON_MS),
  };
}

/** The season after this one. */
export const nextSeason = (season: Season): Season => seasonFromStart(season.end);

/** Milliseconds until `end`, never negative. */
export const timeLeft = (end: Date, now = new Date()): number => Math.max(0, end.getTime() - now.getTime());

/** The start of the UTC day containing `at`: the window a daily view counts. */
export function dayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
