import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { connect, migrate, type Db } from "../src/db/client.js";
import { faucetStatus, grantFaucet, FaucetError, type FaucetChain } from "../src/db/faucet.js";
import { faucetGrants, FAUCET_GRANT_CHIPS, FAUCET_INTERVAL_MS } from "../src/db/schema.js";
import { DEVNET_CHIP_RATE } from "../src/chain/settlement.js";
import { DEVNET_GENESIS, MAINNET_GENESIS, NotDevnetError, devnetFaucet } from "../src/chain/faucet.js";

// The devnet faucet: who it pays, how often, and what happens when the payment
// does not land. The chain side is a fake; what it would really do is a plain
// SPL transfer, which the program is not involved in at all.

const RATE = DEVNET_CHIP_RATE;
const GRANT = FAUCET_GRANT_CHIPS * RATE;

class FakeTreasury implements FaucetChain {
  paid: { wallet: string; amount: number }[] = [];
  holding = 1_000_000 * RATE;
  /** Simulates the transfer failing: the RPC is down, or the signature never confirms. */
  broken = false;

  async payOut(wallet: string, amount: number) {
    if (this.broken) throw new Error("fetch failed");
    this.paid.push({ wallet, amount });
    this.holding -= amount;
    return `sig-faucet-${this.paid.length}`;
  }
  async treasuryBalance() {
    return this.holding;
  }
}

async function fresh(): Promise<Db> {
  const { db } = await connect();
  await migrate(db);
  return db;
}

const wallet = () => Keypair.generate().publicKey.toBase58();

describe("the devnet faucet", () => {
  it("hands a wallet its grant and records what was sent", async () => {
    const db = await fresh();
    const chain = new FakeTreasury();
    const who = wallet();

    const before = await faucetStatus(db, who, RATE);
    expect(before.available).toBe(true);
    expect(before.nextAt).toBeNull();
    expect(before.chips).toBe(FAUCET_GRANT_CHIPS);
    expect(before.amount).toBe(GRANT);

    const grant = await grantFaucet(db, chain, who, RATE);
    expect(grant.amount).toBe(GRANT);
    expect(chain.paid).toEqual([{ wallet: who, amount: GRANT }]);

    const [row] = await db.select().from(faucetGrants);
    expect(row!.wallet).toBe(who);
    expect(row!.amount).toBe(GRANT);
    expect(row!.status).toBe("sent");
    expect(row!.signature).toBe(grant.signature);
  });

  it("gives one wallet one grant a day, and says how long is left", async () => {
    const db = await fresh();
    const chain = new FakeTreasury();
    const who = wallet();
    const start = new Date("2026-09-23T12:00:00Z");

    await grantFaucet(db, chain, who, RATE, start);
    // An hour later: refused, with the wait named in hours rather than a bare no.
    const soon = new Date(start.getTime() + 3_600_000);
    await expect(grantFaucet(db, chain, who, RATE, soon)).rejects.toThrow(/already been topped up.*23 hours/);
    expect(chain.paid).toHaveLength(1);

    const status = await faucetStatus(db, who, RATE, soon);
    expect(status.available).toBe(false);
    expect(status.nextAt!.getTime()).toBe(start.getTime() + FAUCET_INTERVAL_MS);

    // Somebody else is unaffected: the wait is per wallet.
    await grantFaucet(db, chain, wallet(), RATE, soon);
    expect(chain.paid).toHaveLength(2);

    // And once the day is out, the same wallet may ask again.
    const later = new Date(start.getTime() + FAUCET_INTERVAL_MS + 1);
    expect((await faucetStatus(db, who, RATE, later)).available).toBe(true);
    await grantFaucet(db, chain, who, RATE, later);
    expect(chain.paid).toHaveLength(3);
  });

  it("does not use up a wallet's turn when the transfer never lands", async () => {
    const db = await fresh();
    const chain = new FakeTreasury();
    const who = wallet();
    chain.broken = true;

    await expect(grantFaucet(db, chain, who, RATE)).rejects.toThrow(/could not send/);
    const [failed] = await db.select().from(faucetGrants);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/fetch failed/);

    // The claim is released, so the wallet can try again at once rather than
    // waiting a day for tokens it never got.
    expect((await faucetStatus(db, who, RATE)).available).toBe(true);
    chain.broken = false;
    const grant = await grantFaucet(db, chain, who, RATE);
    expect(grant.amount).toBe(GRANT);
    expect(chain.paid).toHaveLength(1);
  });

  it("refuses rather than half-paying when the treasury is short", async () => {
    const db = await fresh();
    const chain = new FakeTreasury();
    chain.holding = GRANT - 1;
    await expect(grantFaucet(db, chain, wallet(), RATE)).rejects.toThrow(/faucet is empty/);
    // Nothing was claimed either, so nobody's turn was spent on an empty faucet.
    expect(await db.select().from(faucetGrants)).toHaveLength(0);
  });

  it("is a FaucetError, so the api can answer with the right status", async () => {
    const db = await fresh();
    const chain = new FakeTreasury();
    const who = wallet();
    await grantFaucet(db, chain, who, RATE);
    await expect(grantFaucet(db, chain, who, RATE)).rejects.toBeInstanceOf(FaucetError);
    const error = await grantFaucet(db, chain, who, RATE).catch((e: unknown) => e as FaucetError);
    expect(error.status).toBe(429);
  });

  describe("the cluster gate", () => {
    /** Just enough Connection to answer the one question the gate asks. */
    const onCluster = (genesis: string) => ({ getGenesisHash: async () => genesis }) as unknown as Connection;
    const mint = new PublicKey(Buffer.alloc(32, 3));
    const treasury = Keypair.generate();

    it("refuses mainnet, by the chain's own genesis hash", async () => {
      await expect(devnetFaucet(onCluster(MAINNET_GENESIS), mint, treasury)).rejects.toThrow(NotDevnetError);
      await expect(devnetFaucet(onCluster(MAINNET_GENESIS), mint, treasury)).rejects.toThrow(/devnet only.*mainnet/);
    });

    it("refuses any other cluster too, including a local validator", async () => {
      // A local validator's genesis hash is fresh on every reset, so it can
      // never be allowlisted and is refused like anything else.
      await expect(devnetFaucet(onCluster("3nP1zrYnnBGqwzY1vFYPCsqkyaM5Q6hRjfnk2DcYeCQu"), mint, treasury)).rejects.toThrow(
        NotDevnetError,
      );
    });

    it("builds on devnet", async () => {
      const faucet = await devnetFaucet(onCluster(DEVNET_GENESIS), mint, treasury);
      expect(typeof faucet.payOut).toBe("function");
      expect(typeof faucet.treasuryBalance).toBe("function");
    });
  });
});
