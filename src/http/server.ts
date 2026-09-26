import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { eq, sql } from "drizzle-orm";
import { elicitPolicy } from "../agents/llm.js";
import { validatePolicy, type Policy } from "../agents/policy.js";
import { headlineFor, renderTranscript } from "../transcript.js";
import { PRESET_DESCRIPTIONS, PRESET_NAMES, type PresetName } from "../presets.js";
import type { Db } from "../db/client.js";
import { agents, matches, withdrawals, AUTOPLAY_INTERVAL_MS } from "../db/schema.js";
import { isFirstElicitationFree, recordElicitation, StakeError, statement } from "../db/ledger.js";
import {
  activeAgentsOf,
  agentsOf,
  createAgent,
  setBand,
  snapshotPreset,
  leaderboard,
  ownerAgent,
  pickOpponent,
  publicAgent,
  roster,
  runMatch,
  type LadderTab,
  bandCounts,
} from "../db/runner.js";
import { autoplayStatus, markSeen, setAutoplay, sinceYouLeft } from "../db/autoplay.js";
import { renewAgent, rentalStatus, RenewError } from "../db/seasons.js";
import { prizeTable } from "../db/standings.js";
import { seasonStatement } from "../db/statement.js";
import { characterOf, createCharacter, isDefaultName, NO_MODEL, ownerCharacter, portraitSvg, publicCharacter, type CharacterDeps } from "../character/store.js";
import { moderate, type Verdict } from "../character/moderation.js";
import { traitsOf } from "../character/trait-store.js";
import { dayStart, seasonAt, seasonByKey, GRACE_MS, RENEWAL_REMINDER_MS } from "../season.js";
import { previewPolicy, refreshTrueRatings, rosterProfile } from "../db/rating.js";
import { agentRecord, latestBluff, matchActivity, recentMatches } from "../db/feed.js";
import {
  prepareWithdrawal,
  submitWithdrawal,
  withdrawable,
  WithdrawalError,
  type WithdrawalChain,
} from "../db/withdrawals.js";
import { STAKE_BANDS, affordableBands, bandByName, canAffordBand, type BandName } from "../db/schema.js";
import { SURVIVAL, SURVIVAL_HOURS, SURVIVAL_PACE_MINUTES, SURVIVAL_SEED_BALANCE, survivalFor } from "../survival.js";

import { RateLimiter, type RateLimitRule } from "./rate-limit.js";
import { LiveStream, resumeFrom, type LiveOptions } from "./live.js";
import { settlementStatus, settlementLag, SETTLEMENT_LAG_ALARM_MS } from "../chain/worker.js";
import { DEVNET_CHIP_RATE, rateOf, type Funding } from "../chips.js";
import { faucetStatus, grantFaucet, FaucetError, type FaucetChain } from "../db/faucet.js";
import { prepareRental, rejectRental, submitRental, RentalError, type RentalChain } from "../db/rentals.js";
import { checkDeposit, depositBlocked, prepareDeposit, submitDeposit, DepositError, type DepositChain } from "../db/deposits.js";
import { rentals } from "../db/schema.js";
import { baseUnits, chips as toChips } from "../chips.js";
import { AuthError, isPublicKey, issueNonce, ownerForToken, revokeSession, verifySignIn } from "../auth/wallet.js";

/**
 * Thin HTTP layer over the runner.
 *
 * Identity is a Solana wallet. A caller asks for a nonce, signs the returned
 * message with its wallet, and exchanges the signature for a session token
 * sent as "Authorization: Bearer <token>". The owner of everything below is
 * the wallet public key behind that session - never a value the caller simply
 * asserts.
 */
export type Elicit = (input: { brief: string }) => Promise<{ table: Policy | null; reason?: string }>;

export type AppOptions = {
  db: Db;
  /** Defaults to one model call per request. Injected in tests so they never spend money. */
  elicit?: Elicit;
  /** Applies to the endpoints that can reach a model. Default 5 a minute. */
  rateLimit?: RateLimitRule;
  /** Applies to playing matches: no model call, but it writes rows. Default 30 a minute. */
  playRateLimit?: RateLimitRule;
  /** The domain named in the sign-in message. Defaults to AUTH_DOMAIN or localhost:3000. */
  authDomain?: string;
  /** Applies to nonce requests, which anyone can make. Default 20 a minute. */
  nonceRateLimit?: RateLimitRule;
  /**
   * The seed flow is closing. No new seed rentals, and no renewals of the ones
   * that exist - which is all it takes, because every rental already ends at a
   * season boundary. They play to the end of the season they are in, then
   * expire, then lapse after the usual grace with their balance withdrawable.
   */
  seedCutover?: { closed: boolean };
  /**
   * Faucet grants per wallet, on top of the one-a-day rule in the ledger.
   * Default 3 an hour.
   */
  faucetRateLimit?: RateLimitRule;
  /** Renting and topping up per wallet. Default 5 an hour. */
  rentRateLimit?: RateLimitRule;
  /**
   * The same per address. Looser than the per-wallet rules on purpose: an
   * address is a poor proxy for a person, because a household, an office or a
   * mobile network share one, so a limit tight enough to stop a script would
   * also turn away the third real person behind a router. Wallets are the other
   * way round - one person can make any number - which is why neither key works
   * alone. Default 20 rentals and 12 faucet grants an hour.
   */
  rentAddressRateLimit?: RateLimitRule;
  faucetAddressRateLimit?: RateLimitRule;
  /**
   * Browser origins allowed to call this API. The web app runs on its own
   * origin, so without this every request from it fails before it is sent.
   * Defaults to CORS_ORIGIN or localhost:3000.
   */
  corsOrigin?: string;
  now?: () => number;
  /** The chain, for withdrawals: the settler builds and co-signs them. Without it they are unavailable. */
  chain?: WithdrawalChain;
  /**
   * Wallets that may read /admin. Defaults to ADMIN_WALLETS, and to nothing at
   * all when that is unset - a deployment that forgets it gets no admin page,
   * not an open one.
   */
  adminWallets?: string[];
  /**
   * What /admin reports. Built where the chain clients live (scripts/serve.ts),
   * because the http layer has no settler, no connection and no business
   * acquiring either. Without it /admin answers 503 for an allowed wallet.
   */
  health?: () => Promise<unknown>;
  /**
   * The devnet faucet. Absent on every other cluster, and not by configuration:
   * what builds it refuses any chain but devnet (src/chain/faucet.ts). Without
   * it the faucet endpoints answer 503.
   */
  faucet?: FaucetChain;
  /**
   * The deposit-funded flow. Absent until its program is deployed and
   * configured, and while it is absent every rental takes the seed flow.
   *
   * `fee` and `chipRate` are read from the program's own config at startup
   * rather than set here, so the price a player is quoted is the price the
   * program will insist on when their transaction arrives.
   */
  deposit?: {
    chain: RentalChain & DepositChain & WithdrawalChain;
    /** Base units burned per rental, as the program's config carries it. */
    fee: number;
    /** Base units to one chip this season. */
    chipRate: number;
    /** Whose rentals take this flow. */
    allow: (ownerId: string) => boolean;
  };
  /**
   * Base units to one chip, as the settlement program's config carries it.
   * Defaults to devnet's fixed rate of one chip to one whole token.
   */
  chipRate?: number;
  /**
   * How often autoplay plays one agent, so the panel's countdown matches the
   * loop that is actually running. Defaults to AUTOPLAY_INTERVAL_MS from the
   * environment, which is what scripts/serve.ts starts the loop with.
   */
  autoplayIntervalMs?: number;
  /**
   * The model calls characters use: checking a chosen name, writing a bio for
   * a brief-written agent. Without them, templates and the local rules only -
   * which is the default, so tests never reach a model.
   */
  character?: CharacterDeps;
  /** The live stream's pacing and limits. Tests shorten the poll. */
  live?: LiveOptions;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024;

const defaultElicit: Elicit = async ({ brief }) => {
  const { log } = await elicitPolicy({ brief });
  return log.policy ? { table: log.policy } : { table: null, reason: log.fallback?.reason ?? "no table returned" };
};

/** A response that is not JSON: a portrait, served as the image it is. */
class Raw {
  constructor(
    readonly body: string,
    readonly contentType: string,
    readonly headers: Record<string, string> = {},
  ) {}
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function createApp(options: AppOptions): Server {
  const { db } = options;
  const autoplayIntervalMs =
    options.autoplayIntervalMs ?? (Number(process.env["AUTOPLAY_INTERVAL_MS"]) || AUTOPLAY_INTERVAL_MS);
  const elicit = options.elicit ?? defaultElicit;
  const chipRate = options.chipRate ?? DEVNET_CHIP_RATE;
  // No model unless one is given: scripts/serve.ts passes Haiku when a key is set.
  const characterDeps = options.character ?? NO_MODEL;
  const limiter = new RateLimiter(options.rateLimit ?? { limit: 5, windowMs: 60_000 }, options.now);
  // Playing costs no money but writes a match row and rewrites two ratings;
  // unbounded, it is a cheap way to bloat the transcript table.
  const playLimiter = new RateLimiter(options.playRateLimit ?? { limit: 30, windowMs: 60_000 }, options.now);
  const nonceLimiter = new RateLimiter(options.nonceRateLimit ?? { limit: 20, windowMs: 60_000 }, options.now);
  const faucetLimiter = new RateLimiter(options.faucetRateLimit ?? { limit: 3, windowMs: 3_600_000 }, options.now);
  const rentLimiter = new RateLimiter(options.rentRateLimit ?? { limit: 5, windowMs: 3_600_000 }, options.now);
  const faucetByAddress = new RateLimiter(options.faucetAddressRateLimit ?? { limit: 12, windowMs: 3_600_000 }, options.now);
  const rentByAddress = new RateLimiter(options.rentAddressRateLimit ?? { limit: 20, windowMs: 3_600_000 }, options.now);

  /**
   * Charges an attempt against the wallet *and* the address it came from.
   *
   * The older limiter keys on one or the other - the wallet when signed in,
   * otherwise the address - which leaves a gap either way: one wallet behind
   * many addresses, or one address cycling through wallets, which costs nothing
   * to make. Both buckets have to have room, and a request refused by the
   * second does not spend the first.
   */
  function spendBoth(
    perWallet: RateLimiter,
    perAddress: RateLimiter,
    ownerId: string,
    clientKey: string,
    what: string,
  ): void {
    const byWallet = perWallet.take(ownerId);
    if (!byWallet.ok) {
      throw new HttpError(429, `too many ${what} from this wallet; try again in ${byWallet.retryAfterSeconds}s`, {
        retryAfter: byWallet.retryAfterSeconds,
      });
    }
    const byAddress = perAddress.take(clientKey);
    if (!byAddress.ok) {
      // Give the wallet its attempt back: it did nothing wrong, and it should
      // not lose an hour's allowance to whoever else is behind this address.
      perWallet.refund(ownerId);
      throw new HttpError(429, `too many ${what} from this connection; try again in ${byAddress.retryAfterSeconds}s`, {
        retryAfter: byAddress.retryAfterSeconds,
      });
    }
  }
  const authDomain = options.authDomain ?? process.env["AUTH_DOMAIN"] ?? "localhost:3000";
  // The table a player was shown when they rated a brief is the table they rent,
  // with no second model call: the model is not deterministic, so asking again
  // could hand them a different agent from the one they just saw rated. Keyed by
  // owner and exact brief; tables still only ever come from the model.
  const rated = new Map<string, { table: Policy; at: number }>();
  const RATED_TTL_MS = 60 * 60_000;
  const ratedKey = (ownerId: string, brief: string) => `${ownerId}\n${brief}`;
  const now = options.now ?? Date.now;
  const takeRated = (ownerId: string, brief: string): Policy | undefined => {
    const hit = rated.get(ratedKey(ownerId, brief));
    return hit && now() - hit.at < RATED_TTL_MS ? hit.table : undefined;
  };
  const remember = (ownerId: string, brief: string, table: Policy) => {
    if (rated.size >= 5_000) rated.delete(rated.keys().next().value!);
    rated.set(ratedKey(ownerId, brief), { table, at: now() });
  };

  const routes: [string, RegExp, (ctx: Ctx) => Promise<unknown>][] = [
    ["POST", /^\/auth\/nonce$/, postNonce],
    ["POST", /^\/auth\/verify$/, postVerify],
    ["POST", /^\/auth\/logout$/, postLogout],
    ["GET", /^\/auth\/me$/, getMe],
    ["POST", /^\/agents$/, postAgent],
    ["GET", /^\/agents\/([^/]+)$/, getAgent],
    ["POST", /^\/agents\/([^/]+)\/play$/, postPlay],
    ["POST", /^\/agents\/([^/]+)\/band$/, postBand],
    ["POST", /^\/agents\/([^/]+)\/autoplay$/, postAutoplay],
    ["POST", /^\/agents\/([^/]+)\/seen$/, postSeen],
    ["POST", /^\/agents\/([^/]+)\/renew$/, postRenew],
    ["GET", /^\/agents\/([^/]+)\/ledger$/, getLedger],
    ["GET", /^\/agents\/([^/]+)\/portrait\.svg$/, getPortrait],
    ["GET", /^\/matches$/, getFeed],
    ["GET", /^\/matches\/([^/]+)$/, getMatch],
    ["GET", /^\/agents\/([^/]+)\/matches$/, getAgentMatches],
    ["GET", /^\/agents\/([^/]+)\/withdrawable$/, getWithdrawable],
    ["POST", /^\/agents\/([^/]+)\/withdrawals$/, postWithdrawal],
    ["POST", /^\/withdrawals\/([^/]+)\/submit$/, postWithdrawalSubmit],
    ["GET", /^\/withdrawals\/([^/]+)$/, getWithdrawal],
    ["GET", /^\/ladder$/, getLadder],
    ["GET", /^\/stats$/, getStats],
    ["GET", /^\/presets$/, getPresets],
    ["GET", /^\/roster$/, getRoster],
    ["GET", /^\/season$/, getSeason],
    ["GET", /^\/prizes$/, getPrizes],
    ["GET", /^\/statement$/, getStatement],
    ["GET", /^\/admin$/, getAdmin],
    ["POST", /^\/agents\/([^/]+)\/deposits$/, postDeposit],
    ["POST", /^\/deposits\/([^/]+)\/submit$/, postDepositSubmit],
    ["POST", /^\/rentals\/([^/]+)\/submit$/, postRentalSubmit],
    ["POST", /^\/rentals\/([^/]+)\/reject$/, postRentalReject],
    ["GET", /^\/rentals\/([^/]+)$/, getRental],
    ["GET", /^\/faucet$/, getFaucet],
    ["POST", /^\/faucet$/, postFaucet],
    ["POST", /^\/preview$/, postPreview],
  ];

  type Ctx = {
    params: string[];
    query: URLSearchParams;
    body: Record<string, unknown>;
    /** The wallet behind the caller's session, or null when signed out. */
    ownerId: string | null;
    /** The raw session token, for logout. */
    token: string | null;
    clientKey: string;
    /** Throws 401 unless the caller has a live session. */
    requireOwner: () => string;
    /**
     * Charges a model call against the caller's allowance, unless this is the
     * owner's first: nobody should have to spend one before seeing a transcript.
     */
    spend: (kind: "preview" | "rent") => Promise<boolean>;
    /** Throws 429 when the caller has played too many matches this minute. */
    spendPlay: () => void;
    refund: () => void;
  };

  async function postNonce(ctx: Ctx) {
    const result = nonceLimiter.take(ctx.clientKey);
    if (!result.ok) {
      throw new HttpError(429, "too many sign-in attempts", { retryAfterSeconds: result.retryAfterSeconds });
    }
    const publicKey = ctx.body["publicKey"];
    if (!isPublicKey(publicKey)) throw new HttpError(400, "publicKey must be a base58 Solana public key");
    const issued = await issueNonce(db, publicKey, authDomain);
    return { nonce: issued.nonce, message: issued.message, expiresAt: issued.expiresAt };
  }

  async function postVerify(ctx: Ctx) {
    const { publicKey, nonce, signature } = ctx.body;
    if (typeof publicKey !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
      throw new HttpError(400, "publicKey, nonce and signature are required");
    }
    try {
      const session = await verifySignIn(db, { publicKey, nonce, signature });
      return { token: session.token, ownerId: session.ownerId, expiresAt: session.expiresAt };
    } catch (error) {
      // One status for every failure: the caller learns it did not verify, not why.
      if (error instanceof AuthError) throw new HttpError(401, "sign-in failed", { reason: error.message });
      throw error;
    }
  }

  async function postLogout(ctx: Ctx) {
    ctx.requireOwner();
    await revokeSession(db, ctx.token!);
    return { signedOut: true };
  }

  async function getMe(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    // Every agent this wallet owns, so a second device shows the same ones as the first.
    const deposit = options.deposit;
    const viaDeposit = Boolean(deposit?.allow(ownerId));
    return {
      ownerId,
      agents: await agentsOf(db, ownerId),
      /**
       * What renting would cost this wallet, and how. The screen needs this
       * before it can ask for anything: on the deposit flow it has to take an
       * amount and warn that the agent cannot play until the transaction lands,
       * and on the seed flow neither applies.
       */
      funding: {
        mode: viaDeposit ? ("deposit" as const) : ("seed" as const),
        feeChips: viaDeposit ? toChips(deposit!.fee, deposit!.chipRate) : 0,
      },
      /** Set while the seed flow is closing, so the screen can say so. */
      cutover: cutoverNotice(),
    };
  }

  /** What to tell an owner about the seed flow closing, or null if it is not. */
  function cutoverNotice(now = new Date()) {
    if (!options.seedCutover?.closed) return null;
    const season = seasonAt(now);
    return {
      closed: true as const,
      /** Seed agents play to here and no further. */
      endsAt: season.end,
      /** And their balance can be taken until here. */
      withdrawableUntil: new Date(season.end.getTime() + GRACE_MS),
    };
  }

  async function postAgent(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    // Before anything is created or any model is called: renting writes rows,
    // and on the deposit flow it also builds a transaction over an RPC.
    spendBoth(rentLimiter, rentByAddress, ownerId, ctx.clientKey, "rentals");
    const presetName = ctx.body["presetName"] as PresetName | undefined;
    const brief = typeof ctx.body["brief"] === "string" ? ctx.body["brief"].trim() : "";
    if (!presetName && !brief) throw new HttpError(400, "presetName or brief is required");
    if (presetName && !PRESET_NAMES.includes(presetName)) {
      throw new HttpError(400, `unknown preset ${presetName}`, { known: PRESET_NAMES });
    }
    // A name is optional: without one - or with one the rent screen filled in -
    // the agent's character is named for it. A name the owner chose is checked
    // before anything is spent on a model call for the brief.
    const given = String(ctx.body["name"] ?? "").trim();
    const chosenName = given && !isDefaultName(given) ? given : null;
    let nameVerdict: Verdict | undefined;
    if (chosenName) {
      nameVerdict = await moderate(chosenName, "name", characterDeps.check);
      if (!nameVerdict.ok) throw new HttpError(400, nameVerdict.reason ?? "that name can't be used");
    }
    const name = chosenName ?? "New agent";

    let table: Policy | undefined;
    let freeCall = false;
    let reused = false;
    if (!presetName && (table = takeRated(ownerId, brief))) {
      reused = true;
    } else if (!presetName) {
      freeCall = await ctx.spend("rent");
      const result = await elicit({ brief });
      if (!result.table) {
        // The model could not be reached or answered unusably: no agent, no charge.
        throw new HttpError(503, "could not elicit a table for that brief", { reason: result.reason });
      }
      table = validatePolicy(result.table);
    }

    const wantedBand = ctx.body["band"];
    if (wantedBand !== undefined && !STAKE_BANDS.some((b) => b.name === wantedBand)) {
      throw new HttpError(400, `band must be one of ${STAKE_BANDS.map((b) => b.name).join(", ")}`);
    }
    // Which flow this rental takes. A deposit rental is paid for by its owner
    // and cannot be created here and now: it needs a transaction signed in
    // their wallet, so the answer is the agent plus that transaction.
    const deposit = options.deposit;
    const viaDeposit = Boolean(deposit?.allow(ownerId));
    const cutover = cutoverNotice();
    if (!viaDeposit && cutover) {
      throw new HttpError(
        503,
        `Renting is paused while Oxude moves to the new settlement program, where you fund an agent yourself instead of being handed a starting balance. Agents rented before the move play until ${cutover.endsAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
        { cutover },
      );
    }
    let depositAmount = 0;
    if (viaDeposit) {
      const asked = ctx.body["deposit"];
      if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) {
        throw new HttpError(400, "deposit is required, in chips, and must be above zero");
      }
      depositAmount = baseUnits(Math.floor(asked), deposit!.chipRate);
    }

    // One agent in play per wallet. The check and the rental share a transaction
    // and a lock on this wallet, so renting from two devices at once still
    // leaves one agent, not two.
    const { row, rental } = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`);
      const active = await activeAgentsOf(tx as unknown as Db, ownerId);
      if (active.length > 0) {
        const held = active.map((a) => a.name).join(", ");
        throw new HttpError(409, `you already have an agent in play: ${held}. An agent retires when its balance is withdrawn in full or its rental lapses at the end of a season, and then you can rent another.`, {
          agents: active.map((a) => ({ id: a.id, name: a.name })),
        });
      }
      const t = tx as unknown as Db;
      const wanted = {
        name,
        ownerId,
        ...(presetName ? { presetName } : {}),
        ...(brief ? { brief } : {}),
        ...(table ? { policyTable: table } : {}),
        ...(wantedBand !== undefined ? { band: wantedBand as BandName } : {}),
      };
      if (!viaDeposit) return { row: await createAgent(t, wanted), rental: null };
      // Inside the lock on purpose. Building the transaction is a round trip to
      // an RPC, but the lock is on this wallet alone, so the only thing it
      // delays is the same wallet renting twice at once - which is the thing it
      // is for.
      try {
        const prepared = await prepareRental(t, deposit!.chain, { ...wanted, fee: deposit!.fee, deposit: depositAmount });
        return { row: prepared.agent, rental: prepared };
      } catch (error) {
        if (error instanceof RentalError) throw new HttpError(error.status, error.message);
        throw error;
      }
    });
    await refreshTrueRatings(db);
    // Its character: a face, a name unless the owner gave one, an epithet and a
    // bio. A failure here leaves a working agent without one, which the
    // portrait endpoint and the backfill both cover.
    const character = await createCharacter(db, row.id, { deps: characterDeps, ...(nameVerdict ? { nameVerdict } : {}) }).catch((error: unknown) => {
      console.error(`character: could not create one for ${row.id}: ${String(error).slice(0, 160)}`);
      return null;
    });
    const view = await publicAgent(db, row.id);
    const [fresh] = await db.select().from(agents).where(eq(agents.id, row.id)).limit(1);
    return {
      agent: {
        ...inChips(view!),
        character: character ? ownerCharacter(character) : null,
        id: fresh!.id,
        brief: fresh!.brief,
        ownerId: fresh!.ownerId,
        createdAt: fresh!.createdAt,
        trueRating: fresh!.trueRating,
        trueRatingBasis: `against band ${fresh!.band}'s roster as it stands today`,
        ...bandStatus(view!),
      },
      elicitation: presetName ? null : { free: freeCall, reusedRatedTable: reused },
      /**
       * Which flow this rental took. Read this rather than inferring it from
       * which keys are present: a seed rental hands back an agent that can play
       * at once, and a deposit rental hands back one that cannot play at all
       * until the owner signs `rental.transaction` and it lands.
       */
      funding: rental ? ("deposit" as const) : ("seed" as const),
      rental: rental
        ? {
            rentalId: rental.rentalId,
            /** Base64. The owner's wallet signs exactly this and sends it back. */
            transaction: rental.transaction,
            fee: rental.fee,
            feeChips: toChips(rental.fee, deposit!.chipRate),
            deposit: rental.deposit,
            depositChips: toChips(rental.deposit, deposit!.chipRate),
            /**
             * False, always, in this answer. No fee has been paid and the vault
             * does not exist yet; the agent is a placeholder for an address
             * until the transaction lands.
             */
            playable: false,
          }
        : null,
    };
  }

  /**
   * What the agent panel needs to explain the cover rule: the bands this
   * balance can still play, what each would risk, and - when the agent can no
   * longer cover its own band - which cheaper band is still open to it.
   */
  /**
   * An agent view with its money in chips.
   *
   * The ledger holds base units, because it has to reconcile with a vault
   * (src/chips.ts). Everything a player reads is chips: the bands, the stakes,
   * the floor they set, the figure on the card. That conversion has to happen
   * somewhere, and the api boundary is the only place it can happen once - a
   * deposit-funded balance of 900 chips is 900,000,000 base units, so a view
   * that forgets is not slightly wrong, it is wrong by a factor of a million.
   */
  function inChips<T extends { balance: number; funding: Funding }>(row: T): T & { balanceBaseUnits: number } {
    return { ...row, balance: toChips(row.balance, rateOf(row)), balanceBaseUnits: row.balance };
  }

  function bandStatus(row: { band: BandName; balance: number; presetName: string | null; funding: Funding }) {
    const rate = rateOf(row);
    const open = affordableBands(row.balance, rate);
    return {
      band: row.band,
      worstMatch: bandByName(row.band).worstMatch,
      canPlay: canAffordBand(row.balance, row.band, rate),
      /** Bands this balance covers, cheapest upward. Empty means nothing is left but withdrawing. */
      affordable: open,
      /** The best band still open, when the current one is not. Null when none is. */
      fallback: canAffordBand(row.balance, row.band, rate) ? null : (open.at(-1) ?? null),
      bands: STAKE_BANDS.map((b) => ({
        name: b.name,
        stakes: { ante: b.ante, baseBet: b.baseBet, raisedBet: b.raisedBet },
        worstMatch: b.worstMatch,
        affordable: canAffordBand(row.balance, b.name, rate),
        survival: survivalFor(b.name, (row.presetName as PresetName | null) ?? null),
        medianHours: SURVIVAL[b.name].medianHours,
      })),
      survivalBasis: {
        hours: SURVIVAL_HOURS,
        paceMinutes: SURVIVAL_PACE_MINUTES,
        seedBalance: SURVIVAL_SEED_BALANCE,
      },
    };
  }

  /**
   * An agent's face, as SVG. `?size=small` is the simplified drawing for 24-32
   * px. Public: it is on the ladder and in the feed. Cached for a day - a face
   * is stored once and does not change, but one drawn for an agent that has no
   * character yet will be replaced by the stored one after the backfill.
   */
  async function getPortrait(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const [agent] = await db.select({ id: agents.id, policyTable: agents.policyTable }).from(agents).where(eq(agents.id, id)).limit(1);
    if (!agent) throw new HttpError(404, "no such agent");
    const svg = await portraitSvg(db, agent, ctx.query.get("size") === "small");
    if (!svg) throw new HttpError(404, "this agent has no portrait");
    return new Raw(svg, "image/svg+xml; charset=utf-8", {
      "cache-control": "public, max-age=86400",
      // An SVG opened directly is a document: it may run nothing and load nothing.
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
  }

  async function getAgent(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const row = await publicAgent(db, id);
    if (!row) throw new HttpError(404, "no such agent");
    const found = await characterOf(db, id);
    const character = found ? publicCharacter(found) : null;
    // A chosen name still waiting for its check is its owner's to see, and no one else's.
    const ownCharacter = found ? ownerCharacter(found) : null;
    // Measured from its play; "not enough hands yet" until there are.
    const traits = await traitsOf(db, id);
    const [owned] = await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, id)).limit(1);
    if (ctx.ownerId && owned?.ownerId === ctx.ownerId) {
      const own = await ownerAgent(db, id, ctx.ownerId);
      const [full] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      return {
        agent: {
          ...inChips(row),
          brief: own!.brief,
          policyTable: own!.policyTable,
          trueRating: own!.trueRating,
          trueRatingBasis: `against band ${own!.band}'s roster as it stands today`,
          ...bandStatus(row),
          character: ownCharacter,
          traits,
        },
        // Private to the owner: whether it is playing, and what it did while they were away.
        autoplay: await autoplayStatus(db, full!, { intervalMs: autoplayIntervalMs }),
        // Where its rental stands: active, renewed, expired and renewable, or lapsed.
        rental: rentalStatus(full!),
        // Why it cannot be topped up, if so: a vault exists only once the rental has landed.
        depositBlocked: await depositBlocked(db, full!),
        sinceYouLeft: await sinceYouLeft(db, full!),
        view: "owner",
      };
    }
    return { agent: { ...inChips(row), ...bandStatus(row), character, traits }, view: "public" };
  }

  async function postPlay(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!row) throw new HttpError(404, "no such agent");
    if (row.ownerId !== null && row.ownerId !== ctx.ownerId) throw new HttpError(403, "that agent belongs to someone else");
    if (row.retiredAt !== null) throw new HttpError(409, "that agent is retired");
    ctx.spendPlay();

    let pick;
    let played;
    try {
      // Pressing play may practise against a house agent: that match is an
      // exhibition, stakes nothing and counts for nothing, and trying an agent
      // out is what this button is for. Autoplay asks for players only.
      pick = await pickOpponent(db, id, { allowHouse: true });
      played = await runMatch(db, id, pick.opponentId);
    } catch (error) {
      // Cannot cover a stake, or the opponent pool is empty: not a server fault.
      if (error instanceof StakeError) throw new HttpError(409, error.message);
      if (error instanceof Error && /no preset agent available/.test(error.message)) {
        throw new HttpError(409, "no opponent could cover a stake right now");
      }
      throw error;
    }
    const { match, log, stake, settled, retired } = played;
    const [opponent] = await db
      .select({ name: agents.name, presetName: agents.presetName, mark: agents.mark })
      .from(agents)
      .where(eq(agents.id, pick.opponentId))
      .limit(1);
    const after = await publicAgent(db, id);
    return {
      matchId: match.id,
      opponent: { id: pick.opponentId, name: opponent?.name, presetName: opponent?.presetName ?? null, mark: opponent?.mark ?? null },
      matchmaking: { path: pick.path, candidates: pick.candidates, ratingGap: pick.ratingGap },
      stake,
      result: {
        winner: log.winner,
        net: settled.A,
        opponentNet: settled.B,
        rounds: log.rounds.length,
        /** What the play was worth before the stake capped it. */
        uncappedNet: log.nets.A,
      },
      balance: after ? toChips(after.balance, rateOf(after)) : 0,
      retired: retired.includes(id),
      /**
       * Whether this counts toward the ladder. False means the opponent was a
       * house agent: the money moved all the same, but it earns no ranking.
       */
      ranked: match.ranked,
    };
  }

  async function postBand(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const value = ctx.body["band"];
    if (!STAKE_BANDS.some((b) => b.name === value)) {
      throw new HttpError(400, `band must be one of ${STAKE_BANDS.map((b) => b.name).join(", ")}`);
    }
    try {
      return { band: await setBand(db, id, ownerId, value as BandName) };
    } catch (error) {
      if (error instanceof Error && /another owner/.test(error.message)) throw new HttpError(403, error.message);
      // Too poor for that band: the owner can pick a cheaper one.
      if (error instanceof StakeError) throw new HttpError(409, error.message);
      throw error;
    }
  }

  /**
   * Turn autoplay on or off, and set the balance floor.
   *
   * Turning it on clears whatever stopped it last: the owner has seen the
   * reason and decided to carry on. Autoplay is checked again on the next tick
   * anyway, so an agent that still cannot play stops again immediately, with a
   * current reason rather than a stale one.
   */
  async function postAutoplay(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!row) throw new HttpError(404, "no such agent");
    if (row.ownerId !== ownerId) throw new HttpError(403, "that agent belongs to someone else");
    if (row.retiredAt !== null) throw new HttpError(409, "that agent is retired");

    const enabled = ctx.body["enabled"];
    if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");

    // A floor is optional; null removes it. It is rejected rather than clamped:
    // a floor the server quietly changed would not be the owner's floor.
    let floor = row.autoplayFloor;
    if ("floor" in ctx.body) {
      const value = ctx.body["floor"];
      if (value === null) floor = null;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 0) floor = value;
      else throw new HttpError(400, "floor must be a whole number of chips, or null");
    }

    await setAutoplay(db, row, enabled, floor);

    // Say now whether it can actually play, so turning it on does not look
    // like it worked when the balance says otherwise.
    const [updated] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    // The same block the panel reads, so turning it on shows at once whether
    // it can actually play - not a success that the next tick contradicts.
    return { autoplay: await autoplayStatus(db, updated!, { intervalMs: autoplayIntervalMs }) };
  }

  /** The owner has read "since you left": the next summary starts from now. */
  /** Renews the rental into the next season, or out of expiry within the grace period. */
  async function postRenew(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const cutover = cutoverNotice();
    if (cutover) {
      const [row] = await db.select({ funding: agents.funding }).from(agents).where(eq(agents.id, id)).limit(1);
      // Refusing the renewal is the whole cutover: a rental already ends at a
      // season boundary, so one that cannot be renewed simply runs out.
      if (row?.funding === "seed") {
        throw new HttpError(
          409,
          `This agent is on the old settlement program, which closes at ${cutover.endsAt.toISOString().slice(0, 16).replace("T", " ")} UTC, so it can't be renewed. It keeps playing until then, and its balance can be withdrawn until ${cutover.withdrawableUntil.toISOString().slice(0, 16).replace("T", " ")} UTC. Rent again on the new program, where you fund the agent yourself.`,
          { cutover },
        );
      }
    }
    try {
      return { rental: await renewAgent(db, id, ownerId) };
    } catch (error) {
      if (error instanceof RenewError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** The season in play: what the rent screen counts down to. Public. */
  /**
   * A season's prize standing: the order prizes would pay in, as things stand.
   *
   * Deliberately its own endpoint rather than a tab on /ladder. The ladder
   * ranks net won; this ranks net per chip staked over ranked matches, with a
   * minimum match count. They are different questions and they give different
   * answers, and serving them from one route invites a client to relabel one
   * as the other.
   */
  async function getPrizes(ctx: Ctx) {
    const now = new Date();
    let season;
    try {
      season = ctx.query.get("season") ? seasonByKey(ctx.query.get("season")!) : seasonAt(now);
    } catch {
      throw new HttpError(400, "season must be a Monday, as YYYY-MM-DD");
    }
    const limit = Math.min(Number(ctx.query.get("limit") ?? 50) || 50, 200);
    const table = await prizeTable(db, season.key);
    return {
      season: {
        key: season.key,
        number: season.number,
        startsAt: season.start,
        endsAt: season.end,
        current: season.key === seasonAt(now).key,
      },
      /** False while the season is open: this table will still move. */
      frozen: table.frozen,
      /** Ranked matches needed before an agent can be placed. */
      minMatches: table.minMatches,
      basis: "ranked net per chip staked",
      placed: table.rows.filter((r) => r.prizeRank !== null).length,
      rows: table.rows.slice(0, limit),
    };
  }

  /**
   * A season's statement: what the season did, and what it would pay.
   *
   * The prize side is empty on purpose and says so - `funded` is false and
   * every amount is null rather than zero, because "nothing was paid" and "we
   * do not know yet" must not look alike. What it does carry is the order the
   * places would pay in.
   */
  /**
   * Operational health, for the wallets in `adminWallets`.
   *
   * A reader, not a measurer. The settlement lag, the reconciler, the solvency
   * line and the season statement each already know their piece; this puts
   * them in one response so one page can show them together. The only thing it
   * decides is who may see it.
   *
   * Signed out, or signed in as anyone else, it is a 404 rather than a 403:
   * there is no reason to confirm to a stranger that the page exists.
   */
  async function getAdmin(ctx: Ctx) {
    const wallet = ctx.requireOwner();
    if (!adminWallets.has(wallet)) throw new HttpError(404, "not found");
    if (!options.health) {
      throw new HttpError(503, "this server has no chain configured, so there is no health to report");
    }
    return options.health();
  }

  async function getStatement(ctx: Ctx) {
    const now = new Date();
    let season;
    try {
      season = ctx.query.get("season") ? seasonByKey(ctx.query.get("season")!) : seasonAt(now);
    } catch {
      throw new HttpError(400, "season must be a Monday, as YYYY-MM-DD");
    }
    return { statement: await seasonStatement(db, season.key) };
  }

  async function getSeason() {
    const season = seasonAt(new Date());
    return {
      season: { key: season.key, number: season.number, startsAt: season.start, endsAt: season.end },
      graceHours: GRACE_MS / 3_600_000,
      reminderHours: RENEWAL_REMINDER_MS / 3_600_000,
    };
  }

  async function postSeen(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const [row] = await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, id)).limit(1);
    if (!row) throw new HttpError(404, "no such agent");
    if (row.ownerId !== ownerId) throw new HttpError(403, "that agent belongs to someone else");
    await markSeen(db, id);
    return { ok: true };
  }

  /** An agent's money, movement by movement. Public: the ladder shows balances anyway. */
  async function getLedger(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const row = await publicAgent(db, id);
    if (!row) throw new HttpError(404, "no such agent");
    // Chips, like every other money figure a client sees. `statement` returns
    // the ledger's own rows, which are base units.
    const rate = rateOf(row);
    const movements = (await statement(db, id)).map((m) => ({ ...m, amount: toChips(m.amount, rate) }));
    return { balance: toChips(row.balance, rate), band: row.band, retired: row.retired, movements };
  }

  async function getMatch(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const [row] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
    if (!row) throw new HttpError(404, "no such match");
    const sides = await Promise.all(
      [row.agentA, row.agentB].map(async (agentId) => {
        const [a] = await db
          .select({ name: agents.name, presetName: agents.presetName, mark: agents.mark })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        return { name: a?.name ?? "unknown", presetName: a?.presetName ?? null, mark: a?.mark ?? null };
      }),
    );
    const names = sides.map((x) => x.name);
    const displayNames = { A: names[0]!, B: names[1]! };
    return {
      match: {
        id: row.id,
        agentA: { id: row.agentA, name: names[0], presetName: sides[0]!.presetName, mark: sides[0]!.mark },
        agentB: { id: row.agentB, name: names[1], presetName: sides[1]!.presetName, mark: sides[1]!.mark },
        seed: row.seed,
        rules: row.rulesConfig,
        winner: row.winner,
        netA: row.netA,
        netB: row.netB,
        stake: row.stake,
        createdAt: row.createdAt,
        /** House agents playing each other: nothing was staked or settled. */
        exhibition: row.exhibition,
        /** Player against player: counts toward the ladder. Staked but unranked means a house opponent. */
        ranked: row.ranked,
      },
      /** Everything a shared card needs, without parsing the transcript. */
      summary: {
        names: displayNames,
        /** Which preset each side plays; null for a custom brief. */
        presets: { A: sides[0]!.presetName, B: sides[1]!.presetName },
        /** Each side's emoji, its identity. */
        marks: { A: sides[0]!.mark, B: sides[1]!.mark },
        netA: row.netA,
        netB: row.netB,
        winner: row.winner,
        winnerName: row.winner === null ? null : displayNames[row.winner],
        rounds: row.log.rounds.length,
        stake: row.stake,
        headline: headlineFor(row.log, displayNames),
      },
      transcript: renderTranscript(row.log, displayNames),
      /** What the chain has recorded. Null for a level match, which moves nothing. */
      settlement: await settlementStatus(db, row.id),
      log: row.log,
    };
  }

  // The bluff reads up to 100 match logs; every visitor polls the feed, so keep it briefly.
  let bluffCache: { at: number; value: Awaited<ReturnType<typeof latestBluff>> } | null = null;
  const BLUFF_TTL_MS = 15_000;

  /** Public: recent matches across the platform, newest first, and the latest bluff that worked. */
  async function getFeed(ctx: Ctx) {
    const limit = Number(ctx.query.get("limit") ?? 20) || 20;
    const beforeParam = ctx.query.get("before");
    const before = beforeParam === null ? undefined : Number(beforeParam);
    if (before !== undefined && !Number.isSafeInteger(before)) throw new HttpError(400, "before must be a match seq");
    // Staked-only by default, which is the conservative answer for anything
    // that has not thought about it. It made more sense when an exhibition was
    // only ever house filler; now that a house match is an exhibition, most of
    // what is played is one, and the site asks for everything and marks each
    // row. `?staked=false` asks for everything.
    const stakedOnly = (ctx.query.get("staked") ?? "true") !== "false";
    const t = (options.now ?? Date.now)();
    if (!bluffCache || t - bluffCache.at > BLUFF_TTL_MS) bluffCache = { at: t, value: await latestBluff(db) };
    return {
      matches: await recentMatches(db, { limit, stakedOnly, ...(before !== undefined ? { before } : {}) }),
      bluff: bluffCache.value,
    };
  }

  /** Public: one agent's recent matches, newest first. */
  async function getAgentMatches(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    if (!(await publicAgent(db, id))) throw new HttpError(404, "no such agent");
    const limit = Number(ctx.query.get("limit") ?? 20) || 20;
    return { record: await agentRecord(db, id), matches: await recentMatches(db, { limit, agentId: id }) };
  }

  /** Public: platform-wide activity in staked matches. */
  /**
   * Public, and deliberately so: how far behind the chain is, alongside the
   * activity figures. It is here rather than only in the logs because the
   * outage this measures was invisible for 28 hours in logs somebody had to
   * think to read. Anything that can poll a URL can watch it.
   */
  async function getStats() {
    const lagMs = await settlementLag(db);
    return {
      activity: await matchActivity(db),
      settlement: {
        /** How long the oldest unsent movement has waited. Null when none is waiting. */
        lagMs,
        /** Past this, something is wrong rather than merely busy. */
        alarmAfterMs: SETTLEMENT_LAG_ALARM_MS,
        stalled: lagMs !== null && lagMs >= SETTLEMENT_LAG_ALARM_MS,
      },
    };
  }

  /** Owner only: builds a top-up for the owner's wallet to sign. Amount in chips. */
  async function postDeposit(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const agentId = requireUuid(ctx.params[0]);
    const deposit = options.deposit;
    if (!deposit) throw new HttpError(503, "deposits are unavailable on this server");
    const asked = ctx.body["amount"];
    if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) {
      throw new HttpError(400, "amount is required, in chips, and must be above zero");
    }
    try {
      // Refusals that attempt nothing on chain - no vault, not theirs, retired -
      // come before the limit, so pressing a button that cannot work does not
      // cost an hour's allowance. The limit is for building transactions.
      await checkDeposit(db, { agentId, ownerId });
      spendBoth(rentLimiter, rentByAddress, ownerId, ctx.clientKey, "deposits");
      const out = await prepareDeposit(db, deposit.chain, {
        agentId,
        ownerId,
        amount: baseUnits(Math.floor(asked), deposit.chipRate),
      });
      return { deposit: { ...out, chips: toChips(out.amount, deposit.chipRate) } };
    } catch (error) {
      if (error instanceof DepositError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** Owner only: sends the wallet-signed top-up. */
  async function postDepositSubmit(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const depositId = requireUuid(ctx.params[0]);
    const deposit = options.deposit;
    if (!deposit) throw new HttpError(503, "deposits are unavailable on this server");
    const signed = String(ctx.body["transaction"] ?? "");
    if (!signed) throw new HttpError(400, "transaction is required");
    try {
      return { deposit: await submitDeposit(db, deposit.chain, { depositId, ownerId, signedTx: signed }) };
    } catch (error) {
      if (error instanceof DepositError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** Owner only: sends the wallet-signed rental transaction. */
  async function postRentalSubmit(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const rentalId = requireUuid(ctx.params[0]);
    const deposit = options.deposit;
    if (!deposit) throw new HttpError(503, "deposit-funded rentals are unavailable on this server");
    const signed = String(ctx.body["transaction"] ?? "");
    if (!signed) throw new HttpError(400, "transaction is required");
    try {
      const out = await submitRental(db, deposit.chain, { rentalId, ownerId, signedTx: signed });
      return { rental: { ...out, playable: out.status === "confirmed" } };
    } catch (error) {
      if (error instanceof RentalError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** Owner only: where a rental's transaction has got to. */
  /**
   * The owner declined the wallet prompt, so this rental can stop waiting.
   *
   * Saves the fifteen minutes the sweep would otherwise take to work out that
   * nobody is coming - during which a 0-balance agent sits on the owner's page
   * holding their one-agent slot.
   *
   * The claim is not trusted with anything. It chooses whether to wait, and
   * the chain decides what actually happened: a rental whose vault exists is
   * confirmed here, not expired, however firmly the page believes otherwise.
   */
  async function postRentalReject(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    if (!options.deposit) throw new HttpError(503, "the deposit flow is not configured on this server");
    const outcome = await rejectRental(db, options.deposit.chain, id, ownerId);
    return {
      rental: {
        rentalId: id,
        outcome,
        /** What the owner should be told, since only one of these is the ordinary case. */
        message:
          outcome === "expired"
            ? "nothing was charged, and the agent is gone"
            : outcome === "confirmed"
              ? "it had already landed, so the agent is yours after all"
              : outcome === "in-flight"
                ? "it was already sent, so we have to wait and see whether it lands"
                : "it was already settled one way or the other",
      },
    };
  }

  async function getRental(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const [r] = await db.select().from(rentals).where(eq(rentals.id, id)).limit(1);
    if (!r || r.ownerId !== ownerId) throw new HttpError(404, "no such rental");
    return {
      rental: {
        rentalId: r.id,
        agentId: r.agentId,
        status: r.status,
        signature: r.signature,
        error: r.error,
        fee: r.fee,
        deposit: r.deposit,
        /** An agent is only a rental once its transaction has landed. */
        playable: r.status === "confirmed",
      },
    };
  }

  /** Devnet only: whether this wallet can be topped up, and when it can next ask. */
  async function getFaucet(ctx: Ctx) {
    const wallet = ctx.requireOwner();
    if (!options.faucet) throw new HttpError(503, "there is no faucet on this network");
    return { faucet: await faucetStatus(db, wallet, chipRate) };
  }

  /** Devnet only: hands this wallet one grant of stake tokens. */
  async function postFaucet(ctx: Ctx) {
    const wallet = ctx.requireOwner();
    const faucet = options.faucet;
    if (!faucet) throw new HttpError(503, "there is no faucet on this network");
    spendBoth(faucetLimiter, faucetByAddress, wallet, ctx.clientKey, "faucet requests");
    try {
      return { grant: await grantFaucet(db, faucet, wallet, chipRate) };
    } catch (error) {
      if (error instanceof FaucetError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /**
   * The program that holds this agent's vault, and the rate its money is in.
   *
   * A withdrawal has to reach the programme that actually holds the tokens: the
   * two have different mints, so asking the wrong one about a vault is asking
   * about an account it has never heard of.
   */
  async function vaultOf(agentId: string): Promise<{ chain: WithdrawalChain; rate: number }> {
    const [row] = await db.select({ funding: agents.funding }).from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!row) throw new HttpError(404, "no such agent");
    if (row.funding === "deposit") {
      if (!options.deposit) throw new HttpError(503, "this server isn't connected to the deposit program");
      return { chain: options.deposit.chain, rate: options.deposit.chipRate };
    }
    return { chain: needChain(), rate: rateOf(row) };
  }

  /** Runs a withdrawal step, turning its refusals into HTTP answers. */
  async function withdrawalStep<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WithdrawalError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }
  const needChain = () => {
    if (!options.chain) throw new HttpError(503, "withdrawals are unavailable: this server isn't connected to the chain");
    return options.chain;
  };
  /** The owner's own agent, or a refusal. */
  async function ownAgent(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const [row] = await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, id)).limit(1);
    if (!row) throw new HttpError(404, "no such agent");
    if (row.ownerId !== ownerId) throw new HttpError(403, "that agent belongs to someone else");
    return { id, ownerId };
  }

  /** Owner only: what can be withdrawn now, and what is locked while matches settle. */
  async function getWithdrawable(ctx: Ctx) {
    const { id } = await ownAgent(ctx);
    const { rate } = await vaultOf(id);
    const state = await withdrawalStep(() => withdrawable(db, id));
    // Chips, like every other money figure a client sees. The module works in
    // base units because those are what has to match a vault.
    return {
      withdrawable: {
        ...state,
        balance: toChips(state.balance, rate),
        withdrawable: toChips(state.withdrawable, rate),
        locked: toChips(state.locked, rate),
        maxPartial: toChips(state.maxPartial, rate),
        minStake: toChips(state.minStake, rate),
        // The owner's own exit, in chips like everything else here. Sent even
        // when the instant path is available, because an owner with one under
        // way needs to see it wherever they look - and never sent as an
        // alternative to that path, only as the state of a thing they started.
        exit: state.exit
          ? {
              ...state.exit,
              amount: toChips(state.exit.amount, rate),
              claimedAmount: state.exit.claimedAmount === null ? null : toChips(state.exit.claimedAmount, rate),
            }
          : null,
      },
    };
  }

  /** Owner only: builds a withdrawal for the owner's wallet to sign. {amount: n} or {amount: "all"}. */
  async function postWithdrawal(ctx: Ctx) {
    const { id, ownerId } = await ownAgent(ctx);
    const raw = ctx.body["amount"];
    const asked = raw === "all" ? "all" : typeof raw === "number" ? raw : NaN;
    if (asked !== "all" && !Number.isFinite(asked)) throw new HttpError(400, 'amount must be a number or "all"');
    const { chain, rate } = await vaultOf(id);
    // The owner types chips; the vault and the program speak base units.
    const amount = asked === "all" ? "all" : baseUnits(Math.floor(asked), rate);
    const out = await withdrawalStep(() => prepareWithdrawal(db, chain, { agentId: id, ownerId, amount }));
    return {
      withdrawal: { ...out, amount: toChips(out.amount, rate), remaining: toChips(out.remaining, rate) },
    };
  }

  /** Owner only: the signed transaction back; recorded, then sent. */
  async function postWithdrawalSubmit(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const withdrawalId = requireUuid(ctx.params[0]);
    const signed = ctx.body["transaction"];
    if (typeof signed !== "string" || !signed) throw new HttpError(400, "transaction is required (base64)");
    // The withdrawal knows its agent, and the agent decides which program.
    const [w] = await db.select({ agentId: withdrawals.agentId }).from(withdrawals).where(eq(withdrawals.id, withdrawalId)).limit(1);
    if (!w) throw new HttpError(404, "no such withdrawal");
    const { chain } = await vaultOf(w.agentId);
    return { withdrawal: await withdrawalStep(() => submitWithdrawal(db, chain, { withdrawalId, ownerId, signedTx: signed })) };
  }

  /** Owner only: where a withdrawal has got to. */
  async function getWithdrawal(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, id)).limit(1);
    if (!w || w.ownerId !== ownerId) throw new HttpError(404, "no such withdrawal");
    return {
      withdrawal: {
        id: w.id,
        agentId: w.agentId,
        amount: w.amount,
        remaining: w.remaining,
        retire: w.retire,
        status: w.status,
        signature: w.signature,
        error: w.status === "expired" ? w.error : null,
      },
    };
  }

  async function getLadder(ctx: Ctx) {
    const sort = (ctx.query.get("sort") ?? "winnings") as LadderTab;
    if (sort !== "winnings" && sort !== "per-match") {
      throw new HttpError(400, "sort must be winnings or per-match");
    }
    const limit = Math.min(Number(ctx.query.get("limit") ?? 50) || 50, 200);
    // All time unless asked: the web release before seasons calls without a period.
    const period = ctx.query.get("period") ?? "all";
    const now = new Date();
    if (period === "all") return { sort, period, rows: await leaderboard(db, limit, sort) };
    if (period === "day") {
      const since = dayStart(now);
      return { sort, period, since, rows: await leaderboard(db, limit, sort, { period: "day", since }) };
    }
    if (period === "season") {
      let season;
      try {
        season = ctx.query.get("season") ? seasonByKey(ctx.query.get("season")!) : seasonAt(now);
      } catch {
        throw new HttpError(400, "season must be a Monday, as YYYY-MM-DD");
      }
      return {
        sort,
        period,
        season: { key: season.key, number: season.number, startsAt: season.start, endsAt: season.end, current: season.key === seasonAt(now).key },
        rows: await leaderboard(db, limit, sort, { period: "season", season: season.key }),
      };
    }
    throw new HttpError(400, "period must be all, season or day");
  }

  /** Public and free: the shipped tables, so the UI can rate them without a model call. */
  async function getPresets() {
    return {
      presets: PRESET_NAMES.map((name) => ({
        name,
        description: PRESET_DESCRIPTIONS[name],
        policyTable: snapshotPreset(name),
      })),
      free: true,
    };
  }

  /** Who is out there to play, in a band. Public: the ladder shows this anyway. */
  async function getRoster(ctx: Ctx) {
    const band = ctx.query.get("band");
    if (band !== null && !STAKE_BANDS.some((b) => b.name === band)) {
      throw new HttpError(400, `band must be one of ${STAKE_BANDS.map((b) => b.name).join(", ")}`);
    }
    const rows = await roster(db, band === null ? {} : { band: band as BandName });
    // Survival rides along so the rent screen can quote it without a second
    // request, and without the client keeping its own copy of the numbers.
    return {
      band,
      bands: STAKE_BANDS.map((b) => ({ ...b, survival: SURVIVAL[b.name] })),
      survivalBasis: { hours: SURVIVAL_HOURS, paceMinutes: SURVIVAL_PACE_MINUTES, seedBalance: SURVIVAL_SEED_BALANCE },
      counts: await bandCounts(db),
      agents: rows,
    };
  }

  async function postPreview(ctx: Ctx) {
    const brief = typeof ctx.body["brief"] === "string" ? ctx.body["brief"].trim() : "";
    const supplied = ctx.body["policyTable"];
    if (!brief && !supplied) throw new HttpError(400, "brief or policyTable is required");

    let table: Policy;
    let freeCall = false;
    if (supplied) {
      table = validatePolicy(supplied);
    } else {
      // Only the brief path reaches a model, so only it needs a wallet.
      const ownerId = ctx.requireOwner();
      freeCall = await ctx.spend("preview");
      const result = await elicit({ brief });
      if (!result.table) throw new HttpError(503, "could not elicit a table for that brief", { reason: result.reason });
      table = validatePolicy(result.table);
      remember(ownerId, brief, table);
    }
    // Priced in the band the player is looking at, so the numbers on the rent
    // screen are the ones they would actually play for.
    const wanted = ctx.body["band"];
    if (wanted !== undefined && !STAKE_BANDS.some((b) => b.name === wanted)) {
      throw new HttpError(400, `band must be one of ${STAKE_BANDS.map((b) => b.name).join(", ")}`);
    }
    const band = (wanted as BandName | undefined) ?? "B";
    const preview = previewPolicy(table, await rosterProfile(db, band));
    return { preview, policyTable: table, elicitation: supplied ? null : { free: freeCall } };
  }

  function requireUuid(value: string | undefined): string {
    if (!value || !UUID.test(value)) throw new HttpError(400, "malformed id");
    return value;
  }

  const corsOrigin = options.corsOrigin ?? process.env["CORS_ORIGIN"] ?? "http://localhost:3000";
  /**
   * Wallets allowed to read /admin. Empty by default and empty unless someone
   * says otherwise, so a deployment that forgets to set it has no admin page
   * rather than an open one.
   */
  const adminWallets = new Set(
    (options.adminWallets ?? (process.env["ADMIN_WALLETS"] ?? "").split(","))
      .map((w) => w.trim())
      .filter((w) => w.length > 0),
  );
  const corsHeaders = {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "600",
    vary: "origin",
  };

  const live = new LiveStream(db, {
    onError: (error) => console.error(`live: ${String(error).slice(0, 160)}`),
    ...options.live,
  });

  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    // The live stream holds its response open, so it is answered here rather
    // than as a route that returns one payload. Public: it carries only what the feed does.
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/live") {
      void live.open(req, res, clientAddress(req), resumeFrom(req, url.searchParams), corsHeaders);
      return;
    }
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : "unknown error" }, corsHeaders);
    });
  });
  // Open streams never finish on their own, so closing the server ends them first.
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    live.close();
    return closeServer(callback);
  }) as typeof server.close;
  return server;

  function reply(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    send(res, status, payload, { ...corsHeaders, ...headers });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) return reply(res, 404, { error: "no such route" });

    // A session token, if any. A stale or unknown token is treated as signed
    // out rather than rejected, so public reads keep working; anything that
    // needs an owner refuses with 401.
    const auth = req.headers["authorization"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const ownerId = await ownerForToken(db, token);

    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, 400, { error: error instanceof Error ? error.message : "bad body" });
    }

    // Charged against the wallet, or the connection when there is none.
    const clientKey = clientAddress(req);
    const limitKey = ownerId ?? clientKey;
    let spent = false;
    const ctx: Ctx = {
      params: url.pathname.match(route[1])!.slice(1),
      query: url.searchParams,
      body,
      ownerId,
      token,
      clientKey,
      requireOwner: () => {
        if (!ownerId) throw new HttpError(401, "sign in with your wallet first");
        return ownerId;
      },
      spend: async (kind) => {
        // The owner's first model call is on the house.
        const free = ownerId ? await isFirstElicitationFree(db, ownerId) : false;
        if (!free) {
          const result = limiter.take(limitKey);
          spent = true;
          if (!result.ok) {
            throw new HttpError(429, "rate limit reached for model-backed requests", {
              retryAfterSeconds: result.retryAfterSeconds,
            });
          }
        }
        if (ownerId) await recordElicitation(db, { ownerId, kind, free });
        return free;
      },
      spendPlay: () => {
        const result = playLimiter.take(limitKey);
        if (!result.ok) {
          throw new HttpError(429, "rate limit reached for playing matches", {
            retryAfterSeconds: result.retryAfterSeconds,
          });
        }
      },
      refund: () => limiter.refund(limitKey),
    };

    try {
      const payload = await route[2](ctx);
      if (payload instanceof Raw) {
        res.writeHead(200, { ...corsHeaders, "content-type": payload.contentType, ...payload.headers });
        res.end(payload.body);
        return;
      }
      reply(res, req.method === "POST" ? 201 : 200, payload as Record<string, unknown>);
    } catch (error) {
      if (error instanceof HttpError) {
        // A request that failed before the model answered should not cost an allowance slot.
        if (spent && error.status >= 500) ctx.refund();
        const headers = error.status === 429 ? { "retry-after": String(error.extra["retryAfterSeconds"] ?? 60) } : {};
        return reply(res, error.status, { error: error.message, ...error.extra }, headers);
      }
      throw error;
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== "POST") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("body must be a JSON object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * The caller's address, for per-IP rate limits. Behind a hosting proxy every
 * request arrives from the proxy, so with TRUST_PROXY set the address is the
 * last X-Forwarded-For entry: the one the proxy appended, which the client
 * cannot forge. Without it the header is ignored, since anyone can send it.
 */
export function clientAddress(req: IncomingMessage): string {
  if (process.env["TRUST_PROXY"]) {
    const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1]!;
  }
  return req.socket.remoteAddress ?? "anonymous";
}

/** Starts the app on a port and reports where it landed. */
export async function listen(
  options: AppOptions & { port?: number; host?: string | undefined },
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
