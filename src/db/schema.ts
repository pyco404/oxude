import {
  bigint,
  bigserial,
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
     * Exact expected net against the roster, from the calculator. Private: shown
     * to the agent's owner while writing a brief, never on the ladder and never
     * on someone else's agent. Null until computed.
     */
    trueRating: doublePrecision("true_rating"),
    /** Fingerprint of the roster trueRating was computed against; recompute when it changes. */
    trueRatingRoster: text("true_rating_roster"),
    ownerId: uuid("owner_id"),
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

export type AgentRow = typeof agents.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;
export type RatingRow = typeof ratings.$inferSelect;
