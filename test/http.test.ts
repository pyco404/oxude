import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, migrate, type Db } from "../src/db/client.js";
import { listen, type Elicit } from "../src/http/server.js";
import { createAgent, snapshotPreset } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";
import { PRESET_NAMES } from "../src/index.js";

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

const api = (path: string, init: RequestInit & { owner?: string | null } = {}) => {
  const { owner = OWNER, ...rest } = init;
  return fetch(`${url}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(owner ? { "x-owner-id": owner } : {}),
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
    expect(created.agent.ownerId).toBe(OWNER);
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

  it("refuses without an owner header, and validates its input", async () => {
    const anon = await api("/agents", { method: "POST", owner: null, body: JSON.stringify({ name: "x", presetName: "Bully" }) });
    expect(anon.status).toBe(401);

    const bad = await api("/agents", { method: "POST", body: JSON.stringify({ name: "x", presetName: "Nobody" }) });
    expect(bad.status).toBe(400);
    expect((await readBody(bad)).known).toEqual(PRESET_NAMES);

    const nameless = await api("/agents", { method: "POST", body: JSON.stringify({ presetName: "Bully" }) });
    expect(nameless.status).toBe(400);

    const malformed = await api("/agents", { method: "POST", owner: "not-a-uuid", body: "{}" });
    expect(malformed.status).toBe(400);
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
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(201);

    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await readBody(limited)).error).toMatch(/rate limit/);

    // A different owner still has their own allowance.
    const other = await api("/preview", { method: "POST", owner: OTHER, body: JSON.stringify({ brief: "cautious" }) });
    expect(other.status).toBe(201);
  });

  it("requires an owner and some input", async () => {
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

    const preview = await readBody(
      await api("/preview", { method: "POST", body: JSON.stringify({ policyTable: listed.presets[0].policyTable }) }),
    );
    expect(typeof preview.preview.trueRating).toBe("number");
    expect(elicitCalls).toBe(before);
  });
});
