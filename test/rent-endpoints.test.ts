import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { connect, migrate, type Db } from "../src/db/client.js";
import { listen } from "../src/http/server.js";
import { balanceOf } from "../src/db/ledger.js";
import { baseUnits, DEVNET_CHIP_RATE } from "../src/chips.js";
import type { RentalChain } from "../src/db/rentals.js";
import type { DepositChain } from "../src/db/deposits.js";

// Renting over HTTP on both flows. What matters here is that a caller can tell
// them apart without guessing, and that the deposit flow never hands back an
// agent that looks ready to play before it has been paid for.

const RATE = DEVNET_CHIP_RATE;
const FEE = baseUnits(200, RATE);
const FAKE_PROGRAM = new PublicKey(Buffer.alloc(32, 5));

class FakeChain implements RentalChain, DepositChain {
  readonly settler = Keypair.generate();
  vaults = new Map<string, number>();
  height = 1000;
  async prepareRental(input: { rentalId: string; agentId: string; owner: string; deposit: number }) {
    const transaction = new Transaction({
      feePayer: this.settler.publicKey,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: this.height + 150,
    }).add(
      new TransactionInstruction({
        programId: FAKE_PROGRAM,
        keys: [{ pubkey: new PublicKey(input.owner), isSigner: true, isWritable: true }],
        data: Buffer.from(`${input.agentId}:${input.deposit}`),
      }),
    );
    transaction.partialSign(this.settler);
    return { transaction, lastValidBlockHeight: this.height + 150 };
  }
  async prepareDeposit(input: { agentId: string; owner: string; amount: number }) {
    const transaction = new Transaction({
      feePayer: this.settler.publicKey,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: this.height + 150,
    }).add(
      new TransactionInstruction({
        programId: FAKE_PROGRAM,
        keys: [{ pubkey: new PublicKey(input.owner), isSigner: true, isWritable: true }],
        data: Buffer.from(`top:${input.agentId}:${input.amount}`),
      }),
    );
    transaction.partialSign(this.settler);
    return { transaction, lastValidBlockHeight: this.height + 150 };
  }
  /** Top-ups and withdrawals both go out through this in the real client. */
  async submitWithdrawal(raw: Uint8Array) {
    const tx = Transaction.from(raw);
    const [, agentId, amount] = tx.instructions[0]!.data.toString().split(":");
    this.vaults.set(agentId!, (this.vaults.get(agentId!) ?? 0) + Number(amount));
    return `sig-top-${agentId}`;
  }
  async submitRental(raw: Uint8Array) {
    const tx = Transaction.from(raw);
    const [agentId, deposit] = tx.instructions[0]!.data.toString().split(":");
    this.vaults.set(agentId!, Number(deposit));
    return `sig-${agentId}`;
  }
  async blockHeightPassed(h: number) {
    return this.height > h;
  }
  async vaultBalance(agentId: string) {
    return this.vaults.get(agentId) ?? null;
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
/**
 * Wallets on the deposit flow; everyone else keeps the seed flow. One per test,
 * because a wallet may only hold one agent at a time and every rental here
 * leaves one behind.
 */
const DEPOSITORS = ["dep-tells-apart", "dep-unplayable", "dep-funds", "dep-refuses", "dep-private", "dep-topup", "dep-guard"] as const;
const onDepositFlow = new Set(DEPOSITORS.map(walletOf));

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

beforeAll(async () => {
  ({ db, close: closeDb } = await connect());
  await migrate(db);
  ({ url, close: closeServer } = await listen({
    db,
    deposit: { chain, fee: FEE, chipRate: RATE, allow: (o) => onDepositFlow.has(o) },
    rateLimit: { limit: 1000, windowMs: 60_000 },
    rentRateLimit: { limit: 1000, windowMs: 60_000 },
    rentAddressRateLimit: { limit: 1000, windowMs: 60_000 },
    nonceRateLimit: { limit: 1000, windowMs: 60_000 },
    playRateLimit: { limit: 1000, windowMs: 60_000 },
  }));
});
afterAll(async () => {
  await closeServer();
  await closeDb();
});

describe("renting over HTTP", () => {
  it("says which flow it took, so a caller never has to guess from the shape", async () => {
    const who = DEPOSITORS[0];
    const seeded = await api("/agents", { method: "POST", body: { presetName: "Anchor" }, as: "sam" });
    expect(seeded.status).toBe(201);
    expect(seeded.body.funding).toBe("seed");
    expect(seeded.body.rental).toBeNull();
    // A seed agent can play the moment it is rented.
    expect(seeded.body.agent.canPlay).toBe(true);

    const deposited = await api("/agents", {
      method: "POST",
      body: { presetName: "Hammer", deposit: 2_000 },
      as: who,
    });
    expect(deposited.status).toBe(201);
    expect(deposited.body.funding).toBe("deposit");
    expect(deposited.body.rental).not.toBeNull();
  });

  it("hands back a transaction to sign, and an agent that cannot play yet", async () => {
    const who = DEPOSITORS[1];
    const out = await api("/agents", { method: "POST", body: { presetName: "Mirage", deposit: 1_500 }, as: "erin2" });
    // erin2 is not on the allowlist, so this is the seed flow. Use the depositor.
    expect(out.body.funding).toBe("seed");

    const rented = await api("/agents", { method: "POST", body: { presetName: "Bully", deposit: 1_500 }, as: who });
    const { rental, agent } = rented.body;
    expect(typeof rental.transaction).toBe("string");
    expect(rental.depositChips).toBe(1_500);
    expect(rental.deposit).toBe(baseUnits(1_500, RATE));
    expect(rental.feeChips).toBe(200);
    // The two things the screen has to say plainly.
    expect(rental.playable).toBe(false);
    expect(agent.canPlay).toBe(false);
    // And it has nothing in it until the transaction lands.
    expect(await balanceOf(db, agent.id)).toBe(0);
  });

  it("funds the agent once the owner's signature comes back", async () => {
    const who = DEPOSITORS[2];
    const rented = await api("/agents", { method: "POST", body: { presetName: "Anchor", deposit: 900 }, as: who });
    const { rental, agent } = rented.body;

    const tx = Transaction.from(Buffer.from(rental.transaction, "base64"));
    tx.partialSign(keypairFor(who));
    const sent = await api(`/rentals/${rental.rentalId}/submit`, {
      method: "POST",
      body: { transaction: tx.serialize().toString("base64") },
      as: who,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.rental.status).toBe("confirmed");
    expect(sent.body.rental.playable).toBe(true);
    expect(await balanceOf(db, agent.id)).toBe(baseUnits(900, RATE));

    // And it can be asked about afterwards.
    const looked = await api(`/rentals/${rental.rentalId}`, { as: who });
    expect(looked.body.rental).toMatchObject({ status: "confirmed", playable: true, agentId: agent.id });
  });

  it("refuses a deposit that is missing or not a number", async () => {
    const who = DEPOSITORS[3];
    for (const body of [{ presetName: "Anchor" }, { presetName: "Anchor", deposit: 0 }, { presetName: "Anchor", deposit: "lots" }]) {
      const out = await api("/agents", { method: "POST", body, as: who });
      expect(out.status).toBe(400);
      expect(String(out.body.error)).toMatch(/deposit is required/);
    }
  });

  it("keeps a rental private to its owner", async () => {
    const who = DEPOSITORS[4];
    const rented = await api("/agents", { method: "POST", body: { presetName: "Anchor", deposit: 900 }, as: who });
    const id = rented.body.rental.rentalId;
    expect((await api(`/rentals/${id}`, { as: "mallory" })).status).toBe(404);
    const tx = Transaction.from(Buffer.from(rented.body.rental.transaction, "base64"));
    tx.partialSign(keypairFor(who));
    const stolen = await api(`/rentals/${id}/submit`, {
      method: "POST",
      body: { transaction: tx.serialize().toString("base64") },
      as: "mallory",
    });
    expect(stolen.status).toBe(403);
  });

  describe("topping up", () => {
    /** Rents on the deposit flow and lands it, so there is something to top up. */
    async function funded(who: string, chips: number) {
      const rented = await api("/agents", { method: "POST", body: { presetName: "Anchor", deposit: chips }, as: who });
      const tx = Transaction.from(Buffer.from(rented.body.rental.transaction, "base64"));
      tx.partialSign(keypairFor(who));
      await api(`/rentals/${rented.body.rental.rentalId}/submit`, {
        method: "POST",
        body: { transaction: tx.serialize().toString("base64") },
        as: who,
      });
      return rented.body.agent.id as string;
    }

    it("puts the owner's money in, and the balance says so", async () => {
      const who = "dep-topup";
      const agentId = await funded(who, 900);
      expect(await balanceOf(db, agentId)).toBe(baseUnits(900, RATE));

      const prepared = await api(`/agents/${agentId}/deposits`, { method: "POST", body: { amount: 500 }, as: who });
      expect(prepared.status).toBe(201);
      expect(prepared.body.deposit.chips).toBe(500);

      const tx = Transaction.from(Buffer.from(prepared.body.deposit.transaction, "base64"));
      tx.partialSign(keypairFor(who));
      const sent = await api(`/deposits/${prepared.body.deposit.depositId}/submit`, {
        method: "POST",
        body: { transaction: tx.serialize().toString("base64") },
        as: who,
      });
      expect(sent.body.deposit.status).toBe("confirmed");
      // This is the gap the seed flow could not close: an agent can be given more.
      expect(await balanceOf(db, agentId)).toBe(baseUnits(1_400, RATE));
    });

    it("refuses a top-up for an agent rented before deposits existed", async () => {
      // A seed agent's vault holds the frozen program's mint; there is nowhere
      // to put a deposit denominated in the other one.
      const seeded = await api("/agents", { method: "POST", body: { presetName: "Bully" }, as: "seed-owner" });
      const out = await api(`/agents/${seeded.body.agent.id}/deposits`, { method: "POST", body: { amount: 100 }, as: "seed-owner" });
      expect(out.status).toBe(409);
      expect(String(out.body.error)).toMatch(/rented before deposits/);
    });

    it("refuses anyone but the owner, and an amount of nothing", async () => {
      const who = "dep-guard";
      const agentId = await funded(who, 900);
      expect((await api(`/agents/${agentId}/deposits`, { method: "POST", body: { amount: 100 }, as: "mallory" })).status).toBe(403);
      expect((await api(`/agents/${agentId}/deposits`, { method: "POST", body: { amount: 0 }, as: who })).status).toBe(400);
      expect(await balanceOf(db, agentId)).toBe(baseUnits(900, RATE));
    });
  });


});
