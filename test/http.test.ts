import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { connect, migrate, type Db } from "../src/db/client.js";
import { clientAddress, listen, type Elicit } from "../src/http/server.js";
import { createAgent, snapshotPreset } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";
import { PRESET_NAMES } from "../src/index.js";
import { agents, MAX_EXPOSURE, MIN_STAKE, STARTING_BALANCE } from "../src/db/schema.js";
import { balanceOf } from "../src/db/ledger.js";

// Over real HTTP: the tests start a server and use fetch, so routing, headers,
// status codes and JSON parsing are all exercised.

const OWNER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

let db: Db;
let url: string;
let closeServer: () => Promise<void>;
let closeDb: () => Promise<void>;
let elicitCalls = 0;
let elicitResult: Awaited<ReturnType<Elicit>> = { table: snapshotPreset("Mirage") };

const elicit: Elicit = async () => {
  elicitCalls++;
  return elicitResult;
};

/** Responses are plain JSON here; the shapes are asserted, not typed. */
type Json = Record<string, any>;
const readBody = async (res: Response): Promise<Json> => (await res.json()) as Json;

/**
 * Owners are real wallets: each label maps to a deterministic ed25519 keypair,
 * which signs in through the actual nonce -> sign -> verify flow the first time
 * it is used. Nothing in these tests asserts an identity it has not signed for.
 */
const keypairs = new Map<string, nacl.SignKeyPair>();
const keypairFor = (label: string) => {
  let kp = keypairs.get(label);
  if (!kp) {
    kp = nacl.sign.keyPair.fromSeed(createHash("sha256").update(label).digest());
    keypairs.set(label, kp);
  }
  return kp;
};
const walletOf = (label: string) => bs58.encode(keypairFor(label).publicKey);

async function signIn(label: string): Promise<string> {
  const kp = keypairFor(label);
  const publicKey = bs58.encode(kp.publicKey);
  const issued = await readBody(
    await fetch(`${url}/auth/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey }),
    }),
  );
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued.message), kp.secretKey));
  const session = await readBody(
    await fetch(`${url}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, nonce: issued.nonce, signature }),
    }),
  );
  return session.token as string;
}

const tokens = new Map<string, string>();
async function tokenFor(label: string): Promise<string> {
  let token = tokens.get(label);
  if (!token) {
    token = await signIn(label);
    tokens.set(label, token);
  }
  return token;
}

const api = async (path: string, init: RequestInit & { owner?: string | null } = {}) => {
  const { owner = OWNER, ...rest } = init;
  const token = owner ? await tokenFor(owner) : null;
  return fetch(`${url}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
};

beforeAll(async () => {
  ({ db, close: closeDb } = await connect());
  await migrate(db);
  // A roster to play against and rate against.
  for (let i = 0; i < 8; i++) {
    await createAgent(db, { name: `Roster-${i}`, presetName: PRESET_NAMES[i % PRESET_NAMES.length]! });
  }
  await refreshTrueRatings(db);
  ({ url, close: closeServer } = await listen({
    db,
    elicit,
    rateLimit: { limit: 3, windowMs: 60_000 },
    nonceRateLimit: { limit: 1000, windowMs: 60_000 },
    playRateLimit: { limit: 4, windowMs: 60_000 },
  }));
});
afterAll(async () => {
  await closeServer();
  await closeDb();
});

describe("POST /agents", () => {
  it("rents a preset agent and returns its private rating", async () => {
    const res = await api("/agents", { method: "POST", body: JSON.stringify({ name: "Preset rental", presetName: "Bully" }) });
    expect(res.status).toBe(201);
    const created = await readBody(res);
    expect(created.agent.presetName).toBe("Bully");
    expect(created.agent.ownerId).toBe(walletOf(OWNER));
    expect(typeof created.agent.trueRating).toBe("number");
    expect(created.agent.trueRatingBasis).toBe("against the roster as it stands today");
  });

  it("elicits and snapshots a table for a brief", async () => {
    const before = elicitCalls;
    const res = await api("/agents", { method: "POST", body: JSON.stringify({ name: "Briefed", brief: "bluff often" }) });
    expect(res.status).toBe(201);
    const created = await readBody(res);
    expect(elicitCalls).toBe(before + 1);
    expect(created.agent.brief).toBe("bluff often");
    expect(created.agent.presetName).toBeNull();

    // Playing it does not call the model again: the table is stored.
    const calls = elicitCalls;
    const play = await api(`/agents/${created.agent.id}/play`, { method: "POST" });
    expect(play.status).toBe(201);
    expect(elicitCalls).toBe(calls);
  });

  it("refuses without a session, and validates its input", async () => {
    const anon = await api("/agents", { method: "POST", owner: null, body: JSON.stringify({ name: "x", presetName: "Bully" }) });
    expect(anon.status).toBe(401);

    const bad = await api("/agents", { method: "POST", body: JSON.stringify({ name: "x", presetName: "Nobody" }) });
    expect(bad.status).toBe(400);
    expect((await readBody(bad)).known).toEqual(PRESET_NAMES);

    const nameless = await api("/agents", { method: "POST", body: JSON.stringify({ presetName: "Bully" }) });
    expect(nameless.status).toBe(400);

    // A token nobody issued is simply signed out.
    const forged = await fetch(`${url}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-real-session" },
      body: JSON.stringify({ name: "x", presetName: "Bully" }),
    });
    expect(forged.status).toBe(401);
  });

  it("creates no agent when elicitation fails", async () => {
    elicitResult = { table: null, reason: "timed out" };
    const res = await api("/agents", { method: "POST", body: JSON.stringify({ name: "Doomed", brief: "whatever" }) });
    expect(res.status).toBe(503);
    expect((await readBody(res)).reason).toBe("timed out");
    elicitResult = { table: snapshotPreset("Mirage") };

    const ladder = await readBody(await api("/ladder"));
    expect(ladder.rows.map((r: { name: string }) => r.name)).not.toContain("Doomed");
  });
});

describe("GET /agents/:id", () => {
  it("shows the owner their brief and table, and shows others neither", async () => {
    const created = await readBody(
        await api("/agents", { method: "POST", body: JSON.stringify({ name: "Secretive", brief: "my edge" }) }),
    );

    const own = await readBody(await api(`/agents/${created.agent.id}`));
    expect(own.view).toBe("owner");
    expect(own.agent.brief).toBe("my edge");
    expect(own.agent.policyTable).toBeDefined();
    expect(typeof own.agent.trueRating).toBe("number");

    const theirs = await readBody(await api(`/agents/${created.agent.id}`, { owner: OTHER }));
    expect(theirs.view).toBe("public");
    expect(theirs.agent.brief).toBeUndefined();
    expect(theirs.agent.policyTable).toBeUndefined();
    expect(theirs.agent.trueRating).toBeUndefined();
    expect(theirs.agent.name).toBe("Secretive");

    expect((await api("/agents/not-a-uuid")).status).toBe(400);
    expect((await api("/agents/cccccccc-3333-4333-8333-cccccccccccc")).status).toBe(404);
  });
});

describe("POST /agents/:id/play", () => {
  it("finds an opponent, plays, and records a readable match", async () => {
    const created = await readBody(
        await api("/agents", { method: "POST", body: JSON.stringify({ name: "Player", presetName: "Anchor" }) }),
    );
    const played = await api(`/agents/${created.agent.id}/play`, { method: "POST" });
    expect(played.status).toBe(201);
    const result = await readBody(played);
    expect(result.opponent.id).not.toBe(created.agent.id);
    expect(["closest-rating", "preset-fallback"]).toContain(result.matchmaking.path);
    expect(result.result.net + result.result.opponentNet).toBe(0);

    const match = await readBody(await api(`/matches/${result.matchId}`));
    expect(match.transcript).toContain("Round 1.");
    expect(match.transcript.split("\n")[0]).toBe(`${match.match.agentA.name} vs ${match.match.agentB.name}`);
    expect(match.match.netA).toBe(result.result.net);
    expect(match.log.rounds.length).toBeGreaterThan(0);
  });

  it("will not play someone else's agent", async () => {
    const created = await readBody(
        await api("/agents", { method: "POST", body: JSON.stringify({ name: "Mine alone", presetName: "Hammer" }) }),
    );
    const res = await api(`/agents/${created.agent.id}/play`, { method: "POST", owner: OTHER });
    expect(res.status).toBe(403);
  });
});

describe("GET /ladder", () => {
  it("serves both tabs and rejects any other sort", async () => {
    const winnings = await readBody(await api("/ladder?sort=winnings"));
    expect(winnings.sort).toBe("winnings");
    const nets = winnings.rows.map((r: { cumulativeNet: number }) => r.cumulativeNet);
    expect([...nets].sort((a: number, b: number) => b - a)).toEqual(nets);

    const perMatch = await readBody(await api("/ladder?sort=per-match"));
    const per = perMatch.rows.map((r: { netPerMatch: number }) => r.netPerMatch);
    expect([...per].sort((a: number, b: number) => b - a)).toEqual(per);
    for (const row of [...winnings.rows, ...perMatch.rows]) expect(row.trueRating).toBeUndefined();

    expect((await api("/ladder?sort=vibes")).status).toBe(400);
  });
  it("rents the table the owner was shown when they rated the brief, without asking the model again", async () => {
    const owner = "abababab-1212-4121-8121-abababababab";
    const brief = "raise the weak hands, fold the middle";
    elicitResult = { table: snapshotPreset("Hammer") };
    try {
      const before = elicitCalls;
      expect((await api("/preview", { method: "POST", owner, body: JSON.stringify({ brief }) })).status).toBe(201);
      elicitResult = { table: snapshotPreset("Bully") }; // what a second call would have returned

      const res = await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "As rated", brief }) });
      expect(res.status).toBe(201);
      const created = await readBody(res);
      expect(elicitCalls).toBe(before + 1);
      expect(created.elicitation.reusedRatedTable).toBe(true);
      const [row] = await db.select().from(agents).where(eq(agents.id, created.agent.id));
      expect(row!.policyTable).toEqual(snapshotPreset("Hammer"));

      // Another owner renting the same words gets their own call.
      const other = await readBody(await api("/agents", { method: "POST", owner: OTHER, body: JSON.stringify({ name: "Copy", brief }) }));
      expect(other.elicitation.reusedRatedTable).toBe(false);
      expect(elicitCalls).toBe(before + 2);
    } finally {
      elicitResult = { table: snapshotPreset("Mirage") };
    }
  });
});

describe("POST /preview", () => {
  it("rates a supplied table without spending a model call or creating an agent", async () => {
    const before = elicitCalls;
    const res = await api("/preview", { method: "POST", body: JSON.stringify({ policyTable: snapshotPreset("Bully") }) });
    expect(res.status).toBe(201);
    const previewed = await readBody(res);
    expect(elicitCalls).toBe(before);
    expect(typeof previewed.preview.trueRating).toBe("number");
    expect(previewed.preview.basis).toBe("against the roster as it stands today");
    expect(previewed.preview.roster).toBeGreaterThan(0);
  });

  it("rate limits the model-backed path per owner, and says when to retry", async () => {
    const owner = "dddddddd-4444-4444-8444-dddddddddddd";
    const attempt = () => api("/preview", { method: "POST", owner, body: JSON.stringify({ brief: "aggressive" }) });
    // One free call for a new owner, then the allowance of three.
    for (let i = 0; i < 4; i++) expect((await attempt()).status).toBe(201);

    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await readBody(limited)).error).toMatch(/rate limit/);

    // A different owner still has their own allowance.
    const other = await api("/preview", { method: "POST", owner: OTHER, body: JSON.stringify({ brief: "cautious" }) });
    expect(other.status).toBe(201);
  });

  it("rates a supplied table signed out, but needs a wallet to spend a model call", async () => {
    const table = await api("/preview", { method: "POST", owner: null, body: JSON.stringify({ policyTable: snapshotPreset("Anchor") }) });
    expect(table.status).toBe(201);
    expect((await api("/preview", { method: "POST", owner: null, body: JSON.stringify({ brief: "x" }) })).status).toBe(401);
    expect((await api("/preview", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });
});

describe("transport", () => {
  it("rejects unknown routes and unparseable bodies", async () => {
    expect((await api("/nope")).status).toBe(404);
    const bad = await api("/preview", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await readBody(bad)).error).toMatch(/valid JSON/);
  });
});

describe("play rate limit", () => {
  it("caps matches per owner and keeps the writes bounded", async () => {
    const owner = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Busy", presetName: "Bully" }) }),
    );
    const play = () => api(`/agents/${created.agent.id}/play`, { method: "POST", owner });
    for (let i = 0; i < 4; i++) expect((await play()).status).toBe(201);

    const limited = await play();
    expect(limited.status).toBe(429);
    expect((await readBody(limited)).error).toMatch(/playing matches/);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("GET /presets", () => {
  it("serves the shipped tables free, so the UI can rate them without a model call", async () => {
    const before = elicitCalls;
    const res = await api("/presets", { owner: null });
    expect(res.status).toBe(200);
    const listed = await readBody(res);
    expect(listed.free).toBe(true);
    expect(listed.presets.map((p: { name: string }) => p.name)).toEqual(PRESET_NAMES);
    for (const preset of listed.presets) expect(preset.description.length).toBeGreaterThan(20);

    const preview = await readBody(
      await api("/preview", { method: "POST", body: JSON.stringify({ policyTable: listed.presets[0].policyTable }) }),
    );
    expect(typeof preview.preview.trueRating).toBe("number");
    expect(elicitCalls).toBe(before);
  });
});

describe("CORS", () => {
  it("answers the browser preflight and allows the web app's origin", async () => {
    const preflight = await fetch(`${url}/preview`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const get = await api("/presets", { owner: null });
    expect(get.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    // retry-after must be readable by the browser for the rate-limit message to work.
    expect(get.headers.get("access-control-expose-headers")).toContain("retry-after");
  });
});

describe("staking over HTTP", () => {
  const owner = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

  it("seeds a balance on renting and reports it with the ceiling", async () => {
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Banked", presetName: "Anchor", maxStake: 25 }) }),
    );
    expect(created.agent.balance).toBe(STARTING_BALANCE);
    expect(created.agent.maxStake).toBe(25);
    expect(created.agent.retired).toBe(false);

    const seen = await readBody(await api(`/agents/${created.agent.id}`, { owner: OTHER }));
    expect(seen.agent.balance).toBe(STARTING_BALANCE);
    expect(seen.agent.maxStake).toBe(25);
  });

  it("stakes a match, settles it against balances, and reports both", async () => {
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Stakes", presetName: "Bully" }) }),
    );
    const played = await readBody(await api(`/agents/${created.agent.id}/play`, { method: "POST", owner }));
    expect(played.stake).toBeGreaterThanOrEqual(MIN_STAKE);
    expect(played.stake).toBeLessThanOrEqual(MAX_EXPOSURE);
    expect(Math.abs(played.result.net)).toBeLessThanOrEqual(played.stake);
    expect(played.balance).toBe(STARTING_BALANCE + played.result.net);
    expect(played.balance).toBe(await balanceOf(db, created.agent.id));

    const ledgerView = await readBody(await api(`/agents/${created.agent.id}/ledger`, { owner: null }));
    expect(ledgerView.movements[ledgerView.movements.length - 1].reason).toBe("rental-seed");
    expect(ledgerView.balance).toBe(played.balance);
  });

  it("lets the owner change the ceiling, and refuses anyone else", async () => {
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Ceilinged", presetName: "Hammer" }) }),
    );
    const set = await readBody(
      await api(`/agents/${created.agent.id}/ceiling`, { method: "POST", owner, body: JSON.stringify({ maxStake: 1000 }) }),
    );
    expect(set.maxStake).toBe(MAX_EXPOSURE); // clamped

    const theirs = await api(`/agents/${created.agent.id}/ceiling`, {
      method: "POST",
      owner: OTHER,
      body: JSON.stringify({ maxStake: 10 }),
    });
    expect(theirs.status).toBe(403);

    const bad = await api(`/agents/${created.agent.id}/ceiling`, { method: "POST", owner, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
  });

  it("refuses to play an agent that cannot cover a stake", async () => {
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Skint", presetName: "Mirage" }) }),
    );
    // Drain it to below the minimum stake.
    await db.execute(
      sql`insert into ledger (agent_id, amount, reason) values (${created.agent.id}::uuid, ${-(STARTING_BALANCE - 2)}, 'adjustment')`,
    );
    const res = await api(`/agents/${created.agent.id}/play`, { method: "POST", owner });
    expect(res.status).toBe(409);
    expect((await readBody(res)).error).toMatch(/cannot cover a stake/);
  });
});

describe("first elicitation", () => {
  it("is free for a new owner and charged after that", async () => {
    const owner = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
    const first = await readBody(await api("/preview", { method: "POST", owner, body: JSON.stringify({ brief: "play tight" }) }));
    expect(first.elicitation.free).toBe(true);

    const second = await readBody(await api("/preview", { method: "POST", owner, body: JSON.stringify({ brief: "play loose" }) }));
    expect(second.elicitation.free).toBe(false);

    // The free one did not consume the allowance: three charged calls still fit.
    for (let i = 0; i < 2; i++) {
      const res = await api("/preview", { method: "POST", owner, body: JSON.stringify({ brief: `variation ${i}` }) });
      expect(res.status).toBe(201);
    }
    const limited = await api("/preview", { method: "POST", owner, body: JSON.stringify({ brief: "one too many" }) });
    expect(limited.status).toBe(429);
  });
});

describe("sharing and the roster", () => {
  it("GET /matches/:id carries a summary a share card can use", async () => {
    const owner = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Sharer", presetName: "Mirage" }) }),
    );
    const played = await readBody(await api(`/agents/${created.agent.id}/play`, { method: "POST", owner }));
    const match = await readBody(await api(`/matches/${played.matchId}`, { owner: null }));
    expect(match.summary.names.A).toBe("Sharer");
    expect(match.summary.netA + match.summary.netB).toBe(0);
    expect(match.summary.rounds).toBe(match.log.rounds.length);
    expect("headline" in match.summary).toBe(true);
    if (match.summary.winner) expect(match.summary.winnerName).toBe(match.summary.names[match.summary.winner]);
    // Nothing private rides along.
    expect(JSON.stringify(match)).not.toContain("policyTable");
  });

  it("GET /roster lists who is available, by band", async () => {
    const all = await readBody(await api("/roster", { owner: null }));
    expect(all.bands.map((b: { name: string }) => b.name)).toEqual(["10-20", "20-40", "40-60"]);
    expect(all.agents.length).toBeGreaterThan(0);

    const high = await readBody(await api("/roster?band=40-60", { owner: null }));
    expect(high.agents.every((a: { maxStake: number }) => a.maxStake > 40)).toBe(true);
    const low = await readBody(await api("/roster?band=10-20", { owner: null }));
    expect(low.agents.every((a: { maxStake: number }) => a.maxStake <= 20)).toBe(true);
    for (const a of all.agents) expect(a.trueRating).toBeUndefined();

    expect((await api("/roster?band=5-500", { owner: null })).status).toBe(400);
  });
});

describe("wallet sign-in", () => {
  const signFor = (label: string, message: string) =>
    bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypairFor(label).secretKey));
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it("issues a nonce inside a message that names the site and says it costs nothing", async () => {
    const publicKey = walletOf("reader");
    const issued = await readBody(await post("/auth/nonce", { publicKey }));
    expect(issued.message).toContain("wants you to sign in with your Solana account:");
    expect(issued.message).toContain(publicKey);
    expect(issued.message).toContain(`Nonce: ${issued.nonce}`);
    expect(issued.message).toMatch(/will not trigger a transaction or cost any fees/);
    expect((await post("/auth/nonce", { publicKey: "not-base58-0OIl" })).status).toBe(400);
  });

  it("opens a session for a valid signature, and the session identifies the wallet", async () => {
    const token = await signIn("verifier");
    const me = await readBody(await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
    expect(me.ownerId).toBe(walletOf("verifier"));
  });

  it("rejects a signature from the wrong key, a replayed nonce, and a nonce issued to someone else", async () => {
    const publicKey = walletOf("victim");
    const issued = await readBody(await post("/auth/nonce", { publicKey }));

    // Signed by an attacker's key, claiming the victim's.
    const forged = await post("/auth/verify", { publicKey, nonce: issued.nonce, signature: signFor("attacker", issued.message) });
    expect(forged.status).toBe(401);

    // A good signature, used twice.
    const good = { publicKey, nonce: issued.nonce, signature: signFor("victim", issued.message) };
    expect((await post("/auth/verify", good)).status).toBe(201);
    const replay = await post("/auth/verify", good);
    expect(replay.status).toBe(401);
    expect((await readBody(replay)).reason).toMatch(/already used/);

    // A nonce issued to one key, presented with another.
    const other = await readBody(await post("/auth/nonce", { publicKey: walletOf("bystander") }));
    const swapped = await post("/auth/verify", {
      publicKey,
      nonce: other.nonce,
      signature: signFor("victim", other.message),
    });
    expect(swapped.status).toBe(401);
    expect((await readBody(swapped)).reason).toMatch(/different key/);
  });

  it("rejects a tampered message: the server verifies what it issued, not what was sent", async () => {
    const publicKey = walletOf("tamper");
    const issued = await readBody(await post("/auth/nonce", { publicKey }));
    const altered = issued.message.replace("Sign in to Oxude", "Approve a transfer");
    const res = await post("/auth/verify", { publicKey, nonce: issued.nonce, signature: signFor("tamper", altered) });
    expect(res.status).toBe(401);
  });

  it("revokes a session on logout", async () => {
    const token = await signIn("leaver");
    expect((await post("/auth/logout", {}, token)).status).toBe(201);
    const after = await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  });

  it("ignores the old x-owner-id header entirely", async () => {
    const created = await readBody(
      await api("/agents", { method: "POST", body: JSON.stringify({ name: "Guarded", presetName: "Hammer" }) }),
    );
    const res = await fetch(`${url}/agents/${created.agent.id}/play`, {
      method: "POST",
      headers: { "x-owner-id": walletOf(OWNER) },
    });
    expect(res.status).toBe(403);
    const view = await readBody(await fetch(`${url}/agents/${created.agent.id}`, { headers: { "x-owner-id": walletOf(OWNER) } }));
    expect(view.view).toBe("public");
    expect(view.agent.brief).toBeUndefined();
  });
});

describe("client address for rate limits", () => {
  const req = (forwarded: string | undefined) =>
    ({ headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }, socket: { remoteAddress: "10.0.0.1" } }) as never;

  it("ignores X-Forwarded-For unless told a proxy sits in front, since anyone can send it", () => {
    delete process.env["TRUST_PROXY"];
    expect(clientAddress(req("6.6.6.6"))).toBe("10.0.0.1");
  });

  it("behind a proxy, takes the entry the proxy appended, not one the client made up", () => {
    process.env["TRUST_PROXY"] = "1";
    try {
      expect(clientAddress(req("6.6.6.6, 203.0.113.7"))).toBe("203.0.113.7");
      expect(clientAddress(req(undefined))).toBe("10.0.0.1");
    } finally {
      delete process.env["TRUST_PROXY"];
    }
  });
});
