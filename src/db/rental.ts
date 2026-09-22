import { gt, isNull, or } from "drizzle-orm";
import { seasonAt } from "../season.js";
import { agents, type AgentRow } from "./schema.js";

/**
 * Whether a rental is still running. Every rental ends at a season boundary;
 * past it, an agent that has not been renewed is expired and cannot play.
 *
 * This is the check that makes the season boundary exact. It is made where a
 * match is recorded, under both agents' locks, so a match can never land past
 * an agent's end - however late the boundary job runs, and even if it never
 * runs at all. The boundary job only tidies up after it.
 *
 * A null end never expires: house agents, which are not rented.
 */
export const rentalOpen = (row: Pick<AgentRow, "rentalEndsAt">, now = new Date()): boolean =>
  row.rentalEndsAt === null || row.rentalEndsAt.getTime() > now.getTime();

/** The same test as SQL, for matchmaking and the scheduler. */
export const rentalOpenSql = (now = new Date()) => or(isNull(agents.rentalEndsAt), gt(agents.rentalEndsAt, now));

/** When a rental taken out now ends: the end of the season it is taken out in. */
export const rentalEndFor = (now = new Date()): Date => seasonAt(now).end;
