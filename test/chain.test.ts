import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ChainClient, PROGRAM_ID, pdas, uuidBytes } from "../src/chain/settlement.js";
import { EventParser } from "@coral-xyz/anchor";
import { connect, migrate } from "../src/db/client.js";
import { balanceOf } from "../src/db/ledger.js";
import { createAgent, runMatch } from "../src/db/runner.js";
import { drainChainOps, reconcile } from "../src/chain/worker.js";

// The settlement program on a local validator, loaded at genesis. Needs
// solana-test-validator on PATH and the program built (anchor build in chain/),
// so it runs only when CHAIN=1.
const RUN = process.env["CHAIN"] === "1";
const RPC_PORT = 28899 + Math.floor(Math.random() * 500);

let validator: ChildProcess | undefined;
let ledger: string;
let connection: Connection;
let admin: Keypair;
let settler: Keypair;
let chain: ChainClient;
const MAX = 60;

async function airdrop(to: Keypair, sol: number) {
  const sig = await connection.requestAirdrop(to.publicKey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

describe.skipIf(!RUN)("settlement program", () => {
  beforeAll(async () => {
    ledger = mkdtempSync(join(tmpdir(), "oxude-ledger-"));
    validator = spawn(
      "solana-test-validator",
      [
        "--reset", "--quiet", "--ledger", ledger,
        "--rpc-port", String(RPC_PORT), "--faucet-port", String(RPC_PORT + 1000),
        "--dynamic-port-range", `${RPC_PORT + 2000}-${RPC_PORT + 2100}`,
        "--bpf-program", PROGRAM_ID.toBase58(), "chain/target/deploy/oxude_settlement.so",
      ],
      { stdio: "ignore" },
    );
    connection = new Connection(`http://127.0.0.1:${RPC_PORT}`, "confirmed");
    for (let i = 0; i < 60; i++) {
      try {
        await connection.getVersion();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    admin = Keypair.generate();
    settler = Keypair.generate();
    await airdrop(admin, 5);
    await airdrop(settler, 5);
    await new ChainClient(connection, admin).initialize(settler.publicKey, MAX);
    chain = new ChainClient(connection, settler);
  }, 60_000);

  afterAll(() => {
    validator?.kill("SIGKILL");
    if (ledger) rmSync(ledger, { recursive: true, force: true });
  });

  it("is configured with the settler, the mint and the limit", async () => {
    const config = await chain.config();
    expect(config.settler.toBase58()).toBe(settler.publicKey.toBase58());
    expect(config.admin.toBase58()).toBe(admin.publicKey.toBase58());
    expect(config.mint.toBase58()).toBe(pdas.mint().toBase58());
    expect(config.maxSettlement.toNumber()).toBe(MAX);
  });

  it("opens a vault funded with the starting balance", async () => {
    const agent = randomUUID();
    await chain.openVault(agent, 180);
    expect(await chain.vaultBalance(agent)).toBe(180);
    // A vault opens once.
    await expect(chain.openVault(agent, 180)).rejects.toThrow();
  });

  it("settles a match between vaults and records it once", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await chain.openVault(a, 180);
    await chain.openVault(b, 180);
    const match = randomUUID();

    await chain.settle({ matchId: match, fromAgent: a, toAgent: b, amount: 42 });
    expect(await chain.vaultBalance(a)).toBe(138);
    expect(await chain.vaultBalance(b)).toBe(222);
    expect(await chain.isSettled(match)).toBe(true);

    const record = await chain.program.account.settlement.fetch(pdas.settlement(match));
    expect(record.amount.toNumber()).toBe(42);

    // The same match cannot move money twice, even with a different amount.
    await expect(chain.settle({ matchId: match, fromAgent: a, toAgent: b, amount: 1 })).rejects.toThrow();
    expect(await chain.vaultBalance(a)).toBe(138);
  });

  it("refuses more than the per-match limit, even from the settler", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await chain.openVault(a, 180);
    await chain.openVault(b, 180);
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: MAX + 1 })).rejects.toThrow(
      /OverLimit|per-match limit/,
    );
    expect(await chain.vaultBalance(a)).toBe(180);
  });

  it("refuses a vault that cannot cover it, and a self-settlement", async () => {
    const [poor, rich] = [randomUUID(), randomUUID()];
    await chain.openVault(poor, 10);
    await chain.openVault(rich, 180);
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: poor, toAgent: rich, amount: 11 })).rejects.toThrow(
      /InsufficientVault|cannot cover/,
    );
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: rich, toAgent: rich, amount: 5 })).rejects.toThrow();
  });

  it("refuses anyone but the settler", async () => {
    const intruder = Keypair.generate();
    await airdrop(intruder, 2);
    const rogue = new ChainClient(connection, intruder);
    const [a, b] = [randomUUID(), randomUUID()];
    await chain.openVault(a, 180);
    await chain.openVault(b, 180);

    await expect(rogue.openVault(randomUUID(), 1_000_000)).rejects.toThrow(/NotSettler|settler/);
    await expect(rogue.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: 10 })).rejects.toThrow(
      /NotSettler|settler/,
    );
    expect(await chain.vaultBalance(a)).toBe(180);
  });

  it("carries a run of real matches from the ledger to the chain, and they agree", async () => {
    const { db, close } = await connect();
    await migrate(db);
    const roster = [];
    for (let i = 0; i < 4; i++) roster.push(await createAgent(db, { name: `Chain ${i}`, presetName: i % 2 ? "Bully" : "Mirage" }));
    let played = 0;
    for (let seed = 1; played < 12 && seed < 60; seed++) {
      const [x, y] = [roster[seed % 4]!, roster[(seed + 1 + (seed % 3)) % 4]!];
      if (x.id === y.id) continue;
      try {
        await runMatch(db, x.id, y.id, { seed });
        played++;
      } catch {
        /* retired or unable to cover: sits out */
      }
    }

    const drained = await drainChainOps(db, chain, { limit: 1000 });
    expect(drained.error).toBeNull();
    expect(drained.confirmed).toBeGreaterThan(4);

    const check = await reconcile(db, chain);
    expect(check.checked).toBe(4);
    expect(check.mismatches).toEqual([]);
    for (const a of roster) expect(await chain.vaultBalance(a.id)).toBe(await balanceOf(db, a.id));

    // Draining again finds nothing to do: every op is confirmed.
    const again = await drainChainOps(db, chain);
    expect(again.confirmed + again.alreadyOnChain).toBe(0);
    await close();
  }, 120_000);

  describe("withdrawals", () => {
    /** Registers an owner for a fresh funded vault; returns the agent and owner. */
    async function ownedVault(amount = 180) {
      const agent = randomUUID();
      const owner = Keypair.generate();
      await chain.openVault(agent, amount);
      await chain.registerOwner(agent, owner.publicKey.toBase58());
      return { agent, owner };
    }
    /** Builds with the settler's co-signature, adds the owner's, sends. */
    async function withdraw(
      input: { agent: string; owner: Keypair; amount: number; remaining: number; id?: string },
      signAs: Keypair = input.owner,
      via: ChainClient = chain,
    ) {
      const prepared = await via.prepareWithdrawal({
        withdrawalId: input.id ?? randomUUID(),
        agentId: input.agent,
        owner: input.owner.publicKey.toBase58(),
        amount: input.amount,
        remaining: input.remaining,
      });
      prepared.transaction.partialSign(signAs);
      const raw = prepared.transaction.serialize();
      return { raw, signature: await via.submitWithdrawal(raw, prepared.lastValidBlockHeight) };
    }

    it("records an owner once, and only the settler can", async () => {
      const agent = randomUUID();
      await chain.openVault(agent, 50);
      const intruder = Keypair.generate();
      await airdrop(intruder, 1);
      const asIntruder = new ChainClient(connection, intruder);
      await expect(asIntruder.registerOwner(agent, intruder.publicKey.toBase58())).rejects.toThrow(/Error Code: NotSettler/);
      const owner = Keypair.generate().publicKey.toBase58();
      await chain.registerOwner(agent, owner);
      expect(await chain.ownerOf(agent)).toBe(owner);
      // Never changed afterwards, not even by the settler.
      await expect(chain.registerOwner(agent, Keypair.generate().publicKey.toBase58())).rejects.toThrow();
      expect(await chain.ownerOf(agent)).toBe(owner);
    });

    it("pays the owner, leaves the vault where the ledger says, and emits an event", async () => {
      const { agent, owner } = await ownedVault(180);
      const id = randomUUID();
      const { signature } = await withdraw({ agent, owner, amount: 50, remaining: 130, id });
      expect(await chain.vaultBalance(agent)).toBe(130);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(50);

      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const events = [...new EventParser(PROGRAM_ID, chain.program.coder).parseLogs(tx!.meta!.logMessages!)];
      const withdrawn = events.find((e) => e.name === "withdrawn")!;
      expect(withdrawn).toBeDefined();
      expect(Array.from(withdrawn.data.withdrawalId as number[])).toEqual(uuidBytes(id));
      expect((withdrawn.data.owner as { toBase58(): string }).toBase58()).toBe(owner.publicKey.toBase58());
      expect(Number(withdrawn.data.amount)).toBe(50);
      expect(Number(withdrawn.data.remaining)).toBe(130);
    });

    it("refuses anyone but the recorded owner, even with the settler co-signing", async () => {
      const { agent } = await ownedVault(100);
      const thief = Keypair.generate();
      await expect(withdraw({ agent, owner: thief, amount: 40, remaining: 60 })).rejects.toThrow(/Error Code: NotOwner\b/);
      expect(await chain.vaultBalance(agent)).toBe(100);
    });

    it("refuses the owner alone: the settler must co-sign", async () => {
      const { agent, owner } = await ownedVault(100);
      await airdrop(owner, 1);
      // The owner builds it themselves, as settler and owner both: the program wants the configured settler.
      const asOwner = new ChainClient(connection, owner);
      await expect(withdraw({ agent, owner, amount: 40, remaining: 60 }, owner, asOwner)).rejects.toThrow(/Error Code: NotSettler/);
      expect(await chain.vaultBalance(agent)).toBe(100);
    });

    it("refuses to pay into anyone else's token account", async () => {
      const { agent, owner } = await ownedVault(100);
      const prepared = await chain.prepareWithdrawal({
        withdrawalId: randomUUID(),
        agentId: agent,
        owner: owner.publicKey.toBase58(),
        amount: 40,
        remaining: 60,
      });
      // Swap the destination for another wallet's account, then sign it all again.
      const other = Keypair.generate().publicKey;
      const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
      const otherAta = getAssociatedTokenAddressSync(pdas.mint(), other);
      const ix = prepared.transaction.instructions[1]!;
      const dest = ix.keys.findIndex((k) => k.pubkey.equals(getAssociatedTokenAddressSync(pdas.mint(), owner.publicKey)));
      ix.keys[dest] = { ...ix.keys[dest]!, pubkey: otherAta };
      prepared.transaction.instructions[0] = createAssociatedTokenAccountIdempotentInstruction(settler.publicKey, otherAta, other, pdas.mint());
      prepared.transaction.signatures = prepared.transaction.signatures.map((s) => ({ ...s, signature: null }));
      prepared.transaction.partialSign(settler, owner);
      await expect(chain.submitWithdrawal(prepared.transaction.serialize(), prepared.lastValidBlockHeight)).rejects.toThrow(/Error Code: NotOwnersAccount/);
      expect(await chain.vaultBalance(agent)).toBe(100);
    });

    it("refuses while the vault disagrees with the ledger: a match is still settling", async () => {
      const { agent, owner } = await ownedVault(100);
      // The ledger already took a 20-chip loss the chain hasn't settled yet: it thinks 80 remain after 30 out.
      await expect(withdraw({ agent, owner, amount: 30, remaining: 50 })).rejects.toThrow(/Error Code: LedgerMismatch/);
      expect(await chain.vaultBalance(agent)).toBe(100);
    });

    it("refuses to leave a vault that can't play: nothing, or at least the minimum stake", async () => {
      const { agent, owner } = await ownedVault(100);
      await expect(withdraw({ agent, owner, amount: 95, remaining: 5 })).rejects.toThrow(/Error Code: Unplayable/);
      expect(await chain.vaultBalance(agent)).toBe(100);
      await withdraw({ agent, owner, amount: 90, remaining: 10 });
      expect(await chain.vaultBalance(agent)).toBe(10);
    });

    it("takes the lot on a full withdrawal", async () => {
      const { agent, owner } = await ownedVault(70);
      await withdraw({ agent, owner, amount: 70, remaining: 0 });
      expect(await chain.vaultBalance(agent)).toBe(0);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(70);
    });

    it("never pays twice: not the same bytes again, not the same withdrawal id again", async () => {
      const { agent, owner } = await ownedVault(100);
      const id = randomUUID();
      const { raw } = await withdraw({ agent, owner, amount: 40, remaining: 60, id });
      // The same signed transaction again: the network knows it, and the vault doesn't move.
      await chain.submitWithdrawal(raw, (await connection.getLatestBlockhash()).lastValidBlockHeight).catch(() => undefined);
      expect(await chain.vaultBalance(agent)).toBe(60);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(40);
      // A fresh transaction reusing the withdrawal id: its record already exists.
      await expect(withdraw({ agent, owner, amount: 40, remaining: 20, id })).rejects.toThrow(/already in use/);
      expect(await chain.vaultBalance(agent)).toBe(60);
      expect(await chain.isWithdrawn(id)).toBe(true);
    });
  });
});
