import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { connect, migrate, type Db } from "../src/db/client.js";
import { listen } from "../src/http/server.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { balanceOf } from "../src/db/ledger.js";
import { agents, chainOps, ledger, MIN_STAKE, STARTING_BALANCE, withdrawals } from "../src/db/schema.js";
import { drainChainOps, reconcile, type ChainPort } from "../src/chain/worker.js";
import type { OpenVaultInput, PreparedWithdrawal } from "../src/chain/settlement.js";

// Withdrawals over real HTTP, against a fake chain that builds real Solana
// transactions and applies the program's rules to them. The program's own
// enforcement is tested on a local validator in chain.test.ts.

const FAKE_PROGRAM = new PublicKey(Buffer.alloc(32, 7));

class FakeChain implements ChainPort {
  readonly settler = Keypair.generate();
  vaults = new Map<string, number>();
  owners = new Map<string, string>();
  paid = new Map<string, number>();
  withdrawn = new Set<string>();
  settled = new Set<string>();
  height = 1000;
  /** Simulates the RPC being unreachable. */
  down = false;

  async openVault({ agentId, owner, amount }: OpenVaultInput) {
    this.vaults.set(agentId, amount);
    if (owner) this.owners.set(agentId, owner);
    return `sig-open-${agentId}`;
  }
  async settle(i: { matchId: string; fromAgent: string; toAgent: string; amount: number }) {
    if (this.down) throw new Error("fetch failed");
    this.vaults.set(i.fromAgent, this.vaults.get(i.fromAgent)! - i.amount);
    this.vaults.set(i.toAgent, this.vaults.get(i.toAgent)! + i.amount);
    this.settled.add(i.matchId);
    return `sig-settle-${i.matchId}`;
  }
  async hasVault(agentId: string) {
    return this.vaults.has(agentId);
  }
  async isSettled(matchId: string) {
    return this.settled.has(matchId);
  }
  async vaultBalance(agentId: string) {
    return this.vaults.get(agentId) ?? null;
  }
  async ownerOf(agentId: string) {
    return this.owners.get(agentId) ?? null;
  }
  async prepareWithdrawal(input: { withdrawalId: string; agentId: string; owner: string; amount: number; remaining: number }): Promise<PreparedWithdrawal> {
    const lastValidBlockHeight = this.height + 150;
    const transaction = new Transaction({ feePayer: this.settler.publicKey, blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight }).add(
      new TransactionInstruction({
        programId: FAKE_PROGRAM,
        keys: [
          { pubkey: this.settler.publicKey, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(input.owner), isSigner: true, isWritable: false },
        ],
        data: Buffer.from(JSON.stringify(input)),
      }),
    );
    transaction.partialSign(this.settler);
    return { transaction, lastValidBlockHeight };
  }
  /** The program's rules, applied to the signed transaction. */
  async submitWithdrawal(raw: Uint8Array, lastValidBlockHeight: number) {
    if (this.down) throw new Error("fetch failed");
    const tx = Transaction.from(raw);
    if (!tx.verifySignatures()) throw new Error("Signature verification failed");
    if (this.height > lastValidBlockHeight) throw new Error("block height exceeded");
    const ix = tx.instructions[0]!;
    const w = JSON.parse(ix.data.toString()) as { withdrawalId: string; agentId: string; amount: number; remaining: number };
    if (this.withdrawn.has(w.withdrawalId)) throw new Error("already in use");
    const signer = ix.keys[1]!.pubkey.toBase58();
    if (this.owners.get(w.agentId) !== signer) throw new Error("Error Code: NotOwner");
    const vault = this.vaults.get(w.agentId)!;
    if (vault - w.amount !== w.remaining) throw new Error("Error Code: LedgerMismatch");
    if (w.remaining !== 0 && w.remaining < MIN_STAKE) throw new Error("Error Code: Unplayable");
    this.vaults.set(w.agentId, vault - w.amount);
    this.paid.set(signer, (this.paid.get(signer) ?? 0) + w.amount);
    this.withdrawn.add(w.withdrawalId);
    return `sig-withdraw-${w.withdrawalId}`;
  }
  async isWithdrawn(withdrawalId: string) {
    return this.withdrawn.has(withdrawalId);
  }
  async blockHeightPassed(lastValidBlockHeight: number) {
    return this.height > lastValidBlockHeight;
  }
}

let db: Db;
let closeDb: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;
const chain = new FakeChain();

const seedOf = (label: string) => createHash("sha256").update(label).digest();
const keypairFor = (label: string) => Keypair.fromSeed(seedOf(label));
const walletOf = (label: string) => keypairFor(label).publicKey.toBase58();
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

const api = async (path: string, init: { method?: string; body?: unknown; as: string }) => {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${await tokenFor(init.as)}` },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

/** Prepare, sign as `signer`, submit. */
async function withdraw(agentId: string, as: string, amount: number | "all") {
  const prepared = await api(`/agents/${agentId}/withdrawals`, { method: "POST", body: { amount }, as });
  if (prepared.status !== 201) return { prepared, submitted: null, signed: null };
  const tx = Transaction.from(Buffer.from(prepared.body.withdrawal.transaction, "base64"));
  tx.partialSign(keypairFor(as));
  const signed = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const submitted = await api(`/withdrawals/${prepared.body.withdrawal.withdrawalId}/submit`, {
    method: "POST",
    body: { transaction: signed },
    as,
  });
  return { prepared, submitted, signed };
}

/** An agent owned by `label`, with its vault and owner record landed on chain. */
async function ownedAgent(label: string, name: string) {
  const agent = await createAgent(db, { name, presetName: "Mirage", ownerId: walletOf(label) });
  await drainChainOps(db, chain);
  return agent;
}

const count = async (agentId: string, reason: "withdrawal" | "withdrawal-reversed") =>
  (await db.select().from(ledger).where(and(eq(ledger.agentId, agentId), eq(ledger.reason, reason)))).length;

beforeAll(async () => {
  ({ db, close: closeDb } = await connect());
  await migrate(db);
  // Opponents for the matches below: house agents with vaults.
  for (let i = 0; i < 3; i++) await createAgent(db, { name: `House ${i}`, presetName: "Anchor" });
  await drainChainOps(db, chain);
  ({ url, close: closeServer } = await listen({
    db,
    chain,
    rateLimit: { limit: 1000, windowMs: 60_000 },
    nonceRateLimit: { limit: 1000, windowMs: 60_000 },
    playRateLimit: { limit: 1000, windowMs: 60_000 },
  }));
});
afterAll(async () => {
  await closeServer();
  await closeDb();
});

describe("withdrawals", () => {
  it("pays the owner, and the vault and ledger agree afterwards", async () => {
    const agent = await ownedAgent("alice", "Alice's");
    const state = await api(`/agents/${agent.id}/withdrawable`, { as: "alice" });
    expect(state.body.withdrawable).toMatchObject({ balance: STARTING_BALANCE, withdrawable: STARTING_BALANCE, locked: 0, reason: null });

    const { submitted } = await withdraw(agent.id, "alice", 50);
    expect(submitted!.status).toBe(201);
    expect(submitted!.body.withdrawal.status).toBe("confirmed");
    expect(await balanceOf(db, agent.id)).toBe(STARTING_BALANCE - 50);
    expect(chain.vaults.get(agent.id)).toBe(STARTING_BALANCE - 50);
    expect(chain.paid.get(walletOf("alice"))).toBe(50);
    const check = await reconcile(db, chain);
    expect(check.mismatches).toEqual([]);
    expect(check.checked).toBeGreaterThan(0);
  });

  it("refuses anyone but the owner, at the API", async () => {
    const agent = await ownedAgent("bob", "Bob's");
    expect((await api(`/agents/${agent.id}/withdrawable`, { as: "mallory" })).status).toBe(403);
    const { prepared } = await withdraw(agent.id, "mallory", 20);
    expect(prepared.status).toBe(403);
    expect(await balanceOf(db, agent.id)).toBe(STARTING_BALANCE);
  });

  it("refuses a transaction signed by anyone but the owner, or altered after it was prepared", async () => {
    const agent = await ownedAgent("carol", "Carol's");
    // Prepared for Carol; Mallory puts her own signature in Carol's slot. It doesn't verify.
    const forged = await api(`/agents/${agent.id}/withdrawals`, { method: "POST", body: { amount: 20 }, as: "carol" });
    const ftx = Transaction.from(Buffer.from(forged.body.withdrawal.transaction, "base64"));
    const mallorySig = nacl.sign.detached(ftx.serializeMessage(), keypairFor("mallory").secretKey);
    ftx.addSignature(keypairFor("carol").publicKey, Buffer.from(mallorySig));
    const wrong = await api(`/withdrawals/${forged.body.withdrawal.withdrawalId}/submit`, {
      method: "POST",
      body: { transaction: ftx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") },
      as: "carol",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/fully signed/);

    // Altered: a different amount in the instruction, signed properly by Carol.
    const prepared = await api(`/agents/${agent.id}/withdrawals`, { method: "POST", body: { amount: 20 }, as: "carol" });
    const tx = Transaction.from(Buffer.from(prepared.body.withdrawal.transaction, "base64"));
    const data = JSON.parse(tx.instructions[0]!.data.toString());
    tx.instructions[0]!.data = Buffer.from(JSON.stringify({ ...data, amount: 170, remaining: 10 }));
    tx.signatures = tx.signatures.map((s) => ({ ...s, signature: null }));
    tx.partialSign(keypairFor("carol"));
    const altered = await api(`/withdrawals/${prepared.body.withdrawal.withdrawalId}/submit`, {
      method: "POST",
      body: { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") },
      as: "carol",
    });
    expect(altered.status).toBe(400);
    expect(altered.body.error).toMatch(/isn't the one prepared/);
    expect(await balanceOf(db, agent.id)).toBe(STARTING_BALANCE);
    expect(await count(agent.id, "withdrawal")).toBe(0);
  });

  it("refuses while a match is still settling, and says what's locked", async () => {
    const agent = await ownedAgent("dave", "Dave's");
    chain.down = true;
    try {
      let seed = 1;
      let played = await runMatch(db, agent.id, (await houseAgent()).id, { seed });
      while (played.settled.A === 0) played = await runMatch(db, agent.id, (await houseAgent()).id, { seed: ++seed });
      await drainChainOps(db, chain); // the chain is down: the settlement stays pending
      const state = await api(`/agents/${agent.id}/withdrawable`, { as: "dave" });
      expect(state.body.withdrawable.withdrawable).toBe(0);
      expect(state.body.withdrawable.locked).toBe(Math.abs(played.settled.A));
      expect(state.body.withdrawable.reason).toMatch(/still settling/);
      const { prepared } = await withdraw(agent.id, "dave", 10);
      expect(prepared.status).toBe(409);
    } finally {
      chain.down = false;
    }
    await drainChainOps(db, chain);
    expect((await api(`/agents/${agent.id}/withdrawable`, { as: "dave" })).body.withdrawable.reason).toBeNull();
  });

  it("refuses to leave the vault too low to play", async () => {
    const agent = await ownedAgent("erin", "Erin's");
    const { prepared } = await withdraw(agent.id, "erin", STARTING_BALANCE - (MIN_STAKE - 1));
    expect(prepared.status).toBe(400);
    expect(prepared.body.error).toMatch(/too little to play/);
    const ok = await withdraw(agent.id, "erin", STARTING_BALANCE - MIN_STAKE);
    expect(ok.submitted!.body.withdrawal.status).toBe("confirmed");
    expect(await balanceOf(db, agent.id)).toBe(MIN_STAKE);
  });

  it("taking the lot retires the agent and freezes its record", async () => {
    const agent = await ownedAgent("frank", "Frank's");
    const { submitted, prepared } = await withdraw(agent.id, "frank", "all");
    expect(prepared.body.withdrawal).toMatchObject({ amount: STARTING_BALANCE, remaining: 0, retire: true });
    expect(submitted!.body.withdrawal.status).toBe("confirmed");
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row!.retiredAt).not.toBeNull();
    expect(await balanceOf(db, agent.id)).toBe(0);
    expect(chain.vaults.get(agent.id)).toBe(0);
    // Frozen: it can't play, and it can't withdraw again.
    const play = await api(`/agents/${agent.id}/play`, { method: "POST", as: "frank" });
    expect(play.status).toBe(409);
    expect((await withdraw(agent.id, "frank", 10)).prepared.status).toBe(409);
  });

  it("a replayed submission never pays twice", async () => {
    const agent = await ownedAgent("gina", "Gina's");
    const first = await withdraw(agent.id, "gina", 30);
    expect(first.submitted!.body.withdrawal.status).toBe("confirmed");
    const again = await api(`/withdrawals/${first.prepared.body.withdrawal.withdrawalId}/submit`, {
      method: "POST",
      body: { transaction: first.signed },
      as: "gina",
    });
    expect(again.status).toBe(409);
    // And the chain refuses the same bytes too.
    await expect(chain.submitWithdrawal(Buffer.from(first.signed!, "base64"), chain.height + 100)).rejects.toThrow(/already in use/);
    expect(await count(agent.id, "withdrawal")).toBe(1);
    expect(await balanceOf(db, agent.id)).toBe(STARTING_BALANCE - 30);
    expect(chain.vaults.get(agent.id)).toBe(STARTING_BALANCE - 30);
  });

  it("refuses if the balance moved between preparing and submitting", async () => {
    const agent = await ownedAgent("hank", "Hank's");
    const prepared = await api(`/agents/${agent.id}/withdrawals`, { method: "POST", body: { amount: 40 }, as: "hank" });
    let seed = 50;
    let played = await runMatch(db, agent.id, (await houseAgent()).id, { seed });
    while (played.settled.A === 0) played = await runMatch(db, agent.id, (await houseAgent()).id, { seed: ++seed });
    const tx = Transaction.from(Buffer.from(prepared.body.withdrawal.transaction, "base64"));
    tx.partialSign(keypairFor("hank"));
    const submitted = await api(`/withdrawals/${prepared.body.withdrawal.withdrawalId}/submit`, {
      method: "POST",
      body: { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") },
      as: "hank",
    });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toMatch(/balance changed/);
    expect(await count(agent.id, "withdrawal")).toBe(0);
    await drainChainOps(db, chain);
  });

  it("while a withdrawal is on its way the agent can't play; one that can never land is put back", async () => {
    const agent = await ownedAgent("iris", "Iris's");
    chain.down = true;
    const { submitted } = await withdraw(agent.id, "iris", "all");
    expect(submitted!.body.withdrawal.status).toBe("submitted");
    // Recorded, retired, and holding the agent until it resolves.
    expect(await balanceOf(db, agent.id)).toBe(0);
    const play = await runMatch(db, agent.id, (await houseAgent()).id, { seed: 3 }).then(
      () => "played",
      (e: Error) => e.message,
    );
    expect(play).toMatch(/retired|withdrawal/);

    // The chain never takes it, and its blockhash runs out: the ledger is put back.
    chain.height += 1000;
    chain.down = false;
    await drainChainOps(db, chain);
    const [w] = await db.select().from(withdrawals).where(eq(withdrawals.agentId, agent.id));
    expect(w!.status).toBe("expired");
    expect(await balanceOf(db, agent.id)).toBe(STARTING_BALANCE);
    expect(await count(agent.id, "withdrawal-reversed")).toBe(1);
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row!.retiredAt).toBeNull();
    expect(chain.vaults.get(agent.id)).toBe(STARTING_BALANCE);
    // And the queue carried on: nothing is left pending behind it.
    const pending = await db.select().from(chainOps).where(eq(chainOps.status, "pending"));
    expect(pending).toEqual([]);
    expect((await reconcile(db, chain)).mismatches).toEqual([]);
  });
});

async function houseAgent() {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.name, "House 0")))
    .limit(1);
  return row!;
}
