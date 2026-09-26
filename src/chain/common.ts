import { Keypair, type Transaction } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";

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

/**
 * Where the deposit program's settler key lives, on a machine that has one.
 *
 * The deposit program has a settler of its own, and on this deployment it has
 * already been rotated once - so `.keys/settler.json` is the *seed* program's
 * key and pointing the deposit flow at it silently gets NotSettler. The
 * candidates are tried in order and the first that exists wins, so a rotated
 * setup and a fresh clone both land on the right file without either needing
 * an environment variable.
 *
 * `CHAIN_SETTLER_KEYPAIR_V2` still overrides everything.
 */
export const V2_SETTLER_KEYS = [".keys/settler-v2.json", ".keys/settler-new.json", ".keys/settler.json"] as const;

export function v2SettlerKeyPath(): string {
  const named = process.env["CHAIN_SETTLER_KEYPAIR_V2"];
  if (named) return named;
  return V2_SETTLER_KEYS.find((p) => existsSync(p)) ?? V2_SETTLER_KEYS[V2_SETTLER_KEYS.length - 1]!;
}

/** A transaction built and co-signed by the settler, waiting for the owner's signature. */
export type PreparedWithdrawal = {
  transaction: Transaction;
  /** After this block height the transaction can never land, signed or not. */
  lastValidBlockHeight: number;
};
