import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { MatchLog, Seat } from "../types.js";
import type { Policy } from "../agents/policy.js";
import type { Deal, Stakes, TurnOrder } from "../round.js";

/**
 * Everything needed to replay a match: the rules it was played under, plus the
 * preset version in force at the time. The version is provenance only - replay
 * uses each agent's stored table, so it survives a preset change.
 */
export type RulesConfig = { turnOrder: TurnOrder; deal: Deal; stakes: Stakes; presetVersion: string };

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Set for a roster agent built from a shipped preset. */
    presetName: text("preset_name"),
    /** Set for a player agent: what the model was told when its table was elicited. */
    brief: text("brief"),
    /**
     * The decision table this agent plays, for preset and player agents alike.
     * Filled once when the agent is created - never per match - and snapshotted
     * for presets too, so a stored transcript replays for good even if a preset
     * is retuned later.
     */
    policyTable: jsonb("policy_table").$type<Policy>(),
    /**
     * The stakes the table was built for. A table is priced: a pot-odds fold at
     * ante 4 is not the same decision at ante 8, so playing it at other stakes
     * would misrepresent the agent. The runner refuses rather than mispricing.
     */
    policyStakes: jsonb("policy_stakes").$type<Stakes>(),
    /**
     * The owner's per-match ceiling. It decides which band the agent plays in,
     * and so who it meets; it does not cap what a match settles.
     */
    maxStake: integer("max_stake").notNull().default(60),
    /**
     * Exact expected net against the roster, from the calculator. Private: shown
     * to the agent's owner while writing a brief, never on the ladder and never
     * on someone else's agent. Null until computed.
     */
    trueRating: doublePrecision("true_rating"),
    /** Fingerprint of the roster trueRating was computed against; recompute when it changes. */
    trueRatingRoster: text("true_rating_roster"),
    /** The owner's wallet: a base58 Solana public key. */
    ownerId: text("owner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [index("agents_owner_idx").on(t.ownerId), index("agents_true_rating_idx").on(t.trueRating)],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic, so "the last N matches" is deterministic even within one timestamp. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    agentA: uuid("agent_a")
      .notNull()
      .references(() => agents.id),
    agentB: uuid("agent_b")
      .notNull()
      .references(() => agents.id),
    /** uint32; wider than a Postgres integer, so bigint. */
    seed: bigint("seed", { mode: "number" }).notNull(),
    rulesConfig: jsonb("rules_config").$type<RulesConfig>().notNull(),
    winner: text("winner").$type<Seat>(),
    netA: integer("net_a").notNull(),
    netB: integer("net_b").notNull(),
    /** What each side risked. Neither can lose more than this in one match. */
    stake: integer("stake").notNull().default(0),
    /** The full match log. This is the public transcript. */
    log: jsonb("log").$type<MatchLog>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("matches_agent_a_idx").on(t.agentA, t.createdAt),
    index("matches_agent_b_idx").on(t.agentB, t.createdAt),
    index("matches_created_idx").on(t.createdAt),
    index("matches_seq_idx").on(t.seq),
  ],
);

/**
 * Every movement of money. Balances are the sum of an agent's rows rather than
 * a column that is incremented: the same reasoning as ratings, so a balance
 * cannot drift away from the events that produced it.
 */
export const ledger = pgTable(
  "ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic, so a balance at a point in time is well defined. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    /** Signed: positive is money in. */
    amount: integer("amount").notNull(),
    reason: text("reason").$type<LedgerReason>().notNull(),
    /** Set for settlements. */
    matchId: uuid("match_id").references(() => matches.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_agent_idx").on(t.agentId, t.seq), index("ledger_match_idx").on(t.matchId)],
);

export type LedgerReason = "rental-seed" | "match-settlement" | "adjustment";

/** One row per model call, so the first elicitation for an owner can be free. */
export const elicitations = pgTable(
  "elicitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The owner's wallet public key. */
    ownerId: text("owner_id").notNull(),
    /** "preview" rates a brief; "rent" writes an agent's table. */
    kind: text("kind").$type<"preview" | "rent">().notNull(),
    /** True when it did not count against the owner's allowance. */
    free: boolean("free").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("elicitations_owner_idx").on(t.ownerId, t.createdAt)],
);

/**
 * Single-use sign-in challenges. A nonce is bound to one public key, expires
 * quickly, and is burnt on first use, so a captured signature cannot be
 * replayed.
 */
export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  publicKey: text("public_key").notNull(),
  /** The exact text the wallet is asked to sign. Verified byte for byte. */
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/**
 * Sessions after a verified signature. Only a hash of the token is stored, so
 * a read of this table does not hand out working sessions.
 */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_owner_idx").on(t.ownerId)],
);

export const ratings = pgTable("ratings", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  matchesPlayed: integer("matches_played").notNull().default(0),
  /** All-time net won. This is what the ladder ranks on: a fact, not an estimate. */
  cumulativeNet: bigint("cumulative_net", { mode: "number" }).notNull().default(0),
  /**
   * Mean net over the agent's last RATING_WINDOW matches. Displayed as recent
   * form, never as a ranking: with ~23 chips of per-match variance its own
   * spread is about +/-5.6, far wider than the gaps between agents.
   */
  rollingNet50: doublePrecision("rolling_net_50").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Matches counted by the displayed recent-form figure. */
export const RATING_WINDOW = 50;

/**
 * Balance an agent starts with when rented. Measured over 5,000 seeded matches:
 * at 60 four agents in five busted, half of them inside 13 matches, which made
 * ruin the default experience; at 180 about a quarter bust, typically around
 * match 30, so busting is something players see without it being the norm.
 */
export const STARTING_BALANCE = 180;
/** Below this, an agent cannot cover a match and is not matched. */
export const MIN_STAKE = 10;
/** The most a match can move: three rounds at the raised bet. */
export const MAX_EXPOSURE = 60;
/** Each owner's first elicitation costs them nothing. */
export const FREE_ELICITATIONS = 1;

/**
 * Ceiling bands. A ceiling says what kind of match an agent wants, and agents
 * are matched inside one band; it does not cap settlement. Capping settlement
 * made the lowest ceiling dominant, because it dragged a stronger opponent
 * down to it.
 */
export const CEILING_BANDS = [
  { name: "10-20", min: 10, max: 20 },
  { name: "20-40", min: 20, max: 40 },
  { name: "40-60", min: 40, max: 60 },
] as const;

export type CeilingBand = (typeof CEILING_BANDS)[number]["name"];

/** Which band a ceiling sits in. Upper bound wins at a boundary. */
export function bandOf(ceiling: number): CeilingBand {
  if (ceiling <= 20) return "10-20";
  if (ceiling <= 40) return "20-40";
  return "40-60";
}

export type AgentRow = typeof agents.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;
export type RatingRow = typeof ratings.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
