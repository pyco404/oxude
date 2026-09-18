import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authNonces, sessions } from "../db/schema.js";

/**
 * Sign-in with a Solana wallet. The server issues a single-use nonce bound to a
 * public key; the wallet signs a message containing it; the server rebuilds the
 * exact message, verifies the ed25519 signature, burns the nonce and issues a
 * session. The model is nowhere in this: identity is a signature, nothing else.
 */

export const NONCE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {}

/** A base58 string that decodes to exactly 32 bytes. */
export function isPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * The text a wallet is asked to sign. It names the domain, so a signature made
 * for this site cannot be replayed at another that happens to use the same
 * nonce format, and it says plainly that signing costs nothing.
 */
export function signInMessage(input: { domain: string; publicKey: string; nonce: string; issuedAt: string }): string {
  return [
    `${input.domain} wants you to sign in with your Solana account:`,
    input.publicKey,
    "",
    "Sign in to Oxude. This request will not trigger a transaction or cost any fees.",
    "",
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

export async function issueNonce(db: Db, publicKey: string, domain: string, now = new Date()) {
  if (!isPublicKey(publicKey)) throw new AuthError("not a Solana public key");
  const nonce = bs58.encode(randomBytes(16));
  const message = signInMessage({ domain, publicKey, nonce, issuedAt: now.toISOString() });
  await db.insert(authNonces).values({
    nonce,
    publicKey,
    message,
    createdAt: now,
    expiresAt: new Date(now.getTime() + NONCE_TTL_MS),
  });
  return { nonce, message, expiresAt: new Date(now.getTime() + NONCE_TTL_MS) };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Verifies a signed nonce and, only if everything holds, burns the nonce and
 * opens a session. Every failure is the same shape to the caller.
 */
export async function verifySignIn(
  db: Db,
  input: { publicKey: string; nonce: string; signature: string },
  now = new Date(),
): Promise<{ token: string; ownerId: string; expiresAt: Date }> {
  if (!isPublicKey(input.publicKey)) throw new AuthError("not a Solana public key");

  const [row] = await db.select().from(authNonces).where(eq(authNonces.nonce, input.nonce)).limit(1);
  if (!row) throw new AuthError("unknown nonce");
  if (row.publicKey !== input.publicKey) throw new AuthError("nonce was issued to a different key");
  if (row.usedAt !== null) throw new AuthError("nonce already used");
  if (row.expiresAt.getTime() <= now.getTime()) throw new AuthError("nonce expired");

  let signature: Uint8Array;
  try {
    signature = bs58.decode(input.signature);
  } catch {
    throw new AuthError("signature is not base58");
  }
  const ok =
    signature.length === nacl.sign.signatureLength &&
    nacl.sign.detached.verify(new TextEncoder().encode(row.message), signature, bs58.decode(input.publicKey));
  if (!ok) throw new AuthError("signature does not verify");

  // Burn the nonce first, conditionally, so two concurrent verifies of the same
  // signature cannot both open a session.
  const burnt = await db
    .update(authNonces)
    .set({ usedAt: now })
    .where(and(eq(authNonces.nonce, input.nonce), isNull(authNonces.usedAt)))
    .returning({ nonce: authNonces.nonce });
  if (burnt.length === 0) throw new AuthError("nonce already used");

  const token = bs58.encode(randomBytes(32));
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hashToken(token), ownerId: input.publicKey, createdAt: now, expiresAt });
  return { token, ownerId: input.publicKey, expiresAt };
}

/** The wallet behind a session token, or null for a missing, expired or revoked one. */
export async function ownerForToken(db: Db, token: string | null, now = new Date()): Promise<string | null> {
  if (!token) return null;
  const [row] = await db
    .select({ ownerId: sessions.ownerId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  return row?.ownerId ?? null;
}

export async function revokeSession(db: Db, token: string, now = new Date()): Promise<boolean> {
  const done = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
    .returning({ tokenHash: sessions.tokenHash });
  return done.length > 0;
}
