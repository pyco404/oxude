import { and, eq, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import type { Db } from "./client.js";
import { pickOpponent, runMatch } from "./runner.js";
import { balanceOf, StakeError } from "./ledger.js";
import {
  agents,
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
  } = {},
): Promise<TickResult> {
  const intervalMs = options.intervalMs ?? AUTOPLAY_INTERVAL_MS;
  const result: TickResult = { played: [], waiting: [], stopped: [] };

  for (const row of await dueAgents(db, intervalMs, options.now)) {
    try {
      const check = await checkAgent(db, row);
      if (!check.play) {
        await stopAgent(db, row.id, check.reason);
        result.stopped.push({ agentId: row.id, reason: check.reason });
        continue;
      }
      const pick = await pickOpponent(db, row.id, { spread: true });
      const { match } = await runMatch(db, row.id, pick.opponentId);
      await clearStop(db, row.id, new Date());
      result.played.push(row.id);
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
        result.waiting.push(row.id);
        continue;
      }
      options.onError?.(error);
    }
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
      await tick(db, { intervalMs, onMatch: options.onMatch, onError: options.onError });
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
