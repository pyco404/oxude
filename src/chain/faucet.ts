import { getAccount, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, transfer } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { FaucetChain } from "../db/faucet.js";

/**
 * The chain side of the devnet faucet: a plain SPL transfer out of the
 * treasury. The settlement program is not involved - this is somebody being
 * given tokens, which is exactly what depositing them later is not.
 *
 * **This is where the faucet is kept off mainnet.** The cluster is identified
 * by its genesis hash, which is a fact about the chain the RPC is actually on
 * rather than a name in a variable, so no configuration mistake - a URL edited
 * in a hurry, a variable copied between environments - can put a faucet in
 * front of real money. A faucet on mainnet would be a wallet handing out a
 * fixed-supply token to anyone who asked.
 *
 * Only devnet passes. A local validator has a fresh genesis hash every reset
 * and so is refused too; local testing transfers from the treasury directly,
 * which needs no faucet.
 */

/** Genesis hashes identify a cluster. These are fixed and public. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export class NotDevnetError extends Error {}

/**
 * Builds the faucet, or refuses. Throws NotDevnetError on any cluster but
 * devnet, so a caller that wires it up unconditionally still cannot ship one
 * anywhere else.
 */
export async function devnetFaucet(connection: Connection, mint: PublicKey, treasury: Keypair): Promise<FaucetChain> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    const where = genesis === MAINNET_GENESIS ? "mainnet" : `a cluster with genesis ${genesis}`;
    throw new NotDevnetError(`the faucet runs on devnet only, and this RPC is on ${where}`);
  }
  const from = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  return {
    async payOut(wallet: string, amount: number): Promise<string> {
      const owner = new PublicKey(wallet);
      // The recipient may have no account for this token yet; the treasury pays
      // to open one, as the settler does for a withdrawal.
      const to = await getOrCreateAssociatedTokenAccount(connection, treasury, mint, owner);
      return transfer(connection, treasury, from, to.address, treasury, amount);
    },
    async treasuryBalance(): Promise<number> {
      try {
        return Number((await getAccount(connection, from, "confirmed")).amount);
      } catch {
        return 0;
      }
    },
  };
}
