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
    /** The agent's emoji: its identity at a glance, unique across all agents. See src/marks.ts. */
    mark: text("mark").unique(),
    /**
     * The money scale the agent plays at: every amount in its matches is the
     * band's. It decides who the agent meets and what a match is worth. Every
     * agent that existed before bands is a "B", which is the scale they were
     * all already playing at.
     */
    band: text("band").$type<BandName>().notNull().default("B"),
    /**
     * Superseded by `band`, kept so old matches and their transcripts still
     * explain themselves. Nothing reads it to decide a match any more.
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
    /** What each side risked: the band's worst match, which neither can exceed. */
    stake: integer("stake").notNull().default(0),
    /**
     * The money scale this match was played at. Recorded per match, not looked
     * up from the agent, because an owner may change band later and a result
     * must stay readable as the match it was. Matches from before bands are
     * "B", the scale they were played at.
     */
    band: text("band").$type<BandName>().notNull().default("B"),
    /** The full match log. This is the public transcript. */
    log: jsonb("log").$type<MatchLog>().notNull(),
    /**
     * House agents playing each other to keep the platform moving. Recorded and
     * shown like any match, but nothing is staked: no ledger rows, no chain
     * settlement, and no effect on ratings, records or the ladder.
     */
    exhibition: boolean("exhibition").notNull().default(false),
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
    /** Set for withdrawals, and for reversing one that never landed. */
    withdrawalId: uuid("withdrawal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_agent_idx").on(t.agentId, t.seq), index("ledger_match_idx").on(t.matchId)],
);

export type LedgerReason =
  | "rental-seed"
  | "match-settlement"
  | "adjustment"
  /** Money out of an agent's vault to its owner. */
  | "withdrawal"
  /** A withdrawal that could never land on chain, put back. */
  | "withdrawal-reversed";

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

/**
 * The outbox between the ledger and the chain. Renting and settling write a
 * row here in the same transaction as the ledger movement; a worker submits
 * them to the settlement program in order. A slow or failing chain therefore
 * never blocks or undoes a match - the ledger is authoritative, and the chain
 * catches up and records it.
 */
export const chainOps = pgTable(
  "chain_ops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Submission order: a vault must open before its first settlement. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /** register_owner: only in history; owners are now recorded as their vault opens. */
    kind: text("kind").$type<"open_vault" | "settle" | "register_owner" | "withdraw">().notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    matchId: uuid("match_id").references(() => matches.id),
    fromAgent: uuid("from_agent").references(() => agents.id),
    toAgent: uuid("to_agent").references(() => agents.id),
    amount: integer("amount").notNull(),
    /** open_vault (and, historically, register_owner): the owner's wallet; null for a house agent. */
    owner: text("owner"),
    /** open_vault: the salt that, hashed with the owner, gives the agent's id (src/agent-id.ts). */
    salt: text("salt"),
    /** withdraw: which withdrawal, whose signed transaction the op sends. */
    withdrawalId: uuid("withdrawal_id"),
    status: text("status").$type<"pending" | "confirmed" | "failed">().notNull().default("pending"),
    signature: text("signature"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chain_ops_status_idx").on(t.status, t.seq), index("chain_ops_match_idx").on(t.matchId)],
);

/**
 * A withdrawal from an agent's vault to its owner. Prepared by the server
 * (which co-signs), signed by the owner, then recorded in the ledger and the
 * outbox together and sent. "expired" means it could never land any more and
 * the ledger was put back.
 */
export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    ownerId: text("owner_id").notNull(),
    amount: integer("amount").notNull(),
    /** What the vault holds afterwards; the program checks this against the vault. */
    remaining: integer("remaining").notNull(),
    /** Taking the lot retires the agent. */
    retire: boolean("retire").notNull(),
    status: text("status").$type<WithdrawalStatus>().notNull().default("prepared"),
    /** The transaction as prepared, settler-signed, base64; the owner must sign exactly this. */
    preparedTx: text("prepared_tx").notNull(),
    /** The same, with the owner's signature. */
    signedTx: text("signed_tx"),
    lastValidBlockHeight: bigint("last_valid_block_height", { mode: "number" }).notNull(),
    signature: text("signature"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("withdrawals_agent_idx").on(t.agentId, t.status)],
);

export type WithdrawalStatus = "prepared" | "submitted" | "confirmed" | "expired";

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
 * Balance an agent starts with when rented. Sized so a rental survives a week
 * of autoplay rather than a single bad hour: at 180 - the old seed, chosen when
 * a match could never move more than 60 - a week of play busted most agents,
 * because a band C match can move 90. At 900 about four agents in five last the
 * week in band B, better than 96% in band A, and around 65% in band C, which is
 * the shorter, wilder run that band is meant to be.
 */
export const STARTING_BALANCE = 900;
/**
 * The least a vault may hold and still be worth keeping open. The chain
 * enforces the same floor on withdrawals, so this must not drop below the
 * program's MIN_STAKE. Whether an agent can play is a question about its band,
 * not this: see `canAffordBand`.
 */
export const MIN_STAKE = 10;
/** Each owner's first elicitation costs them nothing. */
export const FREE_ELICITATIONS = 1;

/**
 * Stake bands: money scales, not ceilings. Every amount in a match is multiplied
 * by the band's factor, so the decision each agent faces is identical in all
 * three - a fold costs the same fraction of the pot everywhere - and the
 * presets stay exactly as balanced as they were measured to be. What differs is
 * what a match is worth, which is the whole point: the old ceilings could not
 * differ, because a match could never move more than 60, so 40-60 played
 * identically to 20-40.
 *
 * `worstMatch` is the most a single match can move: two rounds at the raised
 * bet, not three. A match is first to two rounds, so the winner can take at
 * most two, and a 2-1 match nets only one round. Enumerating every draw and
 * flip for all four presets confirms it - band B's widest net is exactly 40,
 * and no decision table can beat that, because a round is never worth more
 * than the raised bet. There is no settlement clamp any more, so an agent must
 * be able to pay this outright to play in the band at all.
 */
export const STAKE_BANDS = [
  { name: "A", factor: 0.5, ante: 2, baseBet: 5, raisedBet: 10, worstMatch: 20 },
  { name: "B", factor: 1, ante: 4, baseBet: 10, raisedBet: 20, worstMatch: 40 },
  { name: "C", factor: 1.5, ante: 6, baseBet: 15, raisedBet: 30, worstMatch: 60 },
] as const;

export type BandName = (typeof STAKE_BANDS)[number]["name"];
export type StakeBand = (typeof STAKE_BANDS)[number];

/** The band a rental starts in when its owner says nothing. */
export const DEFAULT_BAND: BandName = "B";

export function bandByName(name: BandName): StakeBand {
  const band = STAKE_BANDS.find((b) => b.name === name);
  if (!band) throw new Error(`no stake band ${name}`);
  return band;
}

/** The stakes a match in this band is played at. */
export function bandStakes(name: BandName): Stakes {
  const b = bandByName(name);
  return { ante: b.ante, baseBet: b.baseBet, raisedBet: b.raisedBet };
}

/**
 * Whether a balance can cover this band's worst match. With no clamp, a match
 * that cannot be paid cannot be played, so this is what decides both
 * matchmaking and retirement.
 */
export function canAffordBand(balance: number, name: BandName): boolean {
  return balance >= bandByName(name).worstMatch;
}

/**
 * The bands a balance could play, richest first. Used to tell an owner what is
 * still open to them once they are down, never to move an agent on its own.
 */
export function affordableBands(balance: number): BandName[] {
  return STAKE_BANDS.filter((b) => balance >= b.worstMatch).map((b) => b.name);
}

/**
 * A net expressed on band B's scale, so results from different bands can be
 * compared. A band C win of 30 is the same achievement as a band B win of 20.
 * The ladder and every net-per-match figure are normalised this way; the money
 * an agent actually holds never is.
 */
export function normaliseNet(net: number, name: BandName): number {
  return net / bandByName(name).factor;
}

export type AgentRow = typeof agents.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;
export type RatingRow = typeof ratings.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
export type ChainOpRow = typeof chainOps.$inferSelect;
