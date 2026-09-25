import { describe, expect, it } from "vitest";
import { Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { connect, migrate, type Db } from "../src/db/client.js";
import { balanceOf } from "../src/db/ledger.js";
import { activeAgentsOf } from "../src/db/runner.js";
import {
  confirmRental,
  expireRental,
  openRental,
  prepareRental,
  submitRental,
  sweepRentals,
  RentalError,
  PREPARED_GRACE_MS,
  type RentalChain,
} from "../src/db/rentals.js";
import { agents, chainOps, rentals } from "../src/db/schema.js";
import { baseUnits, DEVNET_CHIP_RATE } from "../src/chips.js";
import { eq } from "drizzle-orm";
import { someWallet } from "./helpers.js";

// Renting on the deposit flow, against a fake chain. The program's own
// guarantee - that the fee, the vault and the deposit land together or not at
// all - is tested on a validator in chain.test.ts. What is tested here is the
// ledger's side: that an agent nobody paid for never looks like one that was.

const RATE = DEVNET_CHIP_RATE;
const FEE = baseUnits(200, RATE);
const DEPOSIT = baseUnits(2_000, RATE);
const FAKE_PROGRAM = new PublicKey(Buffer.alloc(32, 9));

class FakeChain implements RentalChain {
  readonly settler = Keypair.generate();
  vaults = new Map<string, number>();
  height = 1000;
  /** The send fails, as an unreachable RPC would. */
  sendFails = false;
  /** The send fails but the transaction landed anyway: a lost confirmation. */
  landsAnyway = false;

  async prepareRental(input: { rentalId: string; agentId: string; owner: string; deposit: number }) {
    const transaction = new Transaction({
      feePayer: this.settler.publicKey,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: this.height + 150,
    }).add(
      new TransactionInstruction({
        programId: FAKE_PROGRAM,
        keys: [{ pubkey: new PublicKey(input.owner), isSigner: true, isWritable: true }],
        data: Buffer.from(`${input.rentalId}:${input.agentId}:${input.deposit}`),
      }),
    );
    transaction.partialSign(this.settler);
    return { transaction, lastValidBlockHeight: this.height + 150 };
  }
  async submitRental(raw: Uint8Array) {
    const tx = Transaction.from(raw);
    const [, agentId, deposit] = tx.instructions[0]!.data.toString().split(":");
    if (this.sendFails) {
      if (this.landsAnyway) this.vaults.set(agentId!, Number(deposit));
      throw new Error("fetch failed");
    }
    this.vaults.set(agentId!, Number(deposit));
    return `sig-rent-${agentId}`;
  }
  async blockHeightPassed(h: number) {
    return this.height > h;
  }
  async vaultBalance(agentId: string) {
    return this.vaults.get(agentId) ?? null;
  }
}

async function fresh(): Promise<Db> {
  const { db } = await connect();
  await migrate(db);
  return db;
}

/** Prepares a rental and signs it as the owner would. */
async function rent(db: Db, chain: FakeChain, owner: Keypair) {
  const ownerId = owner.publicKey.toBase58();
  const p = await prepareRental(db, chain, {
    name: "Renter",
    presetName: "Anchor",
    ownerId,
    fee: FEE,
    deposit: DEPOSIT,
  });
  const tx = Transaction.from(Buffer.from(p.transaction, "base64"));
  tx.partialSign(owner);
  return { ...p, ownerId, signedTx: tx.serialize().toString("base64") };
}

describe("renting on the deposit flow", () => {
  it("creates an agent with nothing in it until the transaction lands", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const owner = Keypair.generate();
    const p = await rent(db, chain, owner);

    // The agent is real - its id is what the vault address derives from - but
    // it has no money, no vault record, and nothing the worker should send.
    expect(await balanceOf(db, p.agent.id)).toBe(0);
    expect(await db.select().from(chainOps).where(eq(chainOps.agentId, p.agent.id))).toHaveLength(0);
    const [row] = await db.select().from(agents).where(eq(agents.id, p.agent.id));
    expect(row!.funding).toBe("deposit");
    expect(await openRental(db, p.agent.id)).not.toBeNull();

    // It holds its owner's one-agent slot meanwhile, so nobody rents twice
    // while a transaction is in flight.
    expect(await activeAgentsOf(db, p.ownerId)).toHaveLength(1);
  });

  it("writes the deposit as the opening balance once it lands", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const owner = Keypair.generate();
    const p = await rent(db, chain, owner);

    const out = await submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx });
    expect(out.status).toBe("confirmed");
    expect(await balanceOf(db, p.agent.id)).toBe(DEPOSIT);

    // The vault is recorded as opened, which is what withdrawals and the
    // reconciler look for - already confirmed, because the owner's own
    // transaction did it and there is nothing left to send.
    const [op] = await db.select().from(chainOps).where(eq(chainOps.agentId, p.agent.id));
    expect(op!.kind).toBe("open_vault");
    expect(op!.status).toBe("confirmed");
    expect(op!.owner).toBe(p.ownerId);
    expect(op!.amount).toBe(DEPOSIT);

    // The fee is not a ledger movement: it was burned from the owner's wallet
    // and never entered the vault.
    const [r] = await db.select().from(rentals).where(eq(rentals.id, p.rentalId));
    expect(r!.fee).toBe(FEE);
    expect(await balanceOf(db, p.agent.id)).toBe(DEPOSIT);
  });

  it("confirms once, however many times it is told", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const p = await rent(db, chain, Keypair.generate());
    await submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx });

    await confirmRental(db, p.rentalId, "sig-again");
    await confirmRental(db, p.rentalId, "sig-again");
    expect(await balanceOf(db, p.agent.id)).toBe(DEPOSIT);
    expect(await db.select().from(chainOps).where(eq(chainOps.agentId, p.agent.id))).toHaveLength(1);
  });

  it("refuses a transaction that is not the one prepared, or is unsigned", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const owner = Keypair.generate();
    const p = await rent(db, chain, owner);

    await expect(
      submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.transaction }),
    ).rejects.toThrow(/isn't fully signed/);
    // Somebody else's rental.
    await expect(
      submitRental(db, chain, { rentalId: p.rentalId, ownerId: someWallet(), signedTx: p.signedTx }),
    ).rejects.toThrow(/belongs to someone else/);
    expect(await balanceOf(db, p.agent.id)).toBe(0);
  });

  it("submits once: a second attempt is refused rather than charged twice", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const p = await rent(db, chain, Keypair.generate());
    await submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx });
    await expect(
      submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx }),
    ).rejects.toThrow(/already confirmed/);
    expect(await balanceOf(db, p.agent.id)).toBe(DEPOSIT);
  });

  describe("the sweep", () => {
    it("retires an agent whose transaction can never land, and gives the slot back", async () => {
      const db = await fresh();
      const chain = new FakeChain();
      const owner = Keypair.generate();
      const p = await rent(db, chain, owner);
      chain.sendFails = true;
      const out = await submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx });
      expect(out.status).toBe("submitted");

      // Still in flight: nothing is decided while it could still land.
      expect((await sweepRentals(db, chain)).expired).toHaveLength(0);
      const [still] = await db.select().from(agents).where(eq(agents.id, p.agent.id));
      expect(still!.retiredAt).toBeNull();

      // Past its block height, and no vault on chain: it never landed.
      chain.height += 1_000;
      const swept = await sweepRentals(db, chain);
      expect(swept.expired).toEqual([p.rentalId]);
      const [row] = await db.select().from(agents).where(eq(agents.id, p.agent.id));
      expect(row!.retiredReason).toBe("unpaid");
      // Nothing was reversed because nothing was recorded, and the owner can rent again.
      expect(await balanceOf(db, p.agent.id)).toBe(0);
      expect(await activeAgentsOf(db, p.ownerId)).toHaveLength(0);
    });

    it("finishes a rental that landed while its confirmation was lost", async () => {
      const db = await fresh();
      const chain = new FakeChain();
      const p = await rent(db, chain, Keypair.generate());
      // The send throws, but the transaction landed: the worst case, because
      // guessing it failed would retire an agent the owner had paid for.
      chain.sendFails = true;
      chain.landsAnyway = true;
      await submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx });
      expect(await balanceOf(db, p.agent.id)).toBe(0);

      chain.height += 1_000;
      const swept = await sweepRentals(db, chain);
      expect(swept.confirmed).toEqual([p.rentalId]);
      expect(swept.expired).toHaveLength(0);
      expect(await balanceOf(db, p.agent.id)).toBe(DEPOSIT);
      const [row] = await db.select().from(agents).where(eq(agents.id, p.agent.id));
      expect(row!.retiredAt).toBeNull();
    });

    it("gives an unsigned rental a while before giving up on it", async () => {
      const db = await fresh();
      const chain = new FakeChain();
      const p = await rent(db, chain, Keypair.generate());
      // Prepared and never signed: a slow wallet must not lose the agent.
      expect((await sweepRentals(db, chain)).expired).toHaveLength(0);

      const later = new Date(Date.now() + PREPARED_GRACE_MS + 60_000);
      chain.height += 1_000;
      const swept = await sweepRentals(db, chain, later);
      expect(swept.expired).toEqual([p.rentalId]);
    });
  });

  it("expiring is a no-op once the rental is confirmed", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    const p = await rent(db, chain, Keypair.generate());
    await submitRental(db, chain, { rentalId: p.rentalId, ownerId: p.ownerId, signedTx: p.signedTx });
    await expireRental(db, p.rentalId, "too late");
    const [row] = await db.select().from(agents).where(eq(agents.id, p.agent.id));
    expect(row!.retiredAt).toBeNull();
    expect(await balanceOf(db, p.agent.id)).toBe(DEPOSIT);
  });

  it("refuses a deposit of nothing", async () => {
    const db = await fresh();
    const chain = new FakeChain();
    await expect(
      prepareRental(db, chain, { name: "Nil", presetName: "Bully", ownerId: someWallet(), fee: FEE, deposit: 0 }),
    ).rejects.toBeInstanceOf(RentalError);
  });
});
