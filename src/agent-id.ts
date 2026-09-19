import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/**
 * Agent ids are bound to their owners: the first 16 bytes of
 * sha256(domain || owner key || salt), as a UUID. The settlement program checks
 * the same hash when it opens the vault and records the owner in that
 * instruction, so no key - the server's included - can record anyone else as
 * this agent's owner. A house agent hashes 32 zero bytes in the owner's place.
 * Must match `agent_id_for` in chain/programs/oxude_settlement/src/lib.rs.
 */

const DOMAIN = Buffer.from("oxude-agent-v1");
const HOUSE = Buffer.alloc(32);

function ownerBytes(ownerId: string | null): Buffer {
  if (ownerId === null) return HOUSE;
  let key: PublicKey;
  try {
    key = new PublicKey(ownerId);
  } catch {
    throw new Error(`an agent's owner must be a wallet key, not ${JSON.stringify(ownerId)}`);
  }
  return Buffer.from(key.toBytes());
}

function asUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The id an agent with this owner and salt (32 hex characters) has. */
export function agentIdFor(ownerId: string | null, salt: string): string {
  const hash = createHash("sha256").update(DOMAIN).update(ownerBytes(ownerId)).update(Buffer.from(salt, "hex")).digest();
  return asUuid(hash.subarray(0, 16));
}

/** A fresh id for a new agent, with the salt that proves it belongs to its owner. */
export function newAgentId(ownerId: string | null): { id: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  return { id: agentIdFor(ownerId, salt), salt };
}
