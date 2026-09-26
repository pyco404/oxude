import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { connect, migrate, type Db } from "../src/db/client.js";
import { listen } from "../src/http/server.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { chainOps } from "../src/db/schema.js";
import { troubledOps, oldestPending, volume } from "../src/db/admin.js";
import { solvency } from "../src/chain/worker.js";
import { drainChainOps } from "../src/chain/worker.js";
import { FakeChain } from "./fake-chain.js";
import { someWallet } from "./helpers.js";

/** Deterministic keypairs, as http.test.ts does: nothing asserts an identity it has not signed for. */
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

let db: Db;
let url: string;
let closeServer: () => Promise<void>;
let closeDb: () => Promise<void>;
let healthCalls = 0;

const ADMIN = walletOf("the-operator");

async function signIn(label: string): Promise<string> {
  const kp = keypairFor(label);
  const publicKey = bs58.encode(kp.publicKey);
  const issued = (await (
    await fetch(`${url}/auth/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey }),
    })
  ).json()) as any;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued.message), kp.secretKey));
  const session = (await (
    await fetch(`${url}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, nonce: issued.nonce, signature }),
    })
  ).json()) as any;
  return session.token as string;
}

const get = (token?: string) =>
  fetch(`${url}/admin`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

beforeAll(async () => {
  ({ db, close: closeDb } = await connect());
  await migrate(db);
  ({ url, close: closeServer } = await listen({
    db,
    adminWallets: [ADMIN],
    nonceRateLimit: { limit: 1000, windowMs: 60_000 },
    health: async () => {
      healthCalls++;
      return { ok: true };
    },
  }));
});
afterAll(async () => {
  await closeServer();
  await closeDb();
});

describe("who may read /admin", () => {
  it("needs a session at all", async () => {
    // 401, not 404: being signed out says nothing about who may read this.
    expect((await get()).status).toBe(401);
  });

  it("is a 404 for a signed-in wallet that is not on the list, not a 403", async () => {
    // A 403 would confirm the page exists to anyone who asked.
    const before = healthCalls;
    const res = await get(await signIn("somebody-else"));
    expect(res.status).toBe(404);
    // And nothing was read to answer them.
    expect(healthCalls).toBe(before);
  });

  it("answers the wallet on the list", async () => {
    const res = await get(await signIn("the-operator"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("has no admin at all when no wallet was configured", async () => {
    // A deployment that forgets ADMIN_WALLETS gets no admin page, not an open one.
    const c = await connect();
    await migrate(c.db);
    const server = await listen({ db: c.db, nonceRateLimit: { limit: 1000, windowMs: 60_000 }, health: async () => ({ ok: true }) });
    const saved = url;
    url = server.url;
    try {
      expect((await get(await signIn("the-operator"))).status).toBe(404);
    } finally {
      url = saved;
      await server.close();
      await c.close();
    }
  });
});

describe("what it reports", () => {
  const fresh = async () => {
    const c = await connect();
    await migrate(c.db);
    return c;
  };

  it("adds the ledger and the vaults to the same number when nothing is wrong", async () => {
    const { db: d, close } = await fresh();
    const chain = new FakeChain();
    const a = await createAgent(d, { name: "Sa", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(d, { name: "Sb", presetName: "Anchor", ownerId: someWallet() });
    for (let i = 0; i < 4; i++) await runMatch(d, a.id, b.id, { seed: 70 + i });
    await drainChainOps(d, chain, { limit: 200 });

    const sums = await solvency(d, chain);
    expect(sums.counted).toBe(2);
    expect(sums.unreachable).toBe(0);
    expect(sums.difference).toBe(0);
    expect(sums.ledger).toBe(sums.chain);
    expect(sums.inFlight).toBe(0);
    await close();
  });

  it("shows the shortfall as a negative difference when a vault is drained", async () => {
    const { db: d, close } = await fresh();
    const chain = new FakeChain();
    const a = await createAgent(d, { name: "Da", presetName: "Bully", ownerId: someWallet() });
    await createAgent(d, { name: "Db", presetName: "Anchor", ownerId: someWallet() });
    await drainChainOps(d, chain, { limit: 200 });

    chain.vaults.set(a.id, (chain.vaults.get(a.id) ?? 0) - 250);
    const sums = await solvency(d, chain);
    expect(sums.difference).toBe(-250);
    expect(sums.chain).toBeLessThan(sums.ledger);
    await close();
  });

  it("counts agents with ops in flight rather than quietly leaving them out", async () => {
    // reconcile skips them on purpose; a total that did would exclude exactly
    // the agents something is happening to.
    const { db: d, close } = await fresh();
    const chain = new FakeChain();
    const a = await createAgent(d, { name: "Fa", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(d, { name: "Fb", presetName: "Anchor", ownerId: someWallet() });
    await drainChainOps(d, chain, { limit: 200 });
    await runMatch(d, a.id, b.id, { seed: 5 });

    const sums = await solvency(d, chain);
    expect(sums.counted).toBe(2);
    expect(sums.inFlight).toBeGreaterThan(0);
    // The settlement has moved the ledger but not the vaults, so the totals
    // still agree: it takes from one and gives to the other.
    expect(sums.difference).toBe(0);
    await close();
  });

  it("separates ops given up on from ops still being retried", async () => {
    const { db: d, close } = await fresh();
    const a = await createAgent(d, { name: "Ta", presetName: "Anchor", ownerId: someWallet() });
    const old = new Date(Date.now() - 60 * 60_000);
    await d.insert(chainOps).values([
      { kind: "settle", fromAgent: a.id, amount: 10, status: "failed", lastError: "its vault can never open", createdAt: old },
      { kind: "settle", fromAgent: a.id, amount: 20, status: "pending", lastError: "Error Code: OutflowLimit", createdAt: old, attempts: 9 },
    ]);

    const t = await troubledOps(d, 15 * 60_000);
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0]!.lastError).toMatch(/never open/);
    expect(t.stuck.some((o) => o.lastError?.includes("OutflowLimit"))).toBe(true);
    // Both name the agent, because an id alone is no use at three in the morning.
    expect(t.failed[0]!.agentName).toBe("Ta");

    const oldestOp = await oldestPending(d);
    expect(oldestOp?.attempts).toBe(9);
    await close();
  });

  it("counts what happened without claiming to measure it twice", async () => {
    const { db: d, close } = await fresh();
    const a = await createAgent(d, { name: "Va", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(d, { name: "Vb", presetName: "Anchor", ownerId: someWallet() });
    const h = await createAgent(d, { name: "Vh", presetName: "Anchor" });
    for (let i = 0; i < 3; i++) await runMatch(d, a.id, b.id, { seed: 800 + i });
    await runMatch(d, a.id, h.id, { seed: 999 });

    const v = await volume(d);
    expect(v.agents.active).toBe(2);
    expect(v.agents.house).toBe(1);
    expect(v.matches.staked).toBe(3);
    expect(v.matches.ranked).toBe(3);
    expect(v.matches.exhibitions).toBe(1);
    expect(v.matches.last24h).toBe(4);
    expect(v.deposits.confirmed).toBe(0);
    await close();
  });
});
