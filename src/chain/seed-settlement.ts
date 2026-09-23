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
import { loadKeypair, uuidBytes, type PreparedWithdrawal } from "./common.js";
import idl from "./seed-idl.json" with { type: "json" };
import type { OxudeSettlement as SeedSettlement } from "./seed-idl-types.js";

export { loadKeypair, uuidBytes, type PreparedWithdrawal };

/**
 * Client for the **seed-funded** settlement program: the one deployed at
 * `EKJHJ8js...` on devnet, whose mint is a program PDA with 0 decimals that the
 * program itself mints. It is frozen. Its IDL (`seed-idl.json`) is a committed
 * copy that `npm run chain:build` never rewrites, because the Rust in `chain/`
 * is now the deposit-funded program (src/chain/settlement.ts).
 *
 * It stays only so that agents rented under the seed flow keep settling and
 * their owners keep being able to withdraw. Nothing new is rented against it,
 * and it is deleted once no un-retired agent is left on it.
 *
 * Everything that signs here signs with the settler key the program was
 * configured with; nothing an agent or a model produces ever reaches a
 * signature. Amounts arrive already validated by the off-chain ledger, and the
 * program checks their bounds again.
 */

export const SEED_PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export const seedPdas = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from("config")], SEED_PROGRAM_ID)[0],
  mint: () => PublicKey.findProgramAddressSync([Buffer.from("mint")], SEED_PROGRAM_ID)[0],
  vault: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(uuidBytes(agentId))], SEED_PROGRAM_ID)[0],
  settlement: (matchId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("settlement"), Buffer.from(uuidBytes(matchId))], SEED_PROGRAM_ID)[0],
  owner: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("owner"), Buffer.from(uuidBytes(agentId))], SEED_PROGRAM_ID)[0],
  withdrawal: (withdrawalId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("withdrawal"), Buffer.from(uuidBytes(withdrawalId))], SEED_PROGRAM_ID)[0],
  outflow: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("outflow"), Buffer.from(uuidBytes(agentId))], SEED_PROGRAM_ID)[0],
  mintBudget: () => PublicKey.findProgramAddressSync([Buffer.from("mint_budget")], SEED_PROGRAM_ID)[0],
};

/** What opening a vault needs: the id, and the owner and salt it was derived from (src/agent-id.ts). */
export type SeedOpenVaultInput = { agentId: string; owner: string | null; salt: string; amount: number };

export class SeedChainClient {
  readonly program: Program<SeedSettlement>;

  constructor(
    readonly connection: Connection,
    readonly signer: Keypair,
  ) {
    const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
    this.program = new Program<SeedSettlement>(idl as SeedSettlement, provider);
  }

  /** One-time: config and mint. Signed by the admin, naming the settler. */
  async initialize(settler: PublicKey, maxSettlement: number): Promise<string> {
    return this.program.methods
      .initialize(settler, new BN(maxSettlement))
      .accountsPartial({
        admin: this.signer.publicKey,
        config: seedPdas.config(),
        mint: seedPdas.mint(),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Changes the most a single settlement may move. The signer must be the admin
   * recorded on the config; the settler's key cannot do this. Bounded by the
   * program's MAX_SEED.
   */
  async setMaxSettlement(maxSettlement: number): Promise<string> {
    return this.program.methods
      .setMaxSettlement(new BN(maxSettlement))
      .accountsPartial({ admin: this.signer.publicKey, config: seedPdas.config() })
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
      .accountsPartial({ admin: this.signer.publicKey, config: seedPdas.config() })
      .rpc();
  }

  /**
   * Opens an agent's vault with its starting balance. A player's agent has its
   * owner recorded in the same instruction; the program checks the id is the
   * hash of that owner and the salt.
   */
  async openVault(input: SeedOpenVaultInput): Promise<string> {
    const salt = Array.from(Buffer.from(input.salt, "hex"));
    const accounts = {
      settler: this.signer.publicKey,
      config: seedPdas.config(),
      mint: seedPdas.mint(),
      mintBudget: seedPdas.mintBudget(),
      vault: seedPdas.vault(input.agentId),
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    if (input.owner === null) {
      return this.program.methods.openVault(uuidBytes(input.agentId), salt, new BN(input.amount)).accountsPartial(accounts).rpc();
    }
    return this.program.methods
      .openOwnedVault(uuidBytes(input.agentId), salt, new PublicKey(input.owner), new BN(input.amount))
      .accountsPartial({ ...accounts, agentOwner: seedPdas.owner(input.agentId) })
      .rpc();
  }

  async settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }): Promise<string> {
    return this.program.methods
      .settle(uuidBytes(input.matchId), uuidBytes(input.fromAgent), uuidBytes(input.toAgent), new BN(input.amount))
      .accountsPartial({
        settler: this.signer.publicKey,
        config: seedPdas.config(),
        fromVault: seedPdas.vault(input.fromAgent),
        toVault: seedPdas.vault(input.toAgent),
        outflow: seedPdas.outflow(input.fromAgent),
        settlement: seedPdas.settlement(input.matchId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async vaultBalance(agentId: string): Promise<number | null> {
    try {
      const account = await getAccount(this.connection, seedPdas.vault(agentId), "confirmed");
      return Number(account.amount);
    } catch {
      return null;
    }
  }

  async hasVault(agentId: string): Promise<boolean> {
    return (await this.connection.getAccountInfo(seedPdas.vault(agentId), "confirmed")) !== null;
  }

  async isSettled(matchId: string): Promise<boolean> {
    return (await this.connection.getAccountInfo(seedPdas.settlement(matchId), "confirmed")) !== null;
  }

  /** The transaction that created a match's settlement record: the only one that touches it. */
  async settlementSignature(matchId: string): Promise<string | null> {
    const sigs = await this.connection.getSignaturesForAddress(seedPdas.settlement(matchId), {}, "confirmed");
    return sigs.filter((s) => s.err === null).at(-1)?.signature ?? null;
  }

  async config() {
    return this.program.account.config.fetch(seedPdas.config());
  }

  /** The owner recorded on chain for an agent, or null if none has been. */
  async ownerOf(agentId: string): Promise<string | null> {
    const record = await this.program.account.agentOwner.fetchNullable(seedPdas.owner(agentId), "confirmed");
    return record ? record.owner.toBase58() : null;
  }

  /**
   * Builds a withdrawal: make sure the owner has a token account for the game
   * currency, then withdraw into it. The settler pays and co-signs; the owner's
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
    const mint = seedPdas.mint();
    const destination = getAssociatedTokenAddressSync(mint, owner);
    const withdraw = await this.program.methods
      .withdraw(uuidBytes(input.withdrawalId), uuidBytes(input.agentId), new BN(input.amount), new BN(input.remaining))
      .accountsPartial({
        settler: this.signer.publicKey,
        owner,
        config: seedPdas.config(),
        agentOwner: seedPdas.owner(input.agentId),
        vault: seedPdas.vault(input.agentId),
        destination,
        withdrawal: seedPdas.withdrawal(input.withdrawalId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: this.signer.publicKey, blockhash, lastValidBlockHeight }).add(
      createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, destination, owner, mint),
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
    return (await this.connection.getAccountInfo(seedPdas.withdrawal(withdrawalId), "confirmed")) !== null;
  }

  /** True once no transaction built before now can land any more. */
  async blockHeightPassed(lastValidBlockHeight: number): Promise<boolean> {
    return (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight;
  }

  async tokenBalance(owner: string): Promise<number> {
    try {
      const account = await getAccount(this.connection, getAssociatedTokenAddressSync(seedPdas.mint(), new PublicKey(owner)), "confirmed");
      return Number(account.amount);
    } catch {
      return 0;
    }
  }
}
