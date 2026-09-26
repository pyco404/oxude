import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
// From bn.js directly: under plain Node ESM, @coral-xyz/anchor only exposes BN
// on its default export, so a named import works in vitest and fails in tsx.
import BN from "bn.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { uuidBytes, type PreparedWithdrawal } from "./common.js";
import { DEVNET_CHIP_RATE, STAKE_DECIMALS } from "../chips.js";
import idl from "./idl.json" with { type: "json" };
import type { OxudeSettlement } from "./idl-types.js";

/**
 * Client for the deposit-funded settlement program: the one the Rust in
 * `chain/` builds, whose stake token is an ordinary mint made outside it with
 * no mint authority left. Nothing here can create currency; a vault holds only
 * what somebody deposited or what it won from another vault.
 *
 * Everything that signs for the program's own powers signs with the settler
 * key; nothing an agent or a model produces ever reaches a signature. Amounts
 * arrive already validated by the off-chain ledger, in base units, and the
 * program checks their bounds again.
 *
 * The seed-funded program it replaces is frozen beside it
 * (src/chain/seed-settlement.ts) and still settles the agents rented under it.
 */

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

/**
 * Every amount crossing this client is in base units - never chips - so a
 * caller holding chips converts first, at the season's rate. Re-exported from
 * src/chips.ts, which owns the conversion and which the ledger can import
 * without pulling an Anchor client in behind it.
 */
export { STAKE_DECIMALS, DEVNET_CHIP_RATE };

export const pdas = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0],
  vault: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(uuidBytes(agentId))], PROGRAM_ID)[0],
  settlement: (matchId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("settlement"), Buffer.from(uuidBytes(matchId))], PROGRAM_ID)[0],
  owner: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("owner"), Buffer.from(uuidBytes(agentId))], PROGRAM_ID)[0],
  withdrawal: (withdrawalId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("withdrawal"), Buffer.from(uuidBytes(withdrawalId))], PROGRAM_ID)[0],
  outflow: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("outflow"), Buffer.from(uuidBytes(agentId))], PROGRAM_ID)[0],
  rental: (rentalId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("rental"), Buffer.from(uuidBytes(rentalId))], PROGRAM_ID)[0],
  /**
   * An agent's exit. Seeded by the agent alone, so anyone holding an agent id
   * can find it - which is what lets the server explain a shrunken vault
   * without having been told an id it never chose.
   */
  exit: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("exit"), Buffer.from(uuidBytes(agentId))], PROGRAM_ID)[0],
};

/** What opening a vault needs: the id, and the owner and salt it was derived from (src/agent-id.ts). */
export type OpenVaultInput = { agentId: string; owner: string | null; salt: string };

/** The stake token as the config records it. Read once at startup, then held. */
export async function stakeMintOf(connection: Connection): Promise<PublicKey> {
  const config = await new Program<OxudeSettlement>(
    idl as OxudeSettlement,
    new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" }),
  ).account.config.fetch(pdas.config());
  return config.mint;
}

export class ChainClient {
  readonly program: Program<OxudeSettlement>;

  constructor(
    readonly connection: Connection,
    readonly signer: Keypair,
    /** The stake token. External to the program, so it has to be told. */
    readonly mint: PublicKey,
  ) {
    const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
    this.program = new Program<OxudeSettlement>(idl as OxudeSettlement, provider);
  }

  /** The owner's associated token account for the stake token. */
  tokenAccount(owner: string | PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.mint, typeof owner === "string" ? new PublicKey(owner) : owner);
  }

  /**
   * One-time: the config, pointed at the stake token. Signed by the admin,
   * naming the settler. The program refuses a mint that can still be minted.
   */
  async initialize(settler: PublicKey, maxSettlement: number, rent: number, chipRate: number): Promise<string> {
    return this.program.methods
      .initialize(settler, new BN(maxSettlement), new BN(rent), new BN(chipRate))
      .accountsPartial({
        admin: this.signer.publicKey,
        config: pdas.config(),
        mint: this.mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Changes the most a single settlement may move. The signer must be the admin
   * recorded on the config; the settler's key cannot do this. Bounded by the
   * program's MAX_SETTLEMENT_CEILING.
   */
  async setMaxSettlement(maxSettlement: number): Promise<string> {
    return this.program.methods
      .setMaxSettlement(new BN(maxSettlement))
      .accountsPartial({ admin: this.signer.publicKey, config: pdas.config() })
      .rpc();
  }

  /**
   * Sets the season's rate: base units to one chip. The signer must be the
   * admin. The program holds the number to three bounds of its own - half
   * either way, a ceiling on tokens per chip, and six days since the last move
   * - and rescales max_settlement so it still means the same number of chips.
   *
   * Devnet never calls this: the rate is fixed at one chip to one token.
   */
  async setChipRate(chipRate: number): Promise<string> {
    return this.program.methods
      .setChipRate(new BN(chipRate))
      .accountsPartial({ admin: this.signer.publicKey, config: pdas.config() })
      .rpc();
  }

  /**
   * Sets what renting costs, in base units. The signer must be the admin
   * recorded on the config. On mainnet this is called once per season
   * boundary, in the same transaction as the rate it was computed from.
   */
  async setRent(rent: number): Promise<string> {
    return this.program.methods
      .setRent(new BN(rent))
      .accountsPartial({ admin: this.signer.publicKey, config: pdas.config() })
      .rpc();
  }

  /**
   * The instruction that burns a rental's fee out of the renter's own tokens.
   * Built, not sent: it is the first of the three the owner signs at rent time,
   * so the fee and the agent it paid for can never come apart.
   *
   * `amount` must be the price the config carries. A price that moves while the
   * owner is signing makes this fail rather than charging them more.
   */
  async payRentInstruction(input: { rentalId: string; renter: string | PublicKey; amount: number }): Promise<TransactionInstruction> {
    const renter = typeof input.renter === "string" ? new PublicKey(input.renter) : input.renter;
    return this.program.methods
      .payRent(uuidBytes(input.rentalId), new BN(input.amount))
      .accountsPartial({
        renter,
        settler: this.signer.publicKey,
        config: pdas.config(),
        mint: this.mint,
        source: this.tokenAccount(renter),
        rental: pdas.rental(input.rentalId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  /**
   * The whole of renting, as one transaction for the owner to sign: the fee
   * burned, the vault and owner record opened, and the deposit moved in.
   *
   * One transaction because the three cannot be allowed to come apart. A fee
   * burned for a rental that never happened is money taken for nothing; a vault
   * opened without a fee is a free agent. Solana applies a transaction whole or
   * not at all, so there is no half-state to recover from and no ordering to
   * get right - if the owner's balance cannot cover fee plus deposit, all three
   * fail together and nothing was charged.
   *
   * The settler co-signs and pays the account rent, as it does everywhere else
   * here. The owner's signature is the one thing still missing, and giving it
   * is what makes renting prove consent: until now the server created agents
   * for wallets that had signed nothing.
   */
  async prepareRental(input: {
    rentalId: string;
    agentId: string;
    owner: string;
    salt: string;
    /** Base units to burn. Must equal the price the config carries. */
    fee: number;
    /** Base units to move from the owner's wallet into the new vault. */
    deposit: number;
  }): Promise<PreparedWithdrawal> {
    const owner = new PublicKey(input.owner);
    const salt = Array.from(Buffer.from(input.salt, "hex"));
    const source = this.tokenAccount(owner);

    const fee = await this.payRentInstruction({ rentalId: input.rentalId, renter: owner, amount: input.fee });
    const open = await this.program.methods
      .openOwnedVault(uuidBytes(input.agentId), salt, owner)
      .accountsPartial({
        settler: this.signer.publicKey,
        config: pdas.config(),
        mint: this.mint,
        vault: pdas.vault(input.agentId),
        agentOwner: pdas.owner(input.agentId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const fund = await this.depositInstruction({ agentId: input.agentId, depositor: owner, amount: input.deposit });

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: this.signer.publicKey, blockhash, lastValidBlockHeight })
      // The owner may not have an account for the stake token yet if they were
      // sent tokens by some other route; opening it here is idempotent.
      .add(createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, source, owner, this.mint))
      .add(fee, open, fund);
    transaction.partialSign(this.signer);
    return { transaction, lastValidBlockHeight };
  }

  /**
   * A top-up: the deposit instruction alone, for the owner to sign. The settler
   * pays the fee, as it does for every transaction it builds here, so an owner
   * topping up needs stake tokens but no SOL.
   */
  async prepareDeposit(input: { agentId: string; owner: string; amount: number }): Promise<PreparedWithdrawal> {
    const owner = new PublicKey(input.owner);
    const fund = await this.depositInstruction({ agentId: input.agentId, depositor: owner, amount: input.amount });
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: this.signer.publicKey, blockhash, lastValidBlockHeight }).add(fund);
    transaction.partialSign(this.signer);
    return { transaction, lastValidBlockHeight };
  }

  /**
   * Sends a fully signed rental and waits for it. The same bytes twice are
   * harmless: the rental record and the vault can each be created once, so the
   * second attempt is the same transaction and lands or fails as one.
   */
  async submitRental(raw: Uint8Array, lastValidBlockHeight: number): Promise<string> {
    return this.submitWithdrawal(raw, lastValidBlockHeight);
  }

  /** Whether this rental's fee has been paid. Its record exists at most once. */
  async isRentPaid(rentalId: string): Promise<boolean> {
    return (await this.connection.getAccountInfo(pdas.rental(rentalId), "confirmed")) !== null;
  }

  /**
   * Points the config at a new settler key. The signer must be the admin
   * recorded on the config. The program refuses the current settler and the
   * admin's own key, so a rotation is always a real change of hands.
   */
  async setSettler(settler: PublicKey): Promise<string> {
    return this.program.methods
      .setSettler(settler)
      .accountsPartial({ admin: this.signer.publicKey, config: pdas.config() })
      .rpc();
  }

  /**
   * Opens an agent's vault, empty. A player's agent has its owner recorded in
   * the same instruction; the program checks the id is the hash of that owner
   * and the salt. The money follows in a `deposit`.
   */
  async openVault(input: OpenVaultInput): Promise<string> {
    const salt = Array.from(Buffer.from(input.salt, "hex"));
    const accounts = {
      settler: this.signer.publicKey,
      config: pdas.config(),
      mint: this.mint,
      vault: pdas.vault(input.agentId),
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    if (input.owner === null) {
      return this.program.methods.openVault(uuidBytes(input.agentId), salt).accountsPartial(accounts).rpc();
    }
    return this.program.methods
      .openOwnedVault(uuidBytes(input.agentId), salt, new PublicKey(input.owner))
      .accountsPartial({ ...accounts, agentOwner: pdas.owner(input.agentId) })
      .rpc();
  }

  /**
   * The instruction that moves `amount` base units from a wallet into an
   * agent's vault. Built rather than sent, because the depositor is the one who
   * signs it: at rent time it travels with the fee and the vault in one
   * transaction the owner approves, and a top-up is the same instruction alone.
   */
  async depositInstruction(input: { agentId: string; depositor: string | PublicKey; amount: number }): Promise<TransactionInstruction> {
    const depositor = typeof input.depositor === "string" ? new PublicKey(input.depositor) : input.depositor;
    return this.program.methods
      .deposit(uuidBytes(input.agentId), new BN(input.amount))
      .accountsPartial({
        depositor,
        config: pdas.config(),
        source: this.tokenAccount(depositor),
        vault: pdas.vault(input.agentId),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  /**
   * Deposits from this client's own signer. That is the treasury funding a
   * house agent, never a player: a player's deposit is signed in their wallet.
   */
  /**
   * Starts an exit that nobody co-signs.
   *
   * `this.signer` is the **owner** here, not the settler. That is the whole
   * point of these three: build a client around the owner's keypair and every
   * step of an exit is available without this server existing at all.
   */
  async requestExit(input: { agentId: string; amount: number }): Promise<string> {
    return this.program.methods
      .requestExit(uuidBytes(input.agentId), new BN(input.amount))
      .accountsPartial({
        owner: this.signer.publicKey,
        config: pdas.config(),
        agentOwner: pdas.owner(input.agentId),
        vault: pdas.vault(input.agentId),
        exit: pdas.exit(input.agentId),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Claims an exit whose window has passed. Owner-signed, no settler. */
  async claimExit(agentId: string): Promise<string> {
    const destination = this.tokenAccount(this.signer.publicKey);
    return this.program.methods
      .claimExit(uuidBytes(agentId))
      .accountsPartial({
        owner: this.signer.publicKey,
        config: pdas.config(),
        agentOwner: pdas.owner(agentId),
        vault: pdas.vault(agentId),
        destination,
        exit: pdas.exit(agentId),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(
          this.signer.publicKey,
          destination,
          this.signer.publicKey,
          this.mint,
        ),
      ])
      .rpc();
  }

  /** Cancels an unclaimed exit, or clears a claimed one once its record has served. */
  async closeExit(agentId: string): Promise<string> {
    return this.program.methods
      .closeExit(uuidBytes(agentId))
      .accountsPartial({ owner: this.signer.publicKey, exit: pdas.exit(agentId) })
      .rpc();
  }

  /**
   * An agent's exit as the chain has it, or null if there is none.
   *
   * This is the reconciler's evidence: `claimedAmount` on a claimed exit is
   * what turns "this vault holds less than the ledger says" from an alarm into
   * an explanation.
   */
  async exitOf(agentId: string): Promise<{
    amount: number;
    requestedSlot: number;
    unlockSlot: number;
    vaultAtRequest: number;
    claimedSlot: number;
    claimedAmount: number;
  } | null> {
    try {
      const e = await this.program.account.exit.fetch(pdas.exit(agentId));
      return {
        amount: Number(e.amount),
        requestedSlot: Number(e.requestedSlot),
        unlockSlot: Number(e.unlockSlot),
        vaultAtRequest: Number(e.vaultAtRequest),
        claimedSlot: Number(e.claimedSlot),
        claimedAmount: Number(e.claimedAmount),
      };
    } catch {
      return null;
    }
  }

  async deposit(input: { agentId: string; amount: number }): Promise<string> {
    return this.program.methods
      .deposit(uuidBytes(input.agentId), new BN(input.amount))
      .accountsPartial({
        depositor: this.signer.publicKey,
        config: pdas.config(),
        source: this.tokenAccount(this.signer.publicKey),
        vault: pdas.vault(input.agentId),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }): Promise<string> {
    return this.program.methods
      .settle(uuidBytes(input.matchId), uuidBytes(input.fromAgent), uuidBytes(input.toAgent), new BN(input.amount))
      .accountsPartial({
        settler: this.signer.publicKey,
        config: pdas.config(),
        fromVault: pdas.vault(input.fromAgent),
        toVault: pdas.vault(input.toAgent),
        outflow: pdas.outflow(input.fromAgent),
        settlement: pdas.settlement(input.matchId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async vaultBalance(agentId: string): Promise<number | null> {
    try {
      const account = await getAccount(this.connection, pdas.vault(agentId), "confirmed");
      return Number(account.amount);
    } catch {
      return null;
    }
  }

  async hasVault(agentId: string): Promise<boolean> {
    return (await this.connection.getAccountInfo(pdas.vault(agentId), "confirmed")) !== null;
  }

  async isSettled(matchId: string): Promise<boolean> {
    return (await this.connection.getAccountInfo(pdas.settlement(matchId), "confirmed")) !== null;
  }

  /** The transaction that created a match's settlement record: the only one that touches it. */
  async settlementSignature(matchId: string): Promise<string | null> {
    const sigs = await this.connection.getSignaturesForAddress(pdas.settlement(matchId), {}, "confirmed");
    return sigs.filter((s) => s.err === null).at(-1)?.signature ?? null;
  }

  async config() {
    return this.program.account.config.fetch(pdas.config());
  }

  /** The owner recorded on chain for an agent, or null if none has been. */
  async ownerOf(agentId: string): Promise<string | null> {
    const record = await this.program.account.agentOwner.fetchNullable(pdas.owner(agentId), "confirmed");
    return record ? record.owner.toBase58() : null;
  }

  /**
   * Builds a withdrawal: make sure the owner has a token account for the stake
   * token, then withdraw into it. The settler pays and co-signs; the owner's
   * signature is the one thing still missing. `remaining` is the ledger's
   * balance after the withdrawal, which the program checks against the vault.
   */
  async prepareWithdrawal(input: {
    withdrawalId: string;
    agentId: string;
    owner: string;
    amount: number;
    remaining: number;
  }): Promise<PreparedWithdrawal> {
    const owner = new PublicKey(input.owner);
    const destination = this.tokenAccount(owner);
    const withdraw = await this.program.methods
      .withdraw(uuidBytes(input.withdrawalId), uuidBytes(input.agentId), new BN(input.amount), new BN(input.remaining))
      .accountsPartial({
        settler: this.signer.publicKey,
        owner,
        config: pdas.config(),
        agentOwner: pdas.owner(input.agentId),
        vault: pdas.vault(input.agentId),
        destination,
        withdrawal: pdas.withdrawal(input.withdrawalId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: this.signer.publicKey, blockhash, lastValidBlockHeight }).add(
      createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, destination, owner, this.mint),
      withdraw,
    );
    transaction.partialSign(this.signer);
    return { transaction, lastValidBlockHeight };
  }

  /**
   * Sends a fully signed withdrawal and waits for it. Sending the same bytes
   * again is harmless: it is the same transaction, and the withdrawal record
   * means its effect can only happen once.
   */
  async submitWithdrawal(raw: Uint8Array, lastValidBlockHeight: number): Promise<string> {
    const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
    const { recentBlockhash: blockhash } = Transaction.from(raw);
    const result = await this.connection.confirmTransaction(
      { signature, blockhash: blockhash!, lastValidBlockHeight },
      "confirmed",
    );
    if (result.value.err) throw new Error(`withdrawal failed on chain: ${JSON.stringify(result.value.err)}`);
    return signature;
  }

  async isWithdrawn(withdrawalId: string): Promise<boolean> {
    return (await this.connection.getAccountInfo(pdas.withdrawal(withdrawalId), "confirmed")) !== null;
  }

  /** True once no transaction built before now can land any more. */
  async blockHeightPassed(lastValidBlockHeight: number): Promise<boolean> {
    return (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight;
  }

  async tokenBalance(owner: string): Promise<number> {
    try {
      return Number((await getAccount(this.connection, this.tokenAccount(owner), "confirmed")).amount);
    } catch {
      return 0;
    }
  }
}
