import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "./idl.json" with { type: "json" };
import type { OxudeSettlement } from "./idl-types.js";

/**
 * Client for the settlement program. Everything that signs here signs with the
 * settler key the program was configured with; nothing an agent or a model
 * produces ever reaches a signature. Amounts arrive already validated by the
 * off-chain ledger, and the program checks their bounds again.
 */

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

/** Agent and match ids are UUIDs; on chain they are their 16 raw bytes. */
export function uuidBytes(uuid: string): number[] {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return Array.from(Buffer.from(hex, "hex"));
}

export const pdas = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0],
  mint: () => PublicKey.findProgramAddressSync([Buffer.from("mint")], PROGRAM_ID)[0],
  vault: (agentId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(uuidBytes(agentId))], PROGRAM_ID)[0],
  settlement: (matchId: string) =>
    PublicKey.findProgramAddressSync([Buffer.from("settlement"), Buffer.from(uuidBytes(matchId))], PROGRAM_ID)[0],
};

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export class ChainClient {
  readonly program: Program<OxudeSettlement>;

  constructor(
    readonly connection: Connection,
    readonly signer: Keypair,
  ) {
    const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
    this.program = new Program<OxudeSettlement>(idl as OxudeSettlement, provider);
  }

  /** One-time: config and mint. Signed by the admin, naming the settler. */
  async initialize(settler: PublicKey, maxSettlement: number): Promise<string> {
    return this.program.methods
      .initialize(settler, new BN(maxSettlement))
      .accountsPartial({
        admin: this.signer.publicKey,
        config: pdas.config(),
        mint: pdas.mint(),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async openVault(agentId: string, amount: number): Promise<string> {
    return this.program.methods
      .openVault(uuidBytes(agentId), new BN(amount))
      .accountsPartial({
        settler: this.signer.publicKey,
        config: pdas.config(),
        mint: pdas.mint(),
        vault: pdas.vault(agentId),
        systemProgram: SystemProgram.programId,
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

  async config() {
    return this.program.account.config.fetch(pdas.config());
  }
}
