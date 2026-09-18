import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { elicitPolicy } from "../agents/llm.js";
import { validatePolicy, type Policy } from "../agents/policy.js";
import { headlineFor, renderTranscript } from "../transcript.js";
import { PRESET_DESCRIPTIONS, PRESET_NAMES, type PresetName } from "../presets.js";
import type { Db } from "../db/client.js";
import { agents, matches } from "../db/schema.js";
import { isFirstElicitationFree, recordElicitation, StakeError, statement } from "../db/ledger.js";
import {
  clampCeiling,
  createAgent,
  setCeiling,
  snapshotPreset,
  leaderboard,
  ownerAgent,
  pickOpponent,
  publicAgent,
  roster,
  runMatch,
  type LadderTab,
} from "../db/runner.js";
import { previewPolicy, refreshTrueRatings, rosterProfile } from "../db/rating.js";
import { CEILING_BANDS, type CeilingBand } from "../db/schema.js";
import { RateLimiter, type RateLimitRule } from "./rate-limit.js";
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
   * Browser origins allowed to call this API. The web app runs on its own
   * origin, so without this every request from it fails before it is sent.
   * Defaults to CORS_ORIGIN or localhost:3000.
   */
  corsOrigin?: string;
  now?: () => number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024;

const defaultElicit: Elicit = async ({ brief }) => {
  const { log } = await elicitPolicy({ brief });
  return log.policy ? { table: log.policy } : { table: null, reason: log.fallback?.reason ?? "no table returned" };
};

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
  const elicit = options.elicit ?? defaultElicit;
  const limiter = new RateLimiter(options.rateLimit ?? { limit: 5, windowMs: 60_000 }, options.now);
  // Playing costs no money but writes a match row and rewrites two ratings;
  // unbounded, it is a cheap way to bloat the transcript table.
  const playLimiter = new RateLimiter(options.playRateLimit ?? { limit: 30, windowMs: 60_000 }, options.now);
  const nonceLimiter = new RateLimiter(options.nonceRateLimit ?? { limit: 20, windowMs: 60_000 }, options.now);
  const authDomain = options.authDomain ?? process.env["AUTH_DOMAIN"] ?? "localhost:3000";

  const routes: [string, RegExp, (ctx: Ctx) => Promise<unknown>][] = [
    ["POST", /^\/auth\/nonce$/, postNonce],
    ["POST", /^\/auth\/verify$/, postVerify],
    ["POST", /^\/auth\/logout$/, postLogout],
    ["GET", /^\/auth\/me$/, getMe],
    ["POST", /^\/agents$/, postAgent],
    ["GET", /^\/agents\/([^/]+)$/, getAgent],
    ["POST", /^\/agents\/([^/]+)\/play$/, postPlay],
    ["POST", /^\/agents\/([^/]+)\/ceiling$/, postCeiling],
    ["GET", /^\/agents\/([^/]+)\/ledger$/, getLedger],
    ["GET", /^\/matches\/([^/]+)$/, getMatch],
    ["GET", /^\/ladder$/, getLadder],
    ["GET", /^\/presets$/, getPresets],
    ["GET", /^\/roster$/, getRoster],
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
    return { ownerId: ctx.requireOwner() };
  }

  async function postAgent(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const name = String(ctx.body["name"] ?? "").trim();
    if (!name) throw new HttpError(400, "name is required");
    const presetName = ctx.body["presetName"] as PresetName | undefined;
    const brief = typeof ctx.body["brief"] === "string" ? ctx.body["brief"].trim() : "";
    if (!presetName && !brief) throw new HttpError(400, "presetName or brief is required");
    if (presetName && !PRESET_NAMES.includes(presetName)) {
      throw new HttpError(400, `unknown preset ${presetName}`, { known: PRESET_NAMES });
    }

    let table: Policy | undefined;
    let freeCall = false;
    if (!presetName) {
      freeCall = await ctx.spend("rent");
      const result = await elicit({ brief });
      if (!result.table) {
        // The model could not be reached or answered unusably: no agent, no charge.
        throw new HttpError(503, "could not elicit a table for that brief", { reason: result.reason });
      }
      table = validatePolicy(result.table);
    }

    const ceiling = ctx.body["maxStake"];
    const row = await createAgent(db, {
      name,
      ownerId,
      ...(presetName ? { presetName } : {}),
      ...(brief ? { brief } : {}),
      ...(table ? { policyTable: table } : {}),
      ...(typeof ceiling === "number" ? { maxStake: clampCeiling(ceiling) } : {}),
    });
    await refreshTrueRatings(db);
    const view = await publicAgent(db, row.id);
    const [fresh] = await db.select().from(agents).where(eq(agents.id, row.id)).limit(1);
    return {
      agent: {
        ...view,
        id: fresh!.id,
        brief: fresh!.brief,
        ownerId: fresh!.ownerId,
        createdAt: fresh!.createdAt,
        trueRating: fresh!.trueRating,
        trueRatingBasis: "against the roster as it stands today",
      },
      elicitation: presetName ? null : { free: freeCall },
    };
  }

  async function getAgent(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const row = await publicAgent(db, id);
    if (!row) throw new HttpError(404, "no such agent");
    const [owned] = await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, id)).limit(1);
    if (ctx.ownerId && owned?.ownerId === ctx.ownerId) {
      const own = await ownerAgent(db, id, ctx.ownerId);
      return {
        agent: {
          ...row,
          brief: own!.brief,
          policyTable: own!.policyTable,
          trueRating: own!.trueRating,
          trueRatingBasis: "against the roster as it stands today",
        },
        view: "owner",
      };
    }
    return { agent: row, view: "public" };
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
      pick = await pickOpponent(db, id);
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
    const [opponent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, pick.opponentId)).limit(1);
    const after = await publicAgent(db, id);
    return {
      matchId: match.id,
      opponent: { id: pick.opponentId, name: opponent?.name },
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
      balance: after?.balance ?? 0,
      retired: retired.includes(id),
    };
  }

  async function postCeiling(ctx: Ctx) {
    const ownerId = ctx.requireOwner();
    const id = requireUuid(ctx.params[0]);
    const value = ctx.body["maxStake"];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "maxStake must be a number");
    try {
      return { maxStake: await setCeiling(db, id, ownerId, value) };
    } catch (error) {
      if (error instanceof Error && /another owner/.test(error.message)) throw new HttpError(403, error.message);
      throw error;
    }
  }

  /** An agent's money, movement by movement. Public: the ladder shows balances anyway. */
  async function getLedger(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const row = await publicAgent(db, id);
    if (!row) throw new HttpError(404, "no such agent");
    return { balance: row.balance, maxStake: row.maxStake, retired: row.retired, movements: await statement(db, id) };
  }

  async function getMatch(ctx: Ctx) {
    const id = requireUuid(ctx.params[0]);
    const [row] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
    if (!row) throw new HttpError(404, "no such match");
    const names = await Promise.all(
      [row.agentA, row.agentB].map(async (agentId) => {
        const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
        return a?.name ?? "unknown";
      }),
    );
    const displayNames = { A: names[0]!, B: names[1]! };
    return {
      match: {
        id: row.id,
        agentA: { id: row.agentA, name: names[0] },
        agentB: { id: row.agentB, name: names[1] },
        seed: row.seed,
        rules: row.rulesConfig,
        winner: row.winner,
        netA: row.netA,
        netB: row.netB,
        stake: row.stake,
        createdAt: row.createdAt,
      },
      /** Everything a shared card needs, without parsing the transcript. */
      summary: {
        names: displayNames,
        netA: row.netA,
        netB: row.netB,
        winner: row.winner,
        winnerName: row.winner === null ? null : displayNames[row.winner],
        rounds: row.log.rounds.length,
        stake: row.stake,
        headline: headlineFor(row.log, displayNames),
      },
      transcript: renderTranscript(row.log, displayNames),
      log: row.log,
    };
  }

  async function getLadder(ctx: Ctx) {
    const sort = (ctx.query.get("sort") ?? "winnings") as LadderTab;
    if (sort !== "winnings" && sort !== "per-match") {
      throw new HttpError(400, "sort must be winnings or per-match");
    }
    const limit = Math.min(Number(ctx.query.get("limit") ?? 50) || 50, 200);
    return { sort, rows: await leaderboard(db, limit, sort) };
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
    if (band !== null && !CEILING_BANDS.some((b) => b.name === band)) {
      throw new HttpError(400, `band must be one of ${CEILING_BANDS.map((b) => b.name).join(", ")}`);
    }
    const rows = await roster(db, band === null ? {} : { band: band as CeilingBand });
    return { band, bands: CEILING_BANDS, agents: rows };
  }

  async function postPreview(ctx: Ctx) {
    ctx.requireOwner();
    const brief = typeof ctx.body["brief"] === "string" ? ctx.body["brief"].trim() : "";
    const supplied = ctx.body["policyTable"];
    if (!brief && !supplied) throw new HttpError(400, "brief or policyTable is required");

    let table: Policy;
    let freeCall = false;
    if (supplied) {
      table = validatePolicy(supplied);
    } else {
      freeCall = await ctx.spend("preview");
      const result = await elicit({ brief });
      if (!result.table) throw new HttpError(503, "could not elicit a table for that brief", { reason: result.reason });
      table = validatePolicy(result.table);
    }
    const preview = previewPolicy(table, await rosterProfile(db));
    return { preview, policyTable: table, elicitation: supplied ? null : { free: freeCall } };
  }

  function requireUuid(value: string | undefined): string {
    if (!value || !UUID.test(value)) throw new HttpError(400, "malformed id");
    return value;
  }

  const corsOrigin = options.corsOrigin ?? process.env["CORS_ORIGIN"] ?? "http://localhost:3000";
  const corsHeaders = {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "600",
    vary: "origin",
  };

  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : "unknown error" }, corsHeaders);
    });
  });

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
    const clientKey = req.socket.remoteAddress ?? "anonymous";
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

/** Starts the app on a port and reports where it landed. */
export async function listen(options: AppOptions & { port?: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
