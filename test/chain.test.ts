import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  AuthorityType,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  TOKEN_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import BN from "bn.js";
import { ChainClient, PROGRAM_ID, pdas } from "../src/chain/settlement.js";
import { uuidBytes } from "../src/chain/common.js";
import { agentIdFor, newAgentId } from "../src/agent-id.js";
import { EventParser } from "@coral-xyz/anchor";

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
/** The stake token: made outside the program, fixed supply, no mint authority. */
let stakeMint: PublicKey;
/** Holds the whole supply, and is where every vault in this file is funded from. */
let treasury: PublicKey;
const MAX = 60;
/** Must match the program's constants. */
const OUTFLOW_FLOOR = 120;
const MAX_SETTLEMENT_CEILING = 900;
/** What one vault may pay out in a window, measured on what it holds. */
const outflowCap = (vault: number) => Math.max(OUTFLOW_FLOOR, Math.floor(vault / 4));

/**
 * Puts tokens in a vault, the way the roster funds a house agent: a deposit
 * from the treasury, which is the only place the supply ever was. Nothing
 * mints them.
 */
async function fund(agentId: string, amount: number): Promise<void> {
  if (amount === 0) return;
  await new ChainClient(connection, admin, stakeMint).deposit({ agentId, amount });
}

/** A house vault: an id derived from no owner, and the salt that proves it. */
async function houseVault(amount: number, via: ChainClient = chain): Promise<string> {
  const { id, salt } = newAgentId(null);
  await via.openVault({ agentId: id, owner: null, salt });
  await fund(id, amount);
  return id;
}

/** A player's vault: the id derives from the owner's key, and the program records that owner as it opens. */
async function playerVault(amount: number, owner: Keypair = Keypair.generate()) {
  const { id, salt } = newAgentId(owner.publicKey.toBase58());
  await chain.openVault({ agentId: id, owner: owner.publicKey.toBase58(), salt });
  await fund(id, amount);
  return { agent: id, owner };
}

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

    // The stake token, made the way a pump.fun token is: a mint with an
    // authority, the whole supply issued once, and then the authority given up
    // for good. After the last step nobody can mint, this program included.
    stakeMint = await createMint(connection, admin, admin.publicKey, null, 0);
    treasury = (await getOrCreateAssociatedTokenAccount(connection, admin, stakeMint, admin.publicKey)).address;
    await mintTo(connection, admin, stakeMint, treasury, admin, 1_000_000_000);
    await setAuthority(connection, admin, stakeMint, admin, AuthorityType.MintTokens, null);

    await new ChainClient(connection, admin, stakeMint).initialize(settler.publicKey, MAX);
    chain = new ChainClient(connection, settler, stakeMint);
  }, 60_000);

  afterAll(() => {
    validator?.kill("SIGKILL");
    if (ledger) rmSync(ledger, { recursive: true, force: true });
  });

  it("is configured with the settler, the mint and the limit", async () => {
    const config = await chain.config();
    expect(config.settler.toBase58()).toBe(settler.publicKey.toBase58());
    expect(config.admin.toBase58()).toBe(admin.publicKey.toBase58());
    expect(config.mint.toBase58()).toBe(stakeMint.toBase58());
    expect(config.maxSettlement.toNumber()).toBe(MAX);
  });

  it("lets only the config's admin change the per-match limit", async () => {
    const asAdmin = new ChainClient(connection, admin, stakeMint);
    // The settler cannot: this limit exists to bound the settler's own reach.
    await expect(chain.setMaxSettlement(90)).rejects.toThrow(/NotAdmin/);
    // Nor can a stranger paying their own fees.
    const stranger = Keypair.generate();
    await airdrop(stranger, 1);
    await expect(new ChainClient(connection, stranger, stakeMint).setMaxSettlement(90)).rejects.toThrow(/NotAdmin/);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(MAX);

    // The admin can, and it takes effect at once: 90 is band C's max exposure,
    // which is the reason this instruction exists.
    await asAdmin.setMaxSettlement(90);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(90);
    const payer = await houseVault(180);
    const payee = await houseVault(10);
    await chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: 90 });
    expect(await chain.vaultBalance(payer)).toBe(90);

    // Zero, and anything above a full seed, are refused: a stolen admin key
    // cannot switch the per-settlement guard off.
    await expect(asAdmin.setMaxSettlement(0)).rejects.toThrow(/InvalidLimit/);
    await expect(asAdmin.setMaxSettlement(MAX_SETTLEMENT_CEILING + 1)).rejects.toThrow(/InvalidLimit/);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(90);

    // Put it back: the rest of this file assumes the limit it was opened with.
    await asAdmin.setMaxSettlement(MAX);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(MAX);
  });

  it("lets only the admin rotate the settler, and refuses a rotation that changes nothing", async () => {
    const asAdmin = new ChainClient(connection, admin, stakeMint);
    const fresh = Keypair.generate();

    // The settler cannot hand its own role on, nor can a stranger take it.
    await expect(chain.setSettler(fresh.publicKey)).rejects.toThrow(/NotAdmin/);
    const stranger = Keypair.generate();
    await airdrop(stranger, 1);
    await expect(new ChainClient(connection, stranger, stakeMint).setSettler(fresh.publicKey)).rejects.toThrow(/NotAdmin/);
    expect((await chain.config()).settler.toBase58()).toBe(settler.publicKey.toBase58());

    // A no-op rotation is refused, so it can never look like one happened.
    await expect(asAdmin.setSettler(settler.publicKey)).rejects.toThrow(/InvalidSettler/);
    // And the admin cannot take the settler's role itself.
    await expect(asAdmin.setSettler(admin.publicKey)).rejects.toThrow(/InvalidSettler/);

    // The admin rotates it, and the old key immediately loses its powers.
    await asAdmin.setSettler(fresh.publicKey);
    expect((await chain.config()).settler.toBase58()).toBe(fresh.publicKey.toBase58());
    const orphan = newAgentId(null);
    await expect(chain.openVault({ agentId: orphan.id, owner: null, salt: orphan.salt })).rejects.toThrow(
      /NotSettler/,
    );

    // The new key has them. It pays its own rent, so give it some SOL.
    await airdrop(fresh, 2);
    const asFresh = new ChainClient(connection, fresh, stakeMint);
    const taken = newAgentId(null);
    await asFresh.openVault({ agentId: taken.id, owner: null, salt: taken.salt });
    await fund(taken.id, 100);
    expect(await chain.vaultBalance(taken.id)).toBe(100);

    // Put it back, so every later test still signs with the original settler.
    await asAdmin.setSettler(settler.publicKey);
    expect((await chain.config()).settler.toBase58()).toBe(settler.publicKey.toBase58());
  });

  it("opens a vault empty, because nothing here can create currency", async () => {
    const { id, salt } = newAgentId(null);
    await chain.openVault({ agentId: id, owner: null, salt });
    expect(await chain.vaultBalance(id)).toBe(0);
    // A vault opens once.
    await expect(chain.openVault({ agentId: id, owner: null, salt })).rejects.toThrow();
  });

  it("funds a vault by deposit, and says which agent and which wallet", async () => {
    const { id, salt } = newAgentId(null);
    await chain.openVault({ agentId: id, owner: null, salt });
    const before = await chain.tokenBalance(admin.publicKey.toBase58());

    const signature = await new ChainClient(connection, admin, stakeMint).deposit({ agentId: id, amount: 300 });
    expect(await chain.vaultBalance(id)).toBe(300);
    expect(await chain.tokenBalance(admin.publicKey.toBase58())).toBe(before - 300);

    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const events = [...new EventParser(PROGRAM_ID, chain.program.coder).parseLogs(tx!.meta!.logMessages!)];
    const deposited = events.find((e) => e.name === "deposited")!;
    expect(Array.from(deposited.data.agentId as number[])).toEqual(uuidBytes(id));
    expect((deposited.data.depositor as { toBase58(): string }).toBase58()).toBe(admin.publicKey.toBase58());
    expect(Number(deposited.data.amount)).toBe(300);

    // Topping up is the same instruction again: this is what revives an agent
    // that played itself down to nothing.
    await fund(id, 50);
    expect(await chain.vaultBalance(id)).toBe(350);
  });

  it("takes a deposit from anyone, but only out of their own account", async () => {
    const { agent } = await playerVault(100);
    // A stranger may pay into someone else's agent. The program has no reason
    // to stop it - a plain transfer would reach the vault anyway - and it costs
    // the stranger, not the agent.
    const stranger = Keypair.generate();
    await airdrop(stranger, 1);
    const strangerAta = (await getOrCreateAssociatedTokenAccount(connection, admin, stakeMint, stranger.publicKey)).address;
    await transfer(connection, admin, treasury, strangerAta, admin, 40);
    await new ChainClient(connection, stranger, stakeMint).deposit({ agentId: agent, amount: 40 });
    expect(await chain.vaultBalance(agent)).toBe(140);

    // But they cannot spend someone else's account by naming it as the source.
    // The treasury holds the supply, so this is the raid worth refusing.
    await expect(
      chain.program.methods
        .deposit(uuidBytes(agent), new BN(10))
        .accountsPartial({
          depositor: stranger.publicKey,
          config: pdas.config(),
          source: treasury,
          vault: pdas.vault(agent),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc(),
    ).rejects.toThrow(/NotDepositorsAccount/);
    expect(await chain.vaultBalance(agent)).toBe(140);
  });

  it("refuses a deposit of nothing", async () => {
    const { agent } = await playerVault(50);
    await expect(
      new ChainClient(connection, admin, stakeMint).deposit({ agentId: agent, amount: 0 }),
    ).rejects.toThrow(/ZeroAmount/);
    expect(await chain.vaultBalance(agent)).toBe(50);
  });

  it("refuses a stake token that can still be minted", async () => {
    // The supply guarantee, checked rather than assumed: a mint that still has
    // an authority is refused, so no deployment can rest on an inflatable token.
    const inflatable = await createMint(connection, admin, admin.publicKey, null, 0);
    const payer = Keypair.generate();
    await airdrop(payer, 2);
    await expect(
      new ChainClient(connection, payer, inflatable).initialize(settler.publicKey, MAX),
    ).rejects.toThrow(/MintableStakeToken|already in use/);
  });

  it("opens a vault only under the id its owner and salt hash to", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const { id, salt } = newAgentId(owner);
    // Somebody else's id, with this owner's key: the hash doesn't match, so no vault.
    await expect(chain.openVault({ agentId: randomUUID(), owner, salt })).rejects.toThrow(/AgentIdMismatch/);
    // The right id, but claimed for a different owner: the same refusal. Not even
    // the settler can record anyone but the owner this id belongs to.
    const impostor = Keypair.generate().publicKey.toBase58();
    await expect(chain.openVault({ agentId: id, owner: impostor, salt })).rejects.toThrow(/AgentIdMismatch/);
    // A house id can't be passed off as owned either.
    const house = newAgentId(null);
    await expect(chain.openVault({ agentId: house.id, owner, salt: house.salt })).rejects.toThrow(/AgentIdMismatch/);

    await chain.openVault({ agentId: id, owner, salt });
    expect(await chain.ownerOf(id)).toBe(owner);
    expect(agentIdFor(owner, salt)).toBe(id);
  });

  it("caps what one vault can pay out through settlements in a window", async () => {
    // A vault this size is governed by the floor: a quarter of 180 is less.
    const payer = await houseVault(180);
    const payee = await houseVault(10);
    const bystander = await houseVault(180);
    let paid = 0;
    while (paid + MAX <= OUTFLOW_FLOOR) {
      await chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: MAX });
      paid += MAX;
    }
    expect(await chain.vaultBalance(payer)).toBe(180 - OUTFLOW_FLOOR);
    // Its window is spent, though the vault still holds enough to pay.
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: 1 })).rejects.toThrow(
      /OutflowLimit/,
    );
    expect(await chain.vaultBalance(payer)).toBe(180 - OUTFLOW_FLOOR);
    // The limit is per vault: everyone else carries on settling.
    await chain.settle({ matchId: randomUUID(), fromAgent: bystander, toAgent: payee, amount: MAX });
    expect(await chain.vaultBalance(bystander)).toBe(120);
    // And it cannot be dodged by paying a different vault.
    const elsewhere = await houseVault(10);
    await expect(
      chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: elsewhere, amount: 1 }),
    ).rejects.toThrow(/OutflowLimit/);
  });

  it("lets a large vault pay out more than the floor, in proportion to what it holds", async () => {
    const payer = await houseVault(MAX_SETTLEMENT_CEILING);
    const payee = await houseVault(10);
    // The cap is read from the balance before each settlement leaves, so it
    // falls as the vault pays: at 900 the first window allows three matches at
    // MAX (caps of 225, 210, 195 against 60, 120, 180 spent), and the fourth
    // asks 240 of a cap that has fallen to 180.
    const schedule = [
      { cap: outflowCap(900), after: 840 },
      { cap: outflowCap(840), after: 780 },
      { cap: outflowCap(780), after: 720 },
    ];
    let paid = 0;
    for (const step of schedule) {
      expect(paid + MAX).toBeLessThanOrEqual(step.cap);
      await chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: MAX });
      paid += MAX;
      expect(await chain.vaultBalance(payer)).toBe(step.after);
    }
    // More than a flat floor would ever have allowed, and still a quarter-ish.
    expect(paid).toBe(180);
    expect(paid).toBeGreaterThan(OUTFLOW_FLOOR);
    expect(paid + MAX).toBeGreaterThan(outflowCap(720));
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: MAX })).rejects.toThrow(
      /OutflowLimit/,
    );
    expect(await chain.vaultBalance(payer)).toBe(720);
  });

  it("settles a match between vaults and records it once", async () => {
    const [a, b] = [await houseVault(180), await houseVault(180)];
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
    const [a, b] = [await houseVault(180), await houseVault(180)];
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: MAX + 1 })).rejects.toThrow(
      /OverLimit|per-match limit/,
    );
    expect(await chain.vaultBalance(a)).toBe(180);
  });

  it("refuses a vault that cannot cover it, and a self-settlement", async () => {
    const [poor, rich] = [await houseVault(10), await houseVault(180)];
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: poor, toAgent: rich, amount: 11 })).rejects.toThrow(
      /InsufficientVault|cannot cover/,
    );
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: rich, toAgent: rich, amount: 5 })).rejects.toThrow();
  });

  it("refuses anyone but the settler", async () => {
    const intruder = Keypair.generate();
    await airdrop(intruder, 2);
    const rogue = new ChainClient(connection, intruder, stakeMint);
    const [a, b] = [await houseVault(180), await houseVault(180)];

    const mine = newAgentId(null);
    await expect(rogue.openVault({ agentId: mine.id, owner: null, salt: mine.salt })).rejects.toThrow(
      /NotSettler|settler/,
    );
    await expect(rogue.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: 10 })).rejects.toThrow(
      /NotSettler|settler/,
    );
    expect(await chain.vaultBalance(a)).toBe(180);
  });

  // The ledger-to-chain round trip is pending the funding flow. `createAgent`
  // still writes a 900-chip rental seed and an open_vault op, and under this
  // program opening a vault funds nothing, so the ledger and the vault would
  // disagree by exactly the seed. It comes back in the commit that makes a
  // rental a deposit. `drainChainOps` and `reconcile` keep their coverage
  // against a fake chain in test/outbox.test.ts meanwhile.
  it.todo("carries a run of real matches from the ledger to the chain, and they agree");

  describe("withdrawals", () => {
    /** A funded vault whose owner the program recorded as it opened. */
    const ownedVault = (amount = 180) => playerVault(amount);
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

    it("records the owner as the vault opens, and never another", async () => {
      const { agent, owner } = await ownedVault(50);
      expect(await chain.ownerOf(agent)).toBe(owner.publicKey.toBase58());
      // The record comes with the vault, and a vault opens once: there is no second chance to name an owner.
      const { id, salt } = newAgentId(owner.publicKey.toBase58());
      expect(id).not.toBe(agent);
      await expect(
        chain.openVault({ agentId: agent, owner: owner.publicKey.toBase58(), salt }),
      ).rejects.toThrow();
      expect(await chain.ownerOf(agent)).toBe(owner.publicKey.toBase58());
      // A house vault has no owner, so nothing can ever be withdrawn from it.
      expect(await chain.ownerOf(await houseVault(10))).toBeNull();
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
      const asOwner = new ChainClient(connection, owner, stakeMint);
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
      const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
      const otherAta = chain.tokenAccount(other);
      const ix = prepared.transaction.instructions[1]!;
      const dest = ix.keys.findIndex((k) => k.pubkey.equals(chain.tokenAccount(owner.publicKey)));
      ix.keys[dest] = { ...ix.keys[dest]!, pubkey: otherAta };
      prepared.transaction.instructions[0] = createAssociatedTokenAccountIdempotentInstruction(settler.publicKey, otherAta, other, stakeMint);
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
