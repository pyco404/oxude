import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { chips, DEVNET_CHIP_RATE } from "../chips.js";
import { matches, rentals, seasons } from "./schema.js";
import { prizeTable, type PrizeRow } from "./standings.js";
import { seasonByKey } from "../season.js";

/**
 * A season's statement: what the season did, and what it would pay.
 *
 * economy.md promises a published statement that reconciles both sides of the
 * money - what came in, what went out, and what was burned. This is the shape
 * of it, filled in as far as the game currently goes.
 *
 * The prize side is deliberately empty. The reward wallet is funded by the
 * creator-fee split, which cannot be configured before legal review, so there
 * is no pool, no payout curve and no amount per place. What there is, and what
 * this carries, is the order those places would pay in. When the pool opens,
 * the work is to fill in `prizes.pool` and a per-place amount; nothing here
 * has to be rearranged to make room for it, and nothing here quietly reads as
 * a payout in the meantime.
 *
 * Everything is in chips. The ledger holds base units and the rentals table
 * holds base units; both are converted here, at the edge, exactly once.
 */
export type SeasonStatement = {
  season: {
    key: string;
    number: number;
    startsAt: Date;
    endsAt: Date;
    /** "closed" means the figures below are final and will not move again. */
    status: "open" | "closed";
  };
  play: {
    /** Player against player: what placement is decided on. */
    rankedMatches: number;
    /** Chips put at risk in those matches, both sides counted. */
    rankedStaked: number;
    /** Every staked match, house opponents included. */
    stakedMatches: number;
    stakedTotal: number;
    /** Nothing is staked in these, so they appear in no money line. */
    exhibitions: number;
    /**
     * The sum of every side's net across staked matches. A match is zero-sum
     * between its two agents, so this is zero, and a statement that says so is
     * a statement that has checked. A non-zero figure means a settlement was
     * written that no match accounts for.
     */
    netAcrossAllSides: number;
  };
  burned: {
    /** Rentals paid for in this season. The fee is burned; it never enters a vault. */
    rentals: number;
    /** Chips burned in those fees. */
    chips: number;
  };
  prizes: {
    /**
     * False until the creator-fee split is configured and the reward wallet is
     * funded. While it is false, every amount below is null rather than zero:
     * "nothing was paid" and "we do not know yet" must not look alike.
     */
    funded: false;
    pool: null;
    paid: null;
    /** How many agents met the minimum and would be placed. */
    placed: number;
    minMatches: number;
    basis: "ranked net per chip staked";
    /** The order prizes would pay in. Frozen once the season closes. */
    places: PrizeRow[];
  };
};

/**
 * `places` is capped: a statement is a document, and a season with a thousand
 * agents does not want every one of them in the prize section. Everyone
 * placed is in the table proper regardless of this.
 */
export async function seasonStatement(db: Db, key: string, places = 50): Promise<SeasonStatement> {
  const season = seasonByKey(key);
  const [row] = await db.select({ status: seasons.status }).from(seasons).where(eq(seasons.key, key)).limit(1);
  const inSeason = eq(matches.season, key);

  const [play] = await db
    .select({
      rankedMatches: sql<number>`count(*) filter (where ${matches.ranked})::int`,
      rankedStaked: sql<number>`coalesce(sum(${matches.stake} * 2) filter (where ${matches.ranked}), 0)::bigint`,
      stakedMatches: sql<number>`count(*) filter (where not ${matches.exhibition})::int`,
      stakedTotal: sql<number>`coalesce(sum(${matches.stake} * 2) filter (where not ${matches.exhibition}), 0)::bigint`,
      exhibitions: sql<number>`count(*) filter (where ${matches.exhibition})::int`,
      net: sql<number>`coalesce(sum(${matches.netA} + ${matches.netB}) filter (where not ${matches.exhibition}), 0)::bigint`,
    })
    .from(matches)
    .where(inSeason);

  // Rentals are not tagged with a season - a rental is an act, not a match -
  // so they are taken by the window they were paid in. Only rentals that
  // landed: a prepared or expired one burned nothing.
  const [rent] = await db
    .select({
      count: sql<number>`count(*)::int`,
      fee: sql<number>`coalesce(sum(${rentals.fee}), 0)::bigint`,
    })
    .from(rentals)
    .where(
      and(
        eq(rentals.status, "confirmed"),
        gte(rentals.createdAt, season.start),
        lt(rentals.createdAt, season.end),
      ),
    );

  const table = await prizeTable(db, key);
  return {
    season: {
      key,
      number: season.number,
      startsAt: season.start,
      endsAt: season.end,
      status: row?.status === "closed" ? "closed" : "open",
    },
    play: {
      rankedMatches: Number(play?.rankedMatches ?? 0),
      rankedStaked: Number(play?.rankedStaked ?? 0),
      stakedMatches: Number(play?.stakedMatches ?? 0),
      stakedTotal: Number(play?.stakedTotal ?? 0),
      exhibitions: Number(play?.exhibitions ?? 0),
      netAcrossAllSides: Number(play?.net ?? 0),
    },
    burned: {
      rentals: Number(rent?.count ?? 0),
      // Rentals are the deposit flow, which is the only flow that ever charged
      // rent: the seed flow gave agents away.
      chips: chips(Number(rent?.fee ?? 0), DEVNET_CHIP_RATE),
    },
    prizes: {
      funded: false,
      pool: null,
      paid: null,
      placed: table.rows.filter((r) => r.prizeRank !== null).length,
      minMatches: table.minMatches,
      basis: "ranked net per chip staked",
      places: table.rows.slice(0, places),
    },
  };
}
