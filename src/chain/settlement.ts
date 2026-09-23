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
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { uuidBytes, type PreparedWithdrawal } from "./common.js";
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
  async initialize(settler: PublicKey, maxSettlement: number): Promise<string> {
    return this.program.methods
      .initialize(settler, new BN(maxSettlement))
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
