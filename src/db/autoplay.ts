import { and, desc, eq, gt, gte, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import type { Db } from "./client.js";
import { pickOpponent, runMatch } from "./runner.js";
import { balanceOf, StakeError } from "./ledger.js";
import { recordEvent } from "./events.js";
import { rentalOpen, rentalOpenSql } from "./rental.js";
import { headlineFor } from "../transcript.js";
import {
  agents,
  matches,
  withdrawals,
  bandByName,
  AUTOPLAY_INTERVAL_MS,
  AUTOPLAY_SELF_CLEARING,
  type AgentRow,
  type AutoplayStop,
} from "./schema.js";

/**
 * Autoplay: the server plays a rented agent on a timer.
 *
 * The owner turns it on, sets a floor, and closes the tab. Nothing here needs
 * the site open and nothing here is signed by an owner - a match settles the
 * same way it does when the button is pressed by hand, through the settler key
 * and the outbox.
 *
 * Only player agents. House agents have their own loop in house.ts, which
 * stakes nothing and settles nothing; an agent with no owner is never selected
 * here.
 */

/** A stop that clears itself when the cause goes away, versus one the owner must undo. */
export const isHold = (reason: AutoplayStop): boolean => AUTOPLAY_SELF_CLEARING[reason];

export type AutoplayCheck =
  | { play: true }
  | { play: false; reason: AutoplayStop; detail: string };

/**
 * Whether this agent may play right now, and if not, which kind of stop it is.
 *
 * Order matters: retirement and a withdrawal are facts about the agent, while
 * the floor and solvency are facts about its balance, and an agent that is
 * both retired and broke should be told it is retired.
 */
export async function checkAgent(db: Db, row: AgentRow): Promise<AutoplayCheck> {
  if (row.retiredAt !== null) return { play: false, reason: "retired", detail: "the agent is retired" };

  const [pending] = await db
    .select({ id: withdrawals.id })
    .from(withdrawals)
    .where(and(eq(withdrawals.agentId, row.id), eq(withdrawals.status, "submitted")))
    .limit(1);
  if (pending) {
    return { play: false, reason: "withdrawal", detail: "a withdrawal is settling" };
  }

  const balance = await balanceOf(db, row.id);
  const worst = bandByName(row.band).worstMatch;
  if (balance < worst) {
    return {
      play: false,
      reason: "insolvent",
      detail: `${balance} cannot cover a band ${row.band} match, which can move ${worst}`,
    };
  }
  // A floor is a floor: stop before a match that *could* go through it, not
  // after one that did. The worst this band can take is `worst`, so anything
  // below floor + worst is already too close.
  if (row.autoplayFloor !== null && balance - worst < row.autoplayFloor) {
    return {
      play: false,
      reason: "floor",
      detail: `balance ${balance} is within one match of your floor (${row.autoplayFloor})`,
    };
  }
  return { play: true };
}

/**
 * Records a stop. A hold leaves autoplay on, because the thing in its way will
 * pass; a pause turns it off, because the owner has to decide what to do next.
 */
export async function stopAgent(db: Db, agentId: string, reason: AutoplayStop): Promise<void> {
  await db
    .update(agents)
    .set({
      autoplay: isHold(reason) ? undefined : false,
      autoplayStoppedReason: reason,
      autoplayStoppedAt: new Date(),
    })
    .where(eq(agents.id, agentId));
  // A pause switches autoplay off, so it is recorded like the owner doing it.
  // A hold leaves it on and clears itself, so there is nothing to record.
  if (!isHold(reason)) await recordEvent(db, agentId, "autoplay-off", "autoplay", `paused: ${reason}`);
}

/**
 * The owner switches autoplay on or off, or moves the floor. Recorded only
 * where something changed, so the record reads as what the owner did rather
 * than how often the panel was saved.
 */
export async function setAutoplay(db: Db, row: AgentRow, enabled: boolean, floor: number | null): Promise<void> {
  await db
    .update(agents)
    .set({
      autoplay: enabled,
      autoplayFloor: floor,
      ...(enabled ? { autoplayStoppedReason: null, autoplayStoppedAt: null } : {}),
    })
    .where(eq(agents.id, row.id));
  const floorText = floor === null ? "no floor" : `floor ${floor}`;
  if (enabled !== row.autoplay) {
    await recordEvent(db, row.id, enabled ? "autoplay-on" : "autoplay-off", "owner", floorText);
  } else if (floor !== row.autoplayFloor) {
    await recordEvent(db, row.id, "floor", "owner", floorText);
  }
}

/** Clears a stop once the agent has played again. */
async function clearStop(db: Db, agentId: string, playedAt: Date): Promise<void> {
  await db
    .update(agents)
    .set({
      autoplayStoppedReason: null,
      autoplayStoppedAt: null,
      autoplayWaitingSince: null,
      autoplayLastMatchAt: playedAt,
    })
    .where(eq(agents.id, agentId));
}

/**
 * Agents due a match: autoplay on, owned, and last played longer ago than the
 * interval. The interval is counted per agent from its own last match, so they
 * spread themselves out instead of all firing on one tick.
 */
export async function dueAgents(db: Db, intervalMs: number, now = new Date()): Promise<AgentRow[]> {
  const due = new Date(now.getTime() - intervalMs);
  return db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.autoplay, true),
        isNotNull(agents.ownerId),
        isNull(agents.retiredAt),
        // Expired: nothing to play until the owner renews, so not due.
        rentalOpenSql(now),
        or(isNull(agents.autoplayLastMatchAt), lte(agents.autoplayLastMatchAt, due)),
      ),
    )
    .orderBy(sql`${agents.autoplayLastMatchAt} asc nulls first`);
}

export type TickResult = {
  played: string[];
  waiting: string[];
  stopped: { agentId: string; reason: AutoplayStop }[];
};

/** How an agent reads in a log line: its name and enough of its id to find it. */
const who = (row: AgentRow) => `${row.name} (${row.id.slice(0, 8)})`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;

/**
 * One pass: every agent that is due gets one match, or one reason why not.
 *
 * Agents are played one at a time rather than in parallel. Two autoplayers
 * picking an opponent at the same instant would each see the other's outflow
 * as unspent, which is exactly the pile-up the budget exists to prevent.
 */
export async function tick(
  db: Db,
  options: {
    intervalMs?: number;
    now?: Date;
    onMatch?: ((matchId: string) => void) | undefined;
    onError?: ((e: unknown) => void) | undefined;
    /**
     * One line per thing worth knowing afterwards: a wait starting or ending,
     * a stop, and a summary of any tick that played or stopped something. A
     * waiting agent retries on every poll, so each wait is logged once, when
     * it starts - not on every retry.
     */
    onLog?: ((line: string) => void) | undefined;
  } = {},
): Promise<TickResult> {
  const intervalMs = options.intervalMs ?? AUTOPLAY_INTERVAL_MS;
  const result: TickResult = { played: [], waiting: [], stopped: [] };
  const log = options.onLog ?? (() => {});
  const plays: string[] = [];

  for (const row of await dueAgents(db, intervalMs, options.now)) {
    try {
      const check = await checkAgent(db, row);
      if (!check.play) {
        await stopAgent(db, row.id, check.reason);
        result.stopped.push({ agentId: row.id, reason: check.reason });
        log(`autoplay: ${who(row)} ${isHold(check.reason) ? "held" : "paused"} (${check.reason}): ${check.detail}`);
        continue;
      }
      const pick = await pickOpponent(db, row.id, { spread: true });
      const { match, settled } = await runMatch(db, row.id, pick.opponentId);
      const playedAt = new Date();
      await clearStop(db, row.id, playedAt);
      if (row.autoplayWaitingSince) {
        log(`autoplay: ${who(row)} stopped waiting after ${minutes(playedAt.getTime() - row.autoplayWaitingSince.getTime())}`);
      }
      result.played.push(row.id);
      plays.push(`${who(row)} ${settled.A >= 0 ? "+" : ""}${settled.A} in band ${match.band}`);
      options.onMatch?.(match.id);
    } catch (error) {
      // No opponent, or a vault with no room left in its window. Neither is a
      // fault and neither is a reason to pause: the agent keeps its place and
      // plays as soon as the queue can serve it.
      if (error instanceof StakeError) {
        await db
          .update(agents)
          .set({ autoplayWaitingSince: row.autoplayWaitingSince ?? new Date() })
          .where(eq(agents.id, row.id));
        if (!row.autoplayWaitingSince) log(`autoplay: ${who(row)} waiting: ${error.message}`);
        result.waiting.push(row.id);
        continue;
      }
      options.onError?.(error);
    }
  }
  if (result.played.length || result.stopped.length) {
    log(
      `autoplay: tick played ${result.played.length}, stopped ${result.stopped.length}, waiting ${result.waiting.length}` +
        (plays.length ? ` - ${plays.join("; ")}` : ""),
    );
  }
  return result;
}

/**
 * Runs `tick` forever. The poll is much shorter than the interval because the
 * interval is per agent: the loop is only asking who has come due since last
 * time, and a short poll keeps an agent from waiting most of another interval
 * past its turn.
 */
export function startAutoplay(
  db: Db,
  options: {
    intervalMs?: number;
    pollMs?: number;
    onMatch?: (matchId: string) => void;
    onError?: (error: unknown) => void;
    onLog?: (line: string) => void;
  } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? AUTOPLAY_INTERVAL_MS;
  const pollMs = options.pollMs ?? Math.max(1_000, Math.min(15_000, Math.round(intervalMs / 20)));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const next = () => {
    if (stopped) return;
    // Jittered so a restart does not line every agent up on the same second.
    timer = setTimeout(() => void once(), pollMs + randomInt(Math.max(1, Math.round(pollMs / 4))));
  };
  const once = async () => {
    try {
      await tick(db, { intervalMs, onMatch: options.onMatch, onError: options.onError, onLog: options.onLog });
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

// ---------------------------------------------------------------------------
// What the owner's panel shows.
// ---------------------------------------------------------------------------

/**
 * The panel's state, as one word. `held` and `paused` are deliberately
 * different words, because they ask different things of the owner: a hold
 * needs nothing, a pause needs them.
 */
export type AutoplayState = "off" | "on" | "waiting" | "held" | "paused";

export type AutoplayStatus = {
  enabled: boolean;
  floor: number | null;
  state: AutoplayState;
  /** The headline, with the numbers: "Paused: one match from your floor (300)." */
  message: string | null;
  /** What, if anything, the owner has to do about it. */
  action: string | null;
  stop: { reason: AutoplayStop; hold: boolean } | null;
  lastMatchAt: Date | null;
  /** When the next match is due; null when it is not going to play on a timer. */
  nextMatchAt: Date | null;
  /** Set while there is nobody in the band to play. */
  waitingSince: Date | null;
  /** Staked matches since midnight UTC, and their net. Money, not normalised. */
  today: { matches: number; net: number };
  intervalMs: number;
};

/** The words for a stop, with its numbers filled in from the agent as it stands. */
function describeStop(
  reason: AutoplayStop,
  row: AgentRow,
  balance: number,
): { message: string; action: string } {
  const worst = bandByName(row.band).worstMatch;
  switch (reason) {
    case "withdrawal":
      return {
        message: "Held: withdrawal settling, resumes automatically.",
        action: "Nothing to do - it picks up again once the withdrawal lands.",
      };
    case "floor":
      return {
        // Two cases, so the headline never contradicts the balance beside it:
        // usually it is one match away, but an owner can set a floor above what
        // the agent holds, and then it is already past it.
        message:
          balance <= (row.autoplayFloor ?? 0)
            ? `Paused: balance is below your floor (${row.autoplayFloor ?? 0}).`
            : `Paused: one match from your floor (${row.autoplayFloor ?? 0}).`,
        action: `Balance is ${balance}, and a band ${row.band} match can move ${worst}, so the next match could take it below your floor. You need to switch it back on - lower the floor first if you want it to keep playing.`,
      };
    case "insolvent":
      return {
        message: `Paused: balance ${balance} can't cover a band ${row.band} match, which can move up to ${worst}.`,
        action: "You need to switch it back on, and it can only play again in a band this balance covers.",
      };
    case "retired":
      return {
        message: "Paused: this agent is retired.",
        action: "A retired agent can't play again.",
      };
    case "season":
      return rentalOpen(row)
        ? {
            message: "Paused: a new season started.",
            action: "Autoplay stops at every season boundary. Switch it back on to play this season - band and floor are as you left them.",
          }
        : {
            message: "Paused: the season ended and this rental wasn't renewed.",
            action: "Renew it within 24 hours of the boundary to keep it and its record; after that it retires, and its balance stays withdrawable.",
          };
  }
}

/** Net for this agent over a set of its matches, as money: its own side of each. */
const netFor = (agentId: string) =>
  sql<number>`coalesce(sum(case when ${matches.agentA} = ${agentId} then ${matches.netA} else ${matches.netB} end), 0)::int`;

/**
 * Everything the owner's autoplay panel needs, computed from the agent as it
 * stands. An agent that is on is checked live rather than trusted to its
 * stored reason: a withdrawal may have landed since the last tick, and the
 * panel should say what is true now, not what was true ten minutes ago.
 */
export async function autoplayStatus(
  db: Db,
  row: AgentRow,
  options: { intervalMs?: number; now?: Date } = {},
): Promise<AutoplayStatus> {
  const intervalMs = options.intervalMs ?? AUTOPLAY_INTERVAL_MS;
  const now = options.now ?? new Date();
  const balance = await balanceOf(db, row.id);

  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [today] = await db
    .select({ n: sql<number>`count(*)::int`, net: netFor(row.id) })
    .from(matches)
    .where(
      and(
        or(eq(matches.agentA, row.id), eq(matches.agentB, row.id)),
        eq(matches.exhibition, false),
        gte(matches.createdAt, midnight),
      ),
    );

  let state: AutoplayState;
  let stop: AutoplayStatus["stop"] = null;
  if (row.autoplay) {
    const check = await checkAgent(db, row);
    if (!check.play) {
      stop = { reason: check.reason, hold: isHold(check.reason) };
      state = stop.hold ? "held" : "paused";
    } else {
      state = row.autoplayWaitingSince ? "waiting" : "on";
    }
  } else if (row.autoplayStoppedReason && !isHold(row.autoplayStoppedReason)) {
    stop = { reason: row.autoplayStoppedReason, hold: false };
    state = "paused";
  } else {
    state = "off";
  }

  const words = stop ? describeStop(stop.reason, row, balance) : null;
  // A countdown only means something while the timer is actually running. A
  // waiting agent retries on every poll so that it plays the moment an
  // opponent appears, which is sooner than any countdown would claim.
  const nextMatchAt =
    state === "on"
      ? new Date(Math.max(now.getTime(), (row.autoplayLastMatchAt?.getTime() ?? 0) + intervalMs))
      : null;

  return {
    enabled: row.autoplay,
    floor: row.autoplayFloor,
    state,
    message: words?.message ?? null,
    action: words?.action ?? null,
    stop,
    lastMatchAt: row.autoplayLastMatchAt,
    nextMatchAt,
    waitingSince: state === "waiting" ? row.autoplayWaitingSince : null,
    today: { matches: Number(today?.n ?? 0), net: Number(today?.net ?? 0) },
    intervalMs,
  };
}

export type SinceYouLeft = {
  since: Date;
  matches: number;
  net: number;
  /** The biggest single win in the period, told by its headline. Null if it won nothing. */
  bestHand: { matchId: string; net: number; headline: string | null; createdAt: Date } | null;
};

/**
 * What happened while the owner was away: every staked match since they last
 * dismissed this, the net, and the best of them.
 *
 * Measured from `owner_last_seen_at`, which only moves when the owner says so
 * (markSeen), not whenever the panel loads. The panel refreshes itself to keep
 * its countdown current, and a summary that reset on every refresh would be
 * gone before anyone read it.
 */
export async function sinceYouLeft(db: Db, row: AgentRow): Promise<SinceYouLeft | null> {
  const since = row.ownerLastSeenAt;
  if (!since) return null;
  const mine = and(
    or(eq(matches.agentA, row.id), eq(matches.agentB, row.id)),
    eq(matches.exhibition, false),
    gt(matches.createdAt, since),
  );
  const [totals] = await db
    .select({ n: sql<number>`count(*)::int`, net: netFor(row.id) })
    .from(matches)
    .where(mine);
  const n = Number(totals?.n ?? 0);
  if (n === 0) return { since, matches: 0, net: 0, bestHand: null };

  const myNet = sql<number>`case when ${matches.agentA} = ${row.id} then ${matches.netA} else ${matches.netB} end`;
  const [best] = await db
    .select({ id: matches.id, net: myNet, log: matches.log, createdAt: matches.createdAt, a: matches.agentA, b: matches.agentB })
    .from(matches)
    .where(and(mine, sql`${myNet} > 0`))
    .orderBy(desc(myNet), desc(matches.seq))
    .limit(1);

  let bestHand: SinceYouLeft["bestHand"] = null;
  if (best) {
    const [a, b] = await Promise.all([
      db.select({ name: agents.name }).from(agents).where(eq(agents.id, best.a)).limit(1),
      db.select({ name: agents.name }).from(agents).where(eq(agents.id, best.b)).limit(1),
    ]);
    bestHand = {
      matchId: best.id,
      net: Number(best.net),
      headline: headlineFor(best.log, { A: a[0]?.name ?? "A", B: b[0]?.name ?? "B" }),
      createdAt: best.createdAt,
    };
  }
  return { since, matches: n, net: Number(totals?.net ?? 0), bestHand };
}

/** The owner has read the summary: start the next one from now. */
export async function markSeen(db: Db, agentId: string, now = new Date()): Promise<void> {
  await db.update(agents).set({ ownerLastSeenAt: now }).where(eq(agents.id, agentId));
}
