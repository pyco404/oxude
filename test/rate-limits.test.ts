import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { listen } from "../src/http/server.js";
import { agents } from "../src/db/schema.js";

// Renting and the faucet are charged against the wallet *and* the address a
// request came from. The older limiter used one or the other - the wallet when
// signed in, otherwise the address - which left a gap either way: one wallet
// behind many addresses, or, since a wallet costs nothing to make, one address
// cycling through as many as it likes.

let db: Db;
let closeDb: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;

const seedOf = (label: string) => createHash("sha256").update(label).digest();
const walletOf = (label: string) => Keypair.fromSeed(seedOf(label)).publicKey.toBase58();
const tokens = new Map<string, string>();

async function tokenFor(label: string): Promise<string> {
  if (tokens.has(label)) return tokens.get(label)!;
  const kp = nacl.sign.keyPair.fromSeed(seedOf(label));
  const publicKey = bs58.encode(kp.publicKey);
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      (r) => r.json() as Promise<Record<string, string>>,
    );
  const issued = await post("/auth/nonce", { publicKey });
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued["message"]!), kp.secretKey));
  const { token } = await post("/auth/verify", { publicKey, nonce: issued["nonce"], signature });
  tokens.set(label, token!);
  return token!;
}

const rent = async (as: string) => {
  const res = await fetch(`${url}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await tokenFor(as)}` },
    body: JSON.stringify({ presetName: "Anchor" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  ({ db, close: closeDb } = await connect());
  await migrate(db);
  ({ url, close: closeServer } = await listen({
    db,
    // Reachable in a test: a generous per-wallet rule and a tight per-address
    // one, which is the shape the real defaults have.
    rentRateLimit: { limit: 50, windowMs: 3_600_000 },
    rentAddressRateLimit: { limit: 2, windowMs: 3_600_000 },
    rateLimit: { limit: 1000, windowMs: 60_000 },
    nonceRateLimit: { limit: 1000, windowMs: 60_000 },
    playRateLimit: { limit: 1000, windowMs: 60_000 },
  }));
});
afterAll(async () => {
  await closeServer();
  await closeDb();
});

describe("renting is limited per wallet and per address", () => {
  it("turns away a third wallet from the same address, though it has rented nothing", async () => {
    expect((await rent("rl-one")).status).toBe(201);
    expect((await rent("rl-two")).status).toBe(201);

    const third = await rent("rl-three");
    expect(third.status).toBe(429);
    expect(String(third.body.error)).toMatch(/from this connection/);
    expect(third.body.retryAfter).toBeGreaterThan(0);

    // And nothing was created for the wallet that was turned away: the limit is
    // charged before an agent, a model call or a transaction happens.
    expect(await db.select().from(agents).where(eq(agents.ownerId, walletOf("rl-three")))).toHaveLength(0);
  });
});
