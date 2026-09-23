import { Keypair, type Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";

/**
 * The small things both settlement clients need. There are two programs while
 * the funding flows run side by side - the seed-funded one that is frozen
 * (src/chain/seed-settlement.ts) and the deposit-funded one the repo builds
 * (src/chain/settlement.ts) - and these are the parts that do not differ
 * between them.
 */

/** Agent and match ids are UUIDs; on chain they are their 16 raw bytes. */
export function uuidBytes(uuid: string): number[] {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return Array.from(Buffer.from(hex, "hex"));
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

/** A transaction built and co-signed by the settler, waiting for the owner's signature. */
export type PreparedWithdrawal = {
  transaction: Transaction;
  /** After this block height the transaction can never land, signed or not. */
  lastValidBlockHeight: number;
};
