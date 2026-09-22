import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { connect, migrate, type Db } from "../src/db/client.js";
import { clientAddress, listen, type Elicit } from "../src/http/server.js";
import { createAgent, snapshotPreset } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";
import { seasonAt } from "../src/season.js";
import { PRESET_NAMES } from "../src/index.js";
import { agents, bandByName, MIN_STAKE, STARTING_BALANCE } from "../src/db/schema.js";
import { balanceOf } from "../src/db/ledger.js";
import { someWallet } from "./helpers.js";

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
    const res = await api("/agents", { method: "POST", owner: "preset-renter", body: JSON.stringify({ name: "Preset rental", presetName: "Bully" }) });
    expect(res.status).toBe(201);
    const created = await readBody(res);
    expect(created.agent.presetName).toBe("Bully");
    expect(created.agent.ownerId).toBe(walletOf("preset-renter"));
    expect(typeof created.agent.trueRating).toBe("number");
    expect(created.agent.trueRatingBasis).toBe("against band B's roster as it stands today");
  });

  it("elicits and snapshots a table for a brief", async () => {
    const before = elicitCalls;
    const res = await api("/agents", { method: "POST", owner: "brief-renter", body: JSON.stringify({ name: "Briefed", brief: "bluff often" }) });
    expect(res.status).toBe(201);
    const created = await readBody(res);
    expect(elicitCalls).toBe(before + 1);
    expect(created.agent.brief).toBe("bluff often");
    expect(created.agent.presetName).toBeNull();

    // Playing it does not call the model again: the table is stored.
    const calls = elicitCalls;
    const play = await api(`/agents/${created.agent.id}/play`, { method: "POST", owner: "brief-renter" });
    expect(play.status).toBe(201);
    expect(elicitCalls).toBe(calls);
  });

  it("refuses without a session, and validates its input", async () => {
    const anon = await api("/agents", { method: "POST", owner: null, body: JSON.stringify({ name: "x", presetName: "Bully" }) });
    expect(anon.status).toBe(401);

    const bad = await api("/agents", { method: "POST", body: JSON.stringify({ name: "x", presetName: "Nobody" }) });
    expect(bad.status).toBe(400);
    expect((await readBody(bad)).known).toEqual(PRESET_NAMES);

    const badName = await api("/agents", { method: "POST", owner: "impostor", body: JSON.stringify({ name: "Oxude Admin", presetName: "Bully" }) });
    expect(badName.status).toBe(400);
    expect((await readBody(badName)).error).toMatch(/speaking for Oxude/);

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
    const res = await api("/agents", { method: "POST", owner: "doomed-renter", body: JSON.stringify({ name: "Doomed", brief: "whatever" }) });
    expect(res.status).toBe(503);
    expect((await readBody(res)).reason).toBe("timed out");
    elicitResult = { table: snapshotPreset("Mirage") };

    const ladder = await readBody(await api("/ladder"));
    expect(ladder.rows.map((r: { name: string }) => r.name)).not.toContain("Doomed");
  });
});

describe("GET /agents/:id", () => {
  it("shows the owner their brief and table, and shows others neither", async () => {
    const owner = "secret-keeper";
    const created = await readBody(
        await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Secretive", brief: "my edge" }) }),
    );

    const own = await readBody(await api(`/agents/${created.agent.id}`, { owner }));
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
    const owner = "player-renter";
    const created = await readBody(
        await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Player", presetName: "Anchor" }) }),
    );
    const played = await api(`/agents/${created.agent.id}/play`, { method: "POST", owner });
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
        await api("/agents", { method: "POST", owner: "sole-owner", body: JSON.stringify({ name: "Mine alone", presetName: "Hammer" }) }),
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
    const owner = someWallet();
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
    expect(previewed.preview.basis).toBe("against band B's roster as it stands today");
    expect(previewed.preview.roster).toBeGreaterThan(0);
  });

  it("rate limits the model-backed path per owner, and says when to retry", async () => {
    const owner = someWallet();
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
    const owner = someWallet();
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
  it("seeds a balance on renting and reports it with the band", async () => {
    const owner = someWallet();
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Banked", presetName: "Anchor", band: "A" }) }),
    );
    expect(created.agent.balance).toBe(STARTING_BALANCE);
    expect(created.agent.band).toBe("A");
    expect(created.agent.retired).toBe(false);

    const seen = await readBody(await api(`/agents/${created.agent.id}`, { owner: OTHER }));
    expect(seen.agent.balance).toBe(STARTING_BALANCE);
    expect(seen.agent.band).toBe("A");
  });

  it("stakes a match, settles it against balances, and reports both", async () => {
    const owner = someWallet();
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Stakes", presetName: "Bully" }) }),
    );
    const played = await readBody(await api(`/agents/${created.agent.id}/play`, { method: "POST", owner }));
    expect(played.stake).toBeGreaterThanOrEqual(MIN_STAKE);
    expect(played.stake).toBeLessThanOrEqual(bandByName("C").worstMatch);
    expect(Math.abs(played.result.net)).toBeLessThanOrEqual(played.stake);
    expect(played.balance).toBe(STARTING_BALANCE + played.result.net);
    expect(played.balance).toBe(await balanceOf(db, created.agent.id));

    const ledgerView = await readBody(await api(`/agents/${created.agent.id}/ledger`, { owner: null }));
    expect(ledgerView.movements[ledgerView.movements.length - 1].reason).toBe("rental-seed");
    expect(ledgerView.balance).toBe(played.balance);
  });

  it("lets the owner change the band, and refuses anyone else", async () => {
    const owner = someWallet();
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Banded", presetName: "Hammer" }) }),
    );
    // A fresh rental holds 900, so every band is open to it.
    const set = await readBody(
      await api(`/agents/${created.agent.id}/band`, { method: "POST", owner, body: JSON.stringify({ band: "C" }) }),
    );
    expect(set.band).toBe("C");

    const theirs = await api(`/agents/${created.agent.id}/band`, {
      method: "POST",
      owner: OTHER,
      body: JSON.stringify({ band: "A" }),
    });
    expect(theirs.status).toBe(403);

    const bad = await api(`/agents/${created.agent.id}/band`, { method: "POST", owner, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    const nonsense = await api(`/agents/${created.agent.id}/band`, {
      method: "POST",
      owner,
      body: JSON.stringify({ band: "Z" }),
    });
    expect(nonsense.status).toBe(400);
  });

  it("refuses to play an agent that cannot cover a stake", async () => {
    const owner = someWallet();
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Skint", presetName: "Mirage" }) }),
    );
    // Drain it to below the minimum stake.
    await db.execute(
      sql`insert into ledger (agent_id, amount, reason) values (${created.agent.id}::uuid, ${-(STARTING_BALANCE - 2)}, 'adjustment')`,
    );
    const res = await api(`/agents/${created.agent.id}/play`, { method: "POST", owner });
    expect(res.status).toBe(409);
    expect((await readBody(res)).error).toMatch(/cannot cover a band/);
  });
});

describe("first elicitation", () => {
  it("is free for a new owner and charged after that", async () => {
    const owner = someWallet();
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
    const owner = someWallet();
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Sharer", presetName: "Mirage" }) }),
    );
    const played = await readBody(await api(`/agents/${created.agent.id}/play`, { method: "POST", owner }));
    const match = await readBody(await api(`/matches/${played.matchId}`, { owner: null }));
    expect(match.summary.names.A).toBe("Sharer");
    expect(match.summary.presets.A).toBe("Mirage");
    expect(typeof match.summary.marks.A).toBe("string");
    expect(match.summary.marks.A).not.toBe(match.summary.marks.B);
    expect(match.match.agentA.presetName).toBe("Mirage");
    expect(match.summary.netA + match.summary.netB).toBe(0);
    expect(match.summary.rounds).toBe(match.log.rounds.length);
    expect("headline" in match.summary).toBe(true);
    if (match.summary.winner) expect(match.summary.winnerName).toBe(match.summary.names[match.summary.winner]);
    // Nothing private rides along.
    expect(JSON.stringify(match)).not.toContain("policyTable");
  });

  it("GET /roster lists who is available, by band", async () => {
    const all = await readBody(await api("/roster", { owner: null }));
    expect(all.bands.map((b: { name: string }) => b.name)).toEqual(["A", "B", "C"]);
    expect(all.agents.length).toBeGreaterThan(0);
    const counts = all.counts as Record<string, number>;
    expect(Object.keys(counts)).toEqual(["A", "B", "C"]);
    expect(counts["A"]! + counts["B"]! + counts["C"]!).toBeGreaterThanOrEqual(all.agents.length);

    const high = await readBody(await api("/roster?band=C", { owner: null }));
    expect(high.agents.every((a: { band: string }) => a.band === "C")).toBe(true);
    const low = await readBody(await api("/roster?band=A", { owner: null }));
    expect(low.agents.every((a: { band: string }) => a.band === "A")).toBe(true);
    const nonsense = await api("/roster?band=40-60", { owner: null });
    expect(nonsense.status).toBe(400);
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
      await api("/agents", { method: "POST", owner: "guarded-owner", body: JSON.stringify({ name: "Guarded", presetName: "Hammer" }) }),
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

describe("match feed and agent pages", () => {
  it("lists recent matches newest first, signed out, with the headline beat and nothing private", async () => {
    const owner = someWallet();
    const secret = "the secret plan nobody else may read";
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Feeder", brief: secret }) }),
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await readBody(await api(`/agents/${created.agent.id}/play`, { method: "POST", owner }))).matchId);
    }

    const res = await api("/matches?limit=50", { owner: null });
    expect(res.status).toBe(200);
    const feed = await readBody(res);
    const seqs = feed.matches.map((m: { seq: number }) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x: number, y: number) => y - x));
    expect(feed.matches.slice(0, 3).map((m: { id: string }) => m.id)).toEqual([...ids].reverse());
    const mine = feed.matches[0];
    expect(mine.a.name).toBe("Feeder");
    // Playstyle rides along for display: null for a brief, the preset's name otherwise.
    expect(mine.a.presetName).toBeNull();
    // Checked against the opponent actually chosen, not assumed to be a preset.
    // Matchmaking leaves out any agent whose vault has paid out its window, and
    // this whole file runs inside one window against a shared roster, so by now
    // the closest-rated eligible opponent can as easily be another player's
    // brief as a preset. What matters here is that the feed reports whichever
    // it was, correctly.
    const [opponent] = await db.select({ presetName: agents.presetName }).from(agents).where(eq(agents.id, mine.b.id));
    expect(mine.b.presetName).toBe(opponent!.presetName);
    // Every agent has its own mark.
    expect(typeof mine.a.mark).toBe("string");
    expect(mine.a.mark).not.toBe(mine.b.mark);
    expect(mine.netA + mine.netB).toBe(0);
    expect("headline" in mine && "beat" in mine).toBe(true);
    if (feed.bluff) expect(feed.bluff.beat).toBe("bluff-worked");

    const text = JSON.stringify(feed);
    for (const leak of [secret, "policyTable", "trueRating", "brief"]) expect(text).not.toContain(leak);

    // Paging continues strictly older.
    const older = await readBody(await api(`/matches?limit=5&before=${mine.seq}`, { owner: null }));
    expect(older.matches.every((m: { seq: number }) => m.seq < mine.seq)).toBe(true);
    expect((await api("/matches?before=soon", { owner: null })).status).toBe(400);
  });

  it("lists one agent's matches, and its public page never carries its brief", async () => {
    const owner = someWallet();
    const secret = "fold everything except the nuts";
    const created = await readBody(
      await api("/agents", { method: "POST", owner, body: JSON.stringify({ name: "Solo", brief: secret }) }),
    );
    const played = await readBody(await api(`/agents/${created.agent.id}/play`, { method: "POST", owner }));

    const list = await readBody(await api(`/agents/${created.agent.id}/matches`, { owner: null }));
    expect(list.matches.map((m: { id: string }) => m.id)).toEqual([played.matchId]);
    for (const m of list.matches) expect([m.a.id, m.b.id]).toContain(created.agent.id);
    expect(list.record.wins + list.record.losses + list.record.level).toBe(1);

    const page = await readBody(await api(`/agents/${created.agent.id}`, { owner: null }));
    expect(page.view).toBe("public");
    expect(page.agent.presetName).toBeNull();
    expect(page.agent.house).toBe(false);
    expect(typeof page.agent.balance).toBe("number");
    expect(JSON.stringify(page)).not.toContain(secret);

    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await api(`/agents/${missing}/matches`, { owner: null })).status).toBe(404);
  });
});

describe("one agent at a time", () => {
  const rent = (owner: string, name: string) =>
    api("/agents", { method: "POST", owner, body: JSON.stringify({ name, presetName: "Anchor" }) });

  it("refuses a second rental while the first is still in play, and says what holds the place", async () => {
    const owner = "one-at-a-time";
    const first = await readBody(await rent(owner, "First"));
    expect(first.agent.name).toBe("First");

    const res = await rent(owner, "Second");
    expect(res.status).toBe(409);
    const body = await readBody(res);
    expect(body.error).toMatch(/already have an agent in play: First/);
    expect(body.agents).toEqual([{ id: first.agent.id, name: "First" }]);

    // Nothing was created, and no model call was spent on the refusal.
    const mine = await readBody(await api("/auth/me", { owner }));
    expect(mine.agents.map((a: Json) => a.name)).toEqual(["First"]);
  });

  it("holds the line when two devices rent at the same moment", async () => {
    const owner = "two-devices";
    const [a, b] = await Promise.all([rent(owner, "Laptop"), rent(owner, "Phone")]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
    const mine = await readBody(await api("/auth/me", { owner }));
    expect(mine.agents).toHaveLength(1);
    expect(["Laptop", "Phone"]).toContain(mine.agents[0]!.name);
  });

  it("lets the owner rent again once the agent has retired, and keeps the old one on the list", async () => {
    const owner = "renter-again";
    const first = await readBody(await rent(owner, "Retiree"));
    await db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, first.agent.id));

    expect((await rent(owner, "Successor")).status).toBe(201);
    const mine = await readBody(await api("/auth/me", { owner }));
    // Still playing first, then the retired one: both are the owner's.
    expect(mine.agents.map((a: Json) => [a.name, a.retired])).toEqual([
      ["Successor", false],
      ["Retiree", true],
    ]);
  });

  it("lists every agent an owner holds, whichever device asks", async () => {
    const owner = "lister";
    const { agent } = await readBody(await rent(owner, "Only"));
    const mine = await readBody(await api("/auth/me", { owner }));
    expect(mine.ownerId).toBe(walletOf(owner));
    expect(mine.agents).toHaveLength(1);
    // Enough for the panel to render without a second request per agent.
    expect(mine.agents[0]).toMatchObject({
      agentId: agent.id,
      name: "Only",
      presetName: "Anchor",
      balance: STARTING_BALANCE,
      retired: false,
      house: false,
    });
    expect(mine.agents[0]!.mark).toBeTruthy();
  });

  it("does not stop a different wallet renting", async () => {
    await rent("wallet-one", "Mine");
    expect((await rent("wallet-two", "Theirs")).status).toBe(201);
  });
});

describe("autoplay over http", () => {
  const create = async (owner: string, name: string) =>
    (await readBody(await api("/agents", { method: "POST", owner, body: JSON.stringify({ name, presetName: "Anchor" }) }))).agent;

  it("shows autoplay and the summary to the owner only", async () => {
    const owner = someWallet();
    const agent = await create(owner, "Private");
    const mine = await readBody(await api(`/agents/${agent.id}`, { owner }));
    expect(mine.view).toBe("owner");
    expect(mine.autoplay.state).toBe("off");
    expect(mine).toHaveProperty("sinceYouLeft");

    const theirs = await readBody(await api(`/agents/${agent.id}`, { owner: someWallet() }));
    expect(theirs.view).toBe("public");
    expect(theirs.autoplay).toBeUndefined();
    expect(theirs.sinceYouLeft).toBeUndefined();

    const signedOut = await readBody(await api(`/agents/${agent.id}`, { owner: null }));
    expect(signedOut.autoplay).toBeUndefined();
  });

  it("turns autoplay on with a floor, and reports at once whether it can play", async () => {
    const owner = someWallet();
    const agent = await create(owner, "Switch");
    const on = await readBody(
      await api(`/agents/${agent.id}/autoplay`, { method: "POST", owner, body: JSON.stringify({ enabled: true, floor: 300 }) }),
    );
    expect(on.autoplay.enabled).toBe(true);
    expect(on.autoplay.floor).toBe(300);
    expect(["on", "waiting"]).toContain(on.autoplay.state);

    // A floor it cannot clear: the response says so now, not on the next tick.
    const tooHigh = await readBody(
      await api(`/agents/${agent.id}/autoplay`, { method: "POST", owner, body: JSON.stringify({ enabled: true, floor: 5000 }) }),
    );
    expect(tooHigh.autoplay.state).toBe("paused");
    expect(tooHigh.autoplay.message).toBe("Paused: balance is below your floor (5000).");
  });

  it("refuses to let anyone else switch it or mark it seen", async () => {
    const owner = someWallet();
    const agent = await create(owner, "NotYours");
    const other = someWallet();
    const flip = await api(`/agents/${agent.id}/autoplay`, { method: "POST", owner: other, body: JSON.stringify({ enabled: true }) });
    expect(flip.status).toBe(403);
    const seen = await api(`/agents/${agent.id}/seen`, { method: "POST", owner: other });
    expect(seen.status).toBe(403);
  });

  it("rejects a floor that is not a whole number of chips", async () => {
    const owner = someWallet();
    const agent = await create(owner, "BadFloor");
    for (const floor of [-1, 12.5, "300"]) {
      const res = await api(`/agents/${agent.id}/autoplay`, { method: "POST", owner, body: JSON.stringify({ enabled: true, floor }) });
      expect(res.status).toBe(400);
    }
  });
});

describe("characters over HTTP", () => {
  it("names an agent rented without a name, and keeps a name the owner chose", async () => {
    const nameless = await readBody(await api("/agents", { method: "POST", owner: "nameless", body: JSON.stringify({ presetName: "Bully" }) }));
    expect(nameless.agent.name).toMatch(/^[A-Z][a-z]{3,10}$/);
    expect(nameless.agent.character).toMatchObject({ nameSource: "generated" });
    expect(nameless.agent.character.bio).toContain(nameless.agent.name);

    // What the rent screen fills in when the box is empty was never chosen: it is replaced too.
    const defaulted = await readBody(await api("/agents", { method: "POST", owner: "defaulted", body: JSON.stringify({ name: "Mirage rental", presetName: "Mirage" }) }));
    expect(defaulted.agent.name).not.toBe("Mirage rental");
    expect(defaulted.agent.character.nameSource).toBe("generated");

    const chosen = await readBody(await api("/agents", { method: "POST", owner: "chooser", body: JSON.stringify({ name: "Lanternjaw", presetName: "Anchor" }) }));
    expect(chosen.agent.name).toBe("Lanternjaw");
    expect(chosen.agent.character).toMatchObject({ nameSource: "owner" });
  });
});

describe("ladder periods over HTTP", () => {
  it("serves all time by default, and a season or today when asked", async () => {
    const all = await readBody(await api("/ladder?sort=winnings", { owner: null }));
    expect(all.period).toBe("all");
    const season = await readBody(await api("/ladder?sort=winnings&period=season", { owner: null }));
    expect(season.season).toMatchObject({ key: seasonAt(new Date()).key, current: true });
    const day = await readBody(await api("/ladder?sort=per-match&period=day", { owner: null }));
    expect(day.period).toBe("day");
    expect((await api("/ladder?period=year", { owner: null })).status).toBe(400);
    expect((await api("/ladder?period=season&season=2026-09-22", { owner: null })).status).toBe(400);
  });
});

describe("seasons over HTTP", () => {
  it("serves the season, shows the owner where the rental stands, and renews it once", async () => {
    const season = await readBody(await api("/season", { owner: null }));
    expect(season.season.key).toBe(seasonAt(new Date()).key);
    expect(season.graceHours).toBe(24);

    const created = await readBody(
      await api("/agents", { method: "POST", owner: "renewer", body: JSON.stringify({ name: "Renewer", presetName: "Anchor" }) }),
    );
    const id = created.agent.id as string;
    const before = await readBody(await api(`/agents/${id}`, { owner: "renewer" }));
    expect(before.rental).toMatchObject({ state: "active", canRenew: true });
    expect(new Date(before.rental.endsAt).getTime()).toBe(seasonAt(new Date()).end.getTime());

    expect((await api(`/agents/${id}/renew`, { method: "POST", owner: "someone-else" })).status).toBe(403);
    const renewed = await api(`/agents/${id}/renew`, { method: "POST", owner: "renewer" });
    expect(renewed.status).toBe(201);
    expect((await readBody(renewed)).rental.state).toBe("renewed");
    // Once per season.
    const again = await api(`/agents/${id}/renew`, { method: "POST", owner: "renewer" });
    expect(again.status).toBe(409);
    expect((await readBody(again)).error).toMatch(/already renewed/);
  });
});

