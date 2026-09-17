import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { elicitPolicy } from "../agents/llm.js";
import { validatePolicy, type Policy } from "../agents/policy.js";
import { renderTranscript } from "../transcript.js";
import { PRESET_NAMES, type PresetName } from "../presets.js";
import type { Db } from "../db/client.js";
import { agents, matches } from "../db/schema.js";
import {
  createAgent,
  leaderboard,
  ownerAgent,
  pickOpponent,
  publicAgent,
  runMatch,
  type LadderTab,
} from "../db/runner.js";
import { previewPolicy, refreshTrueRatings, rosterProfile } from "../db/rating.js";
import { RateLimiter, type RateLimitRule } from "./rate-limit.js";

/**
 * Thin HTTP layer over the runner. Auth is a stub: an owner id from a header.
 * Wallet auth replaces it later, so nothing here should be trusted as identity.
 */
export type Elicit = (input: { brief: string }) => Promise<{ table: Policy | null; reason?: string }>;

export type AppOptions = {
  db: Db;
  /** Defaults to one model call per request. Injected in tests so they never spend money. */
  elicit?: Elicit;
  /** Applies to the endpoints that can reach a model. */
  rateLimit?: RateLimitRule;
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

  const routes: [string, RegExp, (ctx: Ctx) => Promise<unknown>][] = [
    ["POST", /^\/agents$/, postAgent],
    ["GET", /^\/agents\/([^/]+)$/, getAgent],
    ["POST", /^\/agents\/([^/]+)\/play$/, postPlay],
    ["GET", /^\/matches\/([^/]+)$/, getMatch],
    ["GET", /^\/ladder$/, getLadder],
    ["POST", /^\/preview$/, postPreview],
  ];

  type Ctx = {
    params: string[];
    query: URLSearchParams;
    body: Record<string, unknown>;
    ownerId: string | null;
    /** Throws 401 unless the caller presented an owner id. */
    requireOwner: () => string;
    /** Throws 429 when the caller has spent its allowance on model-touching endpoints. */
    spend: () => void;
    refund: () => void;
  };

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
    if (!presetName) {
      ctx.spend();
      const result = await elicit({ brief });
      if (!result.table) {
        // The model could not be reached or answered unusably: no agent, no charge.
        throw new HttpError(503, "could not elicit a table for that brief", { reason: result.reason });
      }
      table = validatePolicy(result.table);
    }

    const row = await createAgent(db, {
      name,
      ownerId,
      ...(presetName ? { presetName } : {}),
      ...(brief ? { brief } : {}),
      ...(table ? { policyTable: table } : {}),
    });
    await refreshTrueRatings(db);
    const [fresh] = await db.select().from(agents).where(eq(agents.id, row.id)).limit(1);
    return {
      agent: {
        id: fresh!.id,
        name: fresh!.name,
        presetName: fresh!.presetName,
        brief: fresh!.brief,
        ownerId: fresh!.ownerId,
        createdAt: fresh!.createdAt,
        trueRating: fresh!.trueRating,
        trueRatingBasis: "against the roster as it stands today",
      },
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

    const pick = await pickOpponent(db, id);
    const { match, log } = await runMatch(db, id, pick.opponentId);
    const [opponent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, pick.opponentId)).limit(1);
    return {
      matchId: match.id,
      opponent: { id: pick.opponentId, name: opponent?.name },
      matchmaking: { path: pick.path, candidates: pick.candidates, ratingGap: pick.ratingGap },
      result: { winner: log.winner, net: log.nets.A, opponentNet: log.nets.B, rounds: log.rounds.length },
    };
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
        createdAt: row.createdAt,
      },
      transcript: renderTranscript(row.log, { A: names[0]!, B: names[1]! }),
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

  async function postPreview(ctx: Ctx) {
    ctx.requireOwner();
    const brief = typeof ctx.body["brief"] === "string" ? ctx.body["brief"].trim() : "";
    const supplied = ctx.body["policyTable"];
    if (!brief && !supplied) throw new HttpError(400, "brief or policyTable is required");

    let table: Policy;
    if (supplied) {
      table = validatePolicy(supplied);
    } else {
      ctx.spend();
      const result = await elicit({ brief });
      if (!result.table) throw new HttpError(503, "could not elicit a table for that brief", { reason: result.reason });
      table = validatePolicy(result.table);
    }
    const preview = previewPolicy(table, await rosterProfile(db));
    return { preview, policyTable: table };
  }

  function requireUuid(value: string | undefined): string {
    if (!value || !UUID.test(value)) throw new HttpError(400, "malformed id");
    return value;
  }

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : "unknown error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) return send(res, 404, { error: "no such route" });

    const ownerHeader = req.headers["x-owner-id"];
    const ownerId = typeof ownerHeader === "string" && UUID.test(ownerHeader) ? ownerHeader : null;
    if (typeof ownerHeader === "string" && ownerId === null) {
      return send(res, 400, { error: "x-owner-id must be a uuid" });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : "bad body" });
    }

    // Charged against the caller, or the connection when there is none.
    const limitKey = ownerId ?? req.socket.remoteAddress ?? "anonymous";
    let spent = false;
    const ctx: Ctx = {
      params: url.pathname.match(route[1])!.slice(1),
      query: url.searchParams,
      body,
      ownerId,
      requireOwner: () => {
        if (!ownerId) throw new HttpError(401, "x-owner-id header required");
        return ownerId;
      },
      spend: () => {
        const result = limiter.take(limitKey);
        spent = true;
        if (!result.ok) {
          throw new HttpError(429, "rate limit reached for model-backed requests", {
            retryAfterSeconds: result.retryAfterSeconds,
          });
        }
      },
      refund: () => limiter.refund(limitKey),
    };

    try {
      const payload = await route[2](ctx);
      send(res, req.method === "POST" ? 201 : 200, payload as Record<string, unknown>);
    } catch (error) {
      if (error instanceof HttpError) {
        // A request that failed before the model answered should not cost an allowance slot.
        if (spent && error.status >= 500) ctx.refund();
        const headers = error.status === 429 ? { "retry-after": String(error.extra["retryAfterSeconds"] ?? 60) } : {};
        return send(res, error.status, { error: error.message, ...error.extra }, headers);
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
