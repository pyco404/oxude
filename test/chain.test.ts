import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import {
  AuthorityType,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  TOKEN_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import BN from "bn.js";
import { ChainClient, DEVNET_CHIP_RATE, PROGRAM_ID, pdas, STAKE_DECIMALS } from "../src/chain/settlement.js";
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
/**
 * What initialize said to the stake tokens it should refuse. Captured in
 * beforeAll rather than asserted in a test of its own, because the config is a
 * singleton PDA: after the first initialize every later one fails on the
 * account already existing, whatever the mint is, which would make the
 * assertions below pass without ever reaching the checks they are about.
 */
let initRefusals: { mintable: string; decimals: string };
/**
 * Every figure in this file is written as chips times CHIP, because that is how
 * the product thinks and how the program's own limits are stated. The chain
 * only ever sees the product: base units, six decimals. On devnet the rate is
 * fixed at one chip to one whole token.
 */
const CHIP = DEVNET_CHIP_RATE;
/** Band C's worst match, which is what max_settlement is set to. */
const MAX = 60 * CHIP;
/** What a rental costs, burned. */
const RENT = 200 * CHIP;
/** Must match the program's constants, converted at the rate. */
const OUTFLOW_FLOOR = 120 * CHIP;
const MAX_SETTLEMENT_CEILING = 900 * CHIP;
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

/** The error a call failed with, as text. Empty if it unexpectedly succeeded. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return String(error);
  }
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
    stakeMint = await createMint(connection, admin, admin.publicKey, null, STAKE_DECIMALS);
    treasury = (await getOrCreateAssociatedTokenAccount(connection, admin, stakeMint, admin.publicKey)).address;
    // A billion tokens, as $OXUDE has: 1e15 base units, well inside a u64 and
    // inside a JavaScript safe integer too.
    await mintTo(connection, admin, stakeMint, treasury, admin, 1_000_000_000 * CHIP);
    await setAuthority(connection, admin, stakeMint, admin, AuthorityType.MintTokens, null);

    // Before the real one, the two the program must turn away.
    const mintable = await createMint(connection, admin, admin.publicKey, null, STAKE_DECIMALS);
    const wrongScale = await createMint(connection, admin, admin.publicKey, null, 0);
    await setAuthority(connection, admin, wrongScale, admin, AuthorityType.MintTokens, null);
    initRefusals = {
      mintable: await refusal(() =>
        new ChainClient(connection, admin, mintable).initialize(settler.publicKey, MAX, RENT, CHIP),
      ),
      decimals: await refusal(() =>
        new ChainClient(connection, admin, wrongScale).initialize(settler.publicKey, MAX, RENT, CHIP),
      ),
    };

    await new ChainClient(connection, admin, stakeMint).initialize(settler.publicKey, MAX, RENT, CHIP);
    chain = new ChainClient(connection, settler, stakeMint);
  }, 60_000);

  afterAll(() => {
    validator?.kill("SIGKILL");
    if (ledger) rmSync(ledger, { recursive: true, force: true });
  });

  it("is configured with the settler, the mint, the limit and the rent", async () => {
    const config = await chain.config();
    expect(config.settler.toBase58()).toBe(settler.publicKey.toBase58());
    expect(config.admin.toBase58()).toBe(admin.publicKey.toBase58());
    expect(config.mint.toBase58()).toBe(stakeMint.toBase58());
    expect(config.maxSettlement.toNumber()).toBe(MAX);
    expect(config.rent.toNumber()).toBe(RENT);
  });

  describe("rent", () => {
    /** A wallet holding tokens out of the treasury, ready to pay for a rental. */
    async function renter(holding: number): Promise<Keypair> {
      const key = Keypair.generate();
      await airdrop(key, 1);
      const ata = (await getOrCreateAssociatedTokenAccount(connection, admin, stakeMint, key.publicKey)).address;
      await transfer(connection, admin, treasury, ata, admin, holding);
      return key;
    }

    /** Builds the fee instruction, adds the renter's signature to the settler's, sends. */
    async function payRent(who: Keypair, rentalId: string, amount = RENT, signAs: Keypair = who) {
      const ix = await chain.payRentInstruction({ rentalId, renter: who.publicKey, amount });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: settler.publicKey, blockhash, lastValidBlockHeight }).add(ix);
      tx.partialSign(settler, signAs);
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      return signature;
    }

    it("burns the fee out of the renter's own tokens, and takes it off the supply", async () => {
      const who = await renter(500 * CHIP);
      const supply = Number((await getMint(connection, stakeMint)).supply);
      const rentalId = randomUUID();

      const signature = await payRent(who, rentalId);
      expect(await chain.tokenBalance(who.publicKey.toBase58())).toBe(300 * CHIP);
      // Burned, not collected: the supply itself falls by the fee.
      expect(Number((await getMint(connection, stakeMint)).supply)).toBe(supply - RENT);
      expect(await chain.isRentPaid(rentalId)).toBe(true);

      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const events = [...new EventParser(PROGRAM_ID, chain.program.coder).parseLogs(tx!.meta!.logMessages!)];
      const paid = events.find((e) => e.name === "rentPaid")!;
      expect(Array.from(paid.data.rentalId as number[])).toEqual(uuidBytes(rentalId));
      expect((paid.data.renter as { toBase58(): string }).toBase58()).toBe(who.publicKey.toBase58());
      expect(Number(paid.data.amount)).toBe(RENT);
    });

    it("charges the price the config carries, and nothing else", async () => {
      const who = await renter(500 * CHIP);
      // Under the price, and over it: both refused. The amount is in the
      // transaction the renter signs, so a price that moved while they were
      // signing fails here instead of quietly costing them more.
      await expect(payRent(who, randomUUID(), RENT - 1)).rejects.toThrow(/WrongRent/);
      await expect(payRent(who, randomUUID(), RENT + 1)).rejects.toThrow(/WrongRent/);
      expect(await chain.tokenBalance(who.publicKey.toBase58())).toBe(500 * CHIP);
    });

    it("pays for a rental once", async () => {
      const who = await renter(500 * CHIP);
      const rentalId = randomUUID();
      await payRent(who, rentalId);
      await expect(payRent(who, rentalId)).rejects.toThrow(/already in use/);
      expect(await chain.tokenBalance(who.publicKey.toBase58())).toBe(300 * CHIP);
    });

    it("needs the renter's own signature and the settler's", async () => {
      const who = await renter(500 * CHIP);
      const stranger = Keypair.generate();
      // Somebody else signing in the renter's place: the burn has no authority.
      await expect(payRent(who, randomUUID(), RENT, stranger)).rejects.toThrow();
      expect(await chain.tokenBalance(who.publicKey.toBase58())).toBe(500 * CHIP);
    });

    it("lets only the admin change the price", async () => {
      const asAdmin = new ChainClient(connection, admin, stakeMint);
      await expect(chain.setRent(RENT * 2)).rejects.toThrow(/NotAdmin/);
      await expect(asAdmin.setRent(0)).rejects.toThrow(/InvalidLimit/);
      expect((await chain.config()).rent.toNumber()).toBe(RENT);

      await asAdmin.setRent(RENT * 2);
      expect((await chain.config()).rent.toNumber()).toBe(RENT * 2);
      // The old price now fails, which is the protection: nobody is charged a
      // price they did not see.
      const who = await renter(500 * CHIP);
      await expect(payRent(who, randomUUID(), RENT)).rejects.toThrow(/WrongRent/);
      await payRent(who, randomUUID(), RENT * 2);
      expect(await chain.tokenBalance(who.publicKey.toBase58())).toBe(100 * CHIP);

      // Put it back: the rest of this file assumes the price it was opened with.
      await asAdmin.setRent(RENT);
      expect((await chain.config()).rent.toNumber()).toBe(RENT);
    });
  });

  it("lets only the config's admin change the per-match limit", async () => {
    const asAdmin = new ChainClient(connection, admin, stakeMint);
    // The settler cannot: this limit exists to bound the settler's own reach.
    await expect(chain.setMaxSettlement(90 * CHIP)).rejects.toThrow(/NotAdmin/);
    // Nor can a stranger paying their own fees.
    const stranger = Keypair.generate();
    await airdrop(stranger, 1);
    await expect(new ChainClient(connection, stranger, stakeMint).setMaxSettlement(90 * CHIP)).rejects.toThrow(/NotAdmin/);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(MAX);

    // The admin can, and it takes effect at once: 90 is band C's max exposure,
    // which is the reason this instruction exists.
    await asAdmin.setMaxSettlement(90 * CHIP);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(90 * CHIP);
    const payer = await houseVault(180 * CHIP);
    const payee = await houseVault(10 * CHIP);
    await chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: 90 * CHIP });
    expect(await chain.vaultBalance(payer)).toBe(90 * CHIP);

    // Zero, and anything above a full seed, are refused: a stolen admin key
    // cannot switch the per-settlement guard off.
    await expect(asAdmin.setMaxSettlement(0)).rejects.toThrow(/InvalidLimit/);
    await expect(asAdmin.setMaxSettlement(MAX_SETTLEMENT_CEILING + 1)).rejects.toThrow(/InvalidLimit/);
    expect((await chain.config()).maxSettlement.toNumber()).toBe(90 * CHIP);

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
    await fund(taken.id, 100 * CHIP);
    expect(await chain.vaultBalance(taken.id)).toBe(100 * CHIP);

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

    const signature = await new ChainClient(connection, admin, stakeMint).deposit({ agentId: id, amount: 300 * CHIP });
    expect(await chain.vaultBalance(id)).toBe(300 * CHIP);
    expect(await chain.tokenBalance(admin.publicKey.toBase58())).toBe(before - 300 * CHIP);

    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const events = [...new EventParser(PROGRAM_ID, chain.program.coder).parseLogs(tx!.meta!.logMessages!)];
    const deposited = events.find((e) => e.name === "deposited")!;
    expect(Array.from(deposited.data.agentId as number[])).toEqual(uuidBytes(id));
    expect((deposited.data.depositor as { toBase58(): string }).toBase58()).toBe(admin.publicKey.toBase58());
    expect(Number(deposited.data.amount)).toBe(300 * CHIP);

    // Topping up is the same instruction again: this is what revives an agent
    // that played itself down to nothing.
    await fund(id, 50 * CHIP);
    expect(await chain.vaultBalance(id)).toBe(350 * CHIP);
  });

  it("takes a deposit from anyone, but only out of their own account", async () => {
    const { agent } = await playerVault(100 * CHIP);
    // A stranger may pay into someone else's agent. The program has no reason
    // to stop it - a plain transfer would reach the vault anyway - and it costs
    // the stranger, not the agent.
    const stranger = Keypair.generate();
    await airdrop(stranger, 1);
    const strangerAta = (await getOrCreateAssociatedTokenAccount(connection, admin, stakeMint, stranger.publicKey)).address;
    await transfer(connection, admin, treasury, strangerAta, admin, 40 * CHIP);
    await new ChainClient(connection, stranger, stakeMint).deposit({ agentId: agent, amount: 40 * CHIP });
    expect(await chain.vaultBalance(agent)).toBe(140 * CHIP);

    // But they cannot spend someone else's account by naming it as the source.
    // The treasury holds the supply, so this is the raid worth refusing.
    await expect(
      chain.program.methods
        .deposit(uuidBytes(agent), new BN(10 * CHIP))
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
    expect(await chain.vaultBalance(agent)).toBe(140 * CHIP);
  });

  it("refuses a deposit of nothing", async () => {
    const { agent } = await playerVault(50 * CHIP);
    await expect(
      new ChainClient(connection, admin, stakeMint).deposit({ agentId: agent, amount: 0 }),
    ).rejects.toThrow(/ZeroAmount/);
    expect(await chain.vaultBalance(agent)).toBe(50 * CHIP);
  });

  it("refuses a stake token that can still be minted, or that is not six decimals", () => {
    // The supply guarantee, checked rather than assumed: a mint that still has
    // an authority is refused, so no deployment can rest on an inflatable token.
    expect(initRefusals.mintable).toMatch(/MintableStakeToken/);
    // And a token of a different scale, where every figure the product quotes
    // would be out by a factor of a thousand.
    expect(initRefusals.decimals).toMatch(/WrongStakeDecimals/);
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
    const payer = await houseVault(180 * CHIP);
    const payee = await houseVault(10 * CHIP);
    const bystander = await houseVault(180 * CHIP);
    let paid = 0;
    while (paid + MAX <= OUTFLOW_FLOOR) {
      await chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: MAX });
      paid += MAX;
    }
    expect(await chain.vaultBalance(payer)).toBe(180 * CHIP - OUTFLOW_FLOOR);
    // Its window is spent, though the vault still holds enough to pay.
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: 1 * CHIP })).rejects.toThrow(
      /OutflowLimit/,
    );
    expect(await chain.vaultBalance(payer)).toBe(180 * CHIP - OUTFLOW_FLOOR);
    // The limit is per vault: everyone else carries on settling.
    await chain.settle({ matchId: randomUUID(), fromAgent: bystander, toAgent: payee, amount: MAX });
    expect(await chain.vaultBalance(bystander)).toBe(120 * CHIP);
    // And it cannot be dodged by paying a different vault.
    const elsewhere = await houseVault(10 * CHIP);
    await expect(
      chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: elsewhere, amount: 1 * CHIP }),
    ).rejects.toThrow(/OutflowLimit/);
  });

  it("lets a large vault pay out more than the floor, in proportion to what it holds", async () => {
    const payer = await houseVault(MAX_SETTLEMENT_CEILING);
    const payee = await houseVault(10 * CHIP);
    // The cap is read from the balance before each settlement leaves, so it
    // falls as the vault pays: at 900 the first window allows three matches at
    // MAX (caps of 225, 210, 195 against 60, 120, 180 spent), and the fourth
    // asks 240 of a cap that has fallen to 180.
    const schedule = [
      { cap: outflowCap(900 * CHIP), after: 840 * CHIP },
      { cap: outflowCap(840 * CHIP), after: 780 * CHIP },
      { cap: outflowCap(780 * CHIP), after: 720 * CHIP },
    ];
    let paid = 0;
    for (const step of schedule) {
      expect(paid + MAX).toBeLessThanOrEqual(step.cap);
      await chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: MAX });
      paid += MAX;
      expect(await chain.vaultBalance(payer)).toBe(step.after);
    }
    // More than a flat floor would ever have allowed, and still a quarter-ish.
    expect(paid).toBe(180 * CHIP);
    expect(paid).toBeGreaterThan(OUTFLOW_FLOOR);
    expect(paid + MAX).toBeGreaterThan(outflowCap(720 * CHIP));
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: payer, toAgent: payee, amount: MAX })).rejects.toThrow(
      /OutflowLimit/,
    );
    expect(await chain.vaultBalance(payer)).toBe(720 * CHIP);
  });

  it("settles a match between vaults and records it once", async () => {
    const [a, b] = [await houseVault(180 * CHIP), await houseVault(180 * CHIP)];
    const match = randomUUID();

    await chain.settle({ matchId: match, fromAgent: a, toAgent: b, amount: 42 * CHIP });
    expect(await chain.vaultBalance(a)).toBe(138 * CHIP);
    expect(await chain.vaultBalance(b)).toBe(222 * CHIP);
    expect(await chain.isSettled(match)).toBe(true);

    const record = await chain.program.account.settlement.fetch(pdas.settlement(match));
    expect(record.amount.toNumber()).toBe(42 * CHIP);

    // The same match cannot move money twice, even with a different amount.
    await expect(chain.settle({ matchId: match, fromAgent: a, toAgent: b, amount: 1 * CHIP })).rejects.toThrow();
    expect(await chain.vaultBalance(a)).toBe(138 * CHIP);
  });

  it("refuses more than the per-match limit, even from the settler", async () => {
    const [a, b] = [await houseVault(180 * CHIP), await houseVault(180 * CHIP)];
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: MAX + 1 })).rejects.toThrow(
      /OverLimit|per-match limit/,
    );
    expect(await chain.vaultBalance(a)).toBe(180 * CHIP);
  });

  it("refuses a vault that cannot cover it, and a self-settlement", async () => {
    const [poor, rich] = [await houseVault(10 * CHIP), await houseVault(180 * CHIP)];
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: poor, toAgent: rich, amount: 11 * CHIP })).rejects.toThrow(
      /InsufficientVault|cannot cover/,
    );
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: rich, toAgent: rich, amount: 5 * CHIP })).rejects.toThrow();
  });

  it("refuses anyone but the settler", async () => {
    const intruder = Keypair.generate();
    await airdrop(intruder, 2);
    const rogue = new ChainClient(connection, intruder, stakeMint);
    const [a, b] = [await houseVault(180 * CHIP), await houseVault(180 * CHIP)];

    const mine = newAgentId(null);
    await expect(rogue.openVault({ agentId: mine.id, owner: null, salt: mine.salt })).rejects.toThrow(
      /NotSettler|settler/,
    );
    await expect(rogue.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: 10 * CHIP })).rejects.toThrow(
      /NotSettler|settler/,
    );
    expect(await chain.vaultBalance(a)).toBe(180 * CHIP);
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
      const { agent, owner } = await ownedVault(50 * CHIP);
      expect(await chain.ownerOf(agent)).toBe(owner.publicKey.toBase58());
      // The record comes with the vault, and a vault opens once: there is no second chance to name an owner.
      const { id, salt } = newAgentId(owner.publicKey.toBase58());
      expect(id).not.toBe(agent);
      await expect(
        chain.openVault({ agentId: agent, owner: owner.publicKey.toBase58(), salt }),
      ).rejects.toThrow();
      expect(await chain.ownerOf(agent)).toBe(owner.publicKey.toBase58());
      // A house vault has no owner, so nothing can ever be withdrawn from it.
      expect(await chain.ownerOf(await houseVault(10 * CHIP))).toBeNull();
    });

    it("pays the owner, leaves the vault where the ledger says, and emits an event", async () => {
      const { agent, owner } = await ownedVault(180 * CHIP);
      const id = randomUUID();
      const { signature } = await withdraw({ agent, owner, amount: 50 * CHIP, remaining: 130 * CHIP, id });
      expect(await chain.vaultBalance(agent)).toBe(130 * CHIP);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(50 * CHIP);

      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const events = [...new EventParser(PROGRAM_ID, chain.program.coder).parseLogs(tx!.meta!.logMessages!)];
      const withdrawn = events.find((e) => e.name === "withdrawn")!;
      expect(withdrawn).toBeDefined();
      expect(Array.from(withdrawn.data.withdrawalId as number[])).toEqual(uuidBytes(id));
      expect((withdrawn.data.owner as { toBase58(): string }).toBase58()).toBe(owner.publicKey.toBase58());
      expect(Number(withdrawn.data.amount)).toBe(50 * CHIP);
      expect(Number(withdrawn.data.remaining)).toBe(130 * CHIP);
    });

    it("refuses anyone but the recorded owner, even with the settler co-signing", async () => {
      const { agent } = await ownedVault(100 * CHIP);
      const thief = Keypair.generate();
      await expect(withdraw({ agent, owner: thief, amount: 40 * CHIP, remaining: 60 * CHIP })).rejects.toThrow(/Error Code: NotOwner\b/);
      expect(await chain.vaultBalance(agent)).toBe(100 * CHIP);
    });

    it("refuses the owner alone: the settler must co-sign", async () => {
      const { agent, owner } = await ownedVault(100 * CHIP);
      await airdrop(owner, 1);
      // The owner builds it themselves, as settler and owner both: the program wants the configured settler.
      const asOwner = new ChainClient(connection, owner, stakeMint);
      await expect(withdraw({ agent, owner, amount: 40 * CHIP, remaining: 60 * CHIP }, owner, asOwner)).rejects.toThrow(/Error Code: NotSettler/);
      expect(await chain.vaultBalance(agent)).toBe(100 * CHIP);
    });

    it("refuses to pay into anyone else's token account", async () => {
      const { agent, owner } = await ownedVault(100 * CHIP);
      const prepared = await chain.prepareWithdrawal({
        withdrawalId: randomUUID(),
        agentId: agent,
        owner: owner.publicKey.toBase58(),
        amount: 40 * CHIP,
        remaining: 60 * CHIP,
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
      expect(await chain.vaultBalance(agent)).toBe(100 * CHIP);
    });

    it("refuses while the vault disagrees with the ledger: a match is still settling", async () => {
      const { agent, owner } = await ownedVault(100 * CHIP);
      // The ledger already took a 20-chip loss the chain hasn't settled yet: it thinks 80 remain after 30 out.
      await expect(withdraw({ agent, owner, amount: 30 * CHIP, remaining: 50 * CHIP })).rejects.toThrow(/Error Code: LedgerMismatch/);
      expect(await chain.vaultBalance(agent)).toBe(100 * CHIP);
    });

    it("refuses to leave a vault that can't play: nothing, or at least the minimum stake", async () => {
      const { agent, owner } = await ownedVault(100 * CHIP);
      await expect(withdraw({ agent, owner, amount: 95 * CHIP, remaining: 5 * CHIP })).rejects.toThrow(/Error Code: Unplayable/);
      expect(await chain.vaultBalance(agent)).toBe(100 * CHIP);
      await withdraw({ agent, owner, amount: 90 * CHIP, remaining: 10 * CHIP });
      expect(await chain.vaultBalance(agent)).toBe(10 * CHIP);
    });

    it("takes the lot on a full withdrawal", async () => {
      const { agent, owner } = await ownedVault(70 * CHIP);
      await withdraw({ agent, owner, amount: 70 * CHIP, remaining: 0 });
      expect(await chain.vaultBalance(agent)).toBe(0);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(70 * CHIP);
    });

    it("never pays twice: not the same bytes again, not the same withdrawal id again", async () => {
      const { agent, owner } = await ownedVault(100 * CHIP);
      const id = randomUUID();
      const { raw } = await withdraw({ agent, owner, amount: 40 * CHIP, remaining: 60 * CHIP, id });
      // The same signed transaction again: the network knows it, and the vault doesn't move.
      await chain.submitWithdrawal(raw, (await connection.getLatestBlockhash()).lastValidBlockHeight).catch(() => undefined);
      expect(await chain.vaultBalance(agent)).toBe(60 * CHIP);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(40 * CHIP);
      // A fresh transaction reusing the withdrawal id: its record already exists.
      await expect(withdraw({ agent, owner, amount: 40 * CHIP, remaining: 20 * CHIP, id })).rejects.toThrow(/already in use/);
      expect(await chain.vaultBalance(agent)).toBe(60 * CHIP);
      expect(await chain.isWithdrawn(id)).toBe(true);
    });
  });

  describe("renting, as one transaction", () => {
    /** Builds the rental, adds the owner's signature to the settler's, sends. */
    async function rent(
      owner: Keypair,
      input: { deposit: number; fee?: number; rentalId?: string; agentId?: string; salt?: string },
    ) {
      const made = newAgentId(owner.publicKey.toBase58());
      const prepared = await chain.prepareRental({
        rentalId: input.rentalId ?? randomUUID(),
        agentId: input.agentId ?? made.id,
        owner: owner.publicKey.toBase58(),
        salt: input.salt ?? made.salt,
        fee: input.fee ?? RENT,
        deposit: input.deposit,
      });
      prepared.transaction.partialSign(owner);
      const signature = await chain.submitRental(prepared.transaction.serialize(), prepared.lastValidBlockHeight);
      return { agent: input.agentId ?? made.id, signature };
    }

    /** A wallet holding tokens, ready to rent. */
    async function walletWith(holding: number): Promise<Keypair> {
      const key = Keypair.generate();
      await airdrop(key, 1);
      const ata = (await getOrCreateAssociatedTokenAccount(connection, admin, stakeMint, key.publicKey)).address;
      await transfer(connection, admin, treasury, ata, admin, holding);
      return key;
    }

    it("burns the fee, opens the vault and moves the deposit, in one go", async () => {
      const owner = await walletWith(3_000 * CHIP);
      const supply = Number((await getMint(connection, stakeMint)).supply);

      const { agent } = await rent(owner, { deposit: 2_000 * CHIP });

      // The deposit is in the vault, the fee has left the supply, and the
      // owner paid exactly the two together.
      expect(await chain.vaultBalance(agent)).toBe(2_000 * CHIP);
      expect(Number((await getMint(connection, stakeMint)).supply)).toBe(supply - RENT);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(3_000 * CHIP - 2_000 * CHIP - RENT);
      // And the owner is recorded, which is what lets them withdraw later.
      expect(await chain.ownerOf(agent)).toBe(owner.publicKey.toBase58());
    });

    it("charges nothing at all when the owner cannot cover the fee and the deposit", async () => {
      // Enough for the deposit alone, or the fee alone, but not both.
      const owner = await walletWith(RENT + 500 * CHIP);
      const before = await chain.tokenBalance(owner.publicKey.toBase58());
      const supply = Number((await getMint(connection, stakeMint)).supply);
      const made = newAgentId(owner.publicKey.toBase58());

      await expect(
        rent(owner, { deposit: 600 * CHIP, agentId: made.id, salt: made.salt }),
      ).rejects.toThrow();

      // This is the whole reason the three travel together: no fee was burned,
      // no vault was opened, and the owner is exactly as they were.
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(before);
      expect(Number((await getMint(connection, stakeMint)).supply)).toBe(supply);
      expect(await chain.vaultBalance(made.id)).toBeNull();
      expect(await chain.ownerOf(made.id)).toBeNull();
    });

    it("refuses without the owner's signature, so renting cannot happen behind their back", async () => {
      const owner = await walletWith(3_000 * CHIP);
      const made = newAgentId(owner.publicKey.toBase58());
      const prepared = await chain.prepareRental({
        rentalId: randomUUID(),
        agentId: made.id,
        owner: owner.publicKey.toBase58(),
        salt: made.salt,
        fee: RENT,
        deposit: 1_000 * CHIP,
      });
      // The settler has signed; nobody else has. The network will not take it.
      await expect(
        chain.submitRental(prepared.transaction.serialize({ requireAllSignatures: false }), prepared.lastValidBlockHeight),
      ).rejects.toThrow();
      expect(await chain.vaultBalance(made.id)).toBeNull();
    });

    it("rents once: the same rental id cannot be charged again", async () => {
      const owner = await walletWith(4_000 * CHIP);
      const rentalId = randomUUID();
      await rent(owner, { deposit: 1_000 * CHIP, rentalId });
      const spent = await chain.tokenBalance(owner.publicKey.toBase58());
      // A second rental reusing the id: its record already exists, so the whole
      // transaction fails - including the fee and the deposit.
      await expect(rent(owner, { deposit: 1_000 * CHIP, rentalId })).rejects.toThrow();
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(spent);
    });

    it("refuses an agent id that is not this owner's", async () => {
      const owner = await walletWith(3_000 * CHIP);
      const before = await chain.tokenBalance(owner.publicKey.toBase58());
      // An id derived from somebody else's key: the program checks the hash, so
      // the vault cannot be opened and the fee is not burned either.
      const notTheirs = newAgentId(Keypair.generate().publicKey.toBase58());
      await expect(
        rent(owner, { deposit: 500 * CHIP, agentId: notTheirs.id, salt: notTheirs.salt }),
      ).rejects.toThrow(/AgentIdMismatch/);
      expect(await chain.tokenBalance(owner.publicKey.toBase58())).toBe(before);
    });
  });

  /**
   * The owner-signed exit: `request_exit`, a window, `claim_exit`.
   *
   * Everything here is signed by the **owner's** keypair and nothing else. A
   * ChainClient built around an owner is the whole of it, which is the
   * property being tested as much as any assertion below: if these pass, a
   * player can do this with an RPC and a wallet and no server at all.
   *
   * What is not here is a claim actually paying out, because the window is
   * 4,500 slots and the fastest a test validator makes slots is about 25 a
   * second - three minutes of wall clock for one test. The payout arithmetic
   * is `exit_payout`, unit-tested in the program; what these cover is that the
   * lock holds, that only the owner passes, and that the record says what the
   * server will need to read.
   */
  describe("exits nobody co-signs", () => {
    it("records the window and needs no settler", async () => {
      const owner = Keypair.generate();
      await airdrop(owner, 1);
      const { agent } = await playerVault(900 * CHIP, owner);
      const asOwner = new ChainClient(connection, owner, stakeMint);

      const before = await connection.getSlot("confirmed");
      await asOwner.requestExit({ agentId: agent, amount: 300 * CHIP });
      const exit = (await asOwner.exitOf(agent))!;

      expect(exit.amount).toBe(300 * CHIP);
      expect(exit.vaultAtRequest).toBe(900 * CHIP);
      expect(exit.claimedSlot).toBe(0);
      expect(exit.claimedAmount).toBe(0);
      // Thirty minutes of slots from when it was asked for.
      expect(exit.unlockSlot - exit.requestedSlot).toBe(4_500);
      expect(exit.requestedSlot).toBeGreaterThanOrEqual(before);
      // Nothing moved: a request is a clock starting, not a payment.
      expect(await asOwner.vaultBalance(agent)).toBe(900 * CHIP);
    });

    it("refuses a claim before its window has passed", async () => {
      const owner = Keypair.generate();
      await airdrop(owner, 1);
      const { agent } = await playerVault(900 * CHIP, owner);
      const asOwner = new ChainClient(connection, owner, stakeMint);
      await asOwner.requestExit({ agentId: agent, amount: 900 * CHIP });

      await expect(asOwner.claimExit(agent)).rejects.toThrow(/ExitLocked/);
      expect(await asOwner.vaultBalance(agent)).toBe(900 * CHIP);
    });

    it("allows one live exit per agent, so a second request cannot reset the clock", async () => {
      const owner = Keypair.generate();
      await airdrop(owner, 1);
      const { agent } = await playerVault(900 * CHIP, owner);
      const asOwner = new ChainClient(connection, owner, stakeMint);
      await asOwner.requestExit({ agentId: agent, amount: 100 * CHIP });
      const first = (await asOwner.exitOf(agent))!;

      // The PDA is seeded by the agent alone, so a second one cannot exist.
      expect(await refusal(() => asOwner.requestExit({ agentId: agent, amount: 900 * CHIP }))).toMatch(
        /already in use|custom program error/i,
      );
      expect((await asOwner.exitOf(agent))!.unlockSlot).toBe(first.unlockSlot);
    });

    it("is the owner's alone: nobody else can start one or claim it", async () => {
      const owner = Keypair.generate();
      const stranger = Keypair.generate();
      await airdrop(owner, 1);
      await airdrop(stranger, 1);
      const { agent } = await playerVault(900 * CHIP, owner);

      const asStranger = new ChainClient(connection, stranger, stakeMint);
      expect(await refusal(() => asStranger.requestExit({ agentId: agent, amount: 900 * CHIP }))).toMatch(/NotOwner/);

      // Nor can the settler, which is the point: this path does not go through us.
      expect(await refusal(() => chain.requestExit({ agentId: agent, amount: 900 * CHIP }))).toMatch(/NotOwner/);
      expect(await asStranger.exitOf(agent)).toBeNull();
    });

    it("cancels an unclaimed exit and gives the rent back", async () => {
      const owner = Keypair.generate();
      await airdrop(owner, 1);
      const { agent } = await playerVault(900 * CHIP, owner);
      const asOwner = new ChainClient(connection, owner, stakeMint);

      await asOwner.requestExit({ agentId: agent, amount: 900 * CHIP });
      const spent = await connection.getBalance(owner.publicKey, "confirmed");
      await asOwner.closeExit(agent);

      expect(await asOwner.exitOf(agent)).toBeNull();
      // The rent came back, less the fee for the closing transaction.
      expect(await connection.getBalance(owner.publicKey, "confirmed")).toBeGreaterThan(spent);
      // And the agent can start again, with a fresh clock.
      await asOwner.requestExit({ agentId: agent, amount: 50 * CHIP });
      expect((await asOwner.exitOf(agent))!.amount).toBe(50 * CHIP);
    });

    it("lets settlements through while an exit waits, which is what the window is for", async () => {
      const owner = Keypair.generate();
      await airdrop(owner, 1);
      const { agent } = await playerVault(900 * CHIP, owner);
      const winner = await houseVault(0);
      const asOwner = new ChainClient(connection, owner, stakeMint);

      await asOwner.requestExit({ agentId: agent, amount: 900 * CHIP });
      // The agent loses a match. The exit is live and does not block it.
      await chain.settle({ matchId: randomUUID(), fromAgent: agent, toAgent: winner, amount: 60 * CHIP });

      expect(await asOwner.vaultBalance(agent)).toBe(840 * CHIP);
      // The request still says 900, and the vault says 840. The gap is the
      // settlement, and exit_payout is what turns it into 840 paid rather than
      // a refusal - which is the whole reason the claim clamps.
      const exit = (await asOwner.exitOf(agent))!;
      expect(exit.amount).toBe(900 * CHIP);
      expect(exit.vaultAtRequest).toBe(900 * CHIP);
      expect(exit.vaultAtRequest - (await asOwner.vaultBalance(agent))!).toBe(60 * CHIP);
    });
  });

  // Note for anything added below: this block moves the chip rate, and
  // max_settlement follows it. A test appended after this one is playing at
  // half the limits the ones above it use.
  describe("the season rate", () => {
    /** Mirrors the program's ceiling on tokens per chip. */
    const MAX_CHIP_RATE = 1_000 * CHIP;

    // Last in the file on purpose. A rate change cannot be undone here: the
    // program makes a rate stand for six days of slots before it moves again,
    // so anything declared after this would run against a different rate.
    it("holds a new rate to a ceiling, a half-either-way band, and an interval", async () => {
      const asAdmin = new ChainClient(connection, admin, stakeMint);
      // The settler cannot move the rate; this is the admin's alone.
      await expect(chain.setChipRate(CHIP)).rejects.toThrow(/NotAdmin/);
      // Nor can it be zero, nor cost more than the ceiling on tokens per chip.
      await expect(asAdmin.setChipRate(0)).rejects.toThrow(/InvalidLimit/);
      await expect(asAdmin.setChipRate(MAX_CHIP_RATE + 1)).rejects.toThrow(/RateCeiling/);
      // Nor move by more than half, either way, in one step.
      await expect(asAdmin.setChipRate(CHIP / 2 - 1)).rejects.toThrow(/RateMoveTooBig/);
      await expect(asAdmin.setChipRate(CHIP * 1.5 + 1)).rejects.toThrow(/RateMoveTooBig/);
      expect((await chain.config()).chipRate.toNumber()).toBe(CHIP);

      // Half as many base units to the chip - the token having doubled - is
      // exactly at the edge, so it is allowed. max_settlement follows the rate,
      // so it still means band C's 60 chips and not half of them.
      await asAdmin.setChipRate(CHIP / 2);
      const after = await chain.config();
      expect(after.chipRate.toNumber()).toBe(CHIP / 2);
      expect(after.maxSettlement.toNumber()).toBe(60 * (CHIP / 2));

      // And now it has to stand: a second move is refused, however small.
      await expect(asAdmin.setChipRate(CHIP / 2)).rejects.toThrow(/RateTooSoon/);
    });
  });
});
