import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { connect, migrate, type Db } from "../src/db/client.js";
import {
  AuthError,
  isPublicKey,
  issueNonce,
  NONCE_TTL_MS,
  ownerForToken,
  revokeSession,
  SESSION_TTL_MS,
  signInMessage,
  verifySignIn,
} from "../src/auth/wallet.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await connect());
  await migrate(db);
});
afterAll(async () => close());

const wallet = () => {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: bs58.encode(kp.publicKey),
    sign: (message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
};

describe("public keys", () => {
  it("accepts 32-byte base58 keys and nothing else", () => {
    expect(isPublicKey(wallet().publicKey)).toBe(true);
    expect(isPublicKey("11111111111111111111111111111111")).toBe(true);
    expect(isPublicKey("not a key")).toBe(false);
    expect(isPublicKey(bs58.encode(new Uint8Array(31)))).toBe(false);
    expect(isPublicKey(42)).toBe(false);
  });
});

describe("nonces", () => {
  it("expire", async () => {
    const w = wallet();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const { nonce, message } = await issueNonce(db, w.publicKey, "oxude.test", issuedAt);
    const late = new Date(issuedAt.getTime() + NONCE_TTL_MS + 1);
    await expect(verifySignIn(db, { publicKey: w.publicKey, nonce, signature: w.sign(message) }, late)).rejects.toThrow(
      /expired/,
    );
  });

  it("bind the domain into what is signed", async () => {
    const w = wallet();
    const { message } = await issueNonce(db, w.publicKey, "oxude.test");
    expect(message.split("\n")[0]).toBe("oxude.test wants you to sign in with your Solana account:");
    const other = signInMessage({ domain: "evil.test", publicKey: w.publicKey, nonce: "n", issuedAt: "t" });
    expect(other).not.toBe(message);
  });

  it("reject malformed signatures without throwing anything but an AuthError", async () => {
    const w = wallet();
    const { nonce } = await issueNonce(db, w.publicKey, "oxude.test");
    await expect(verifySignIn(db, { publicKey: w.publicKey, nonce, signature: "0OIl" })).rejects.toBeInstanceOf(AuthError);
    await expect(verifySignIn(db, { publicKey: w.publicKey, nonce, signature: bs58.encode(new Uint8Array(10)) })).rejects.toThrow(
      /does not verify/,
    );
  });
});

describe("sessions", () => {
  it("resolve to the wallet until they expire or are revoked", async () => {
    const w = wallet();
    const start = new Date();
    const { nonce, message } = await issueNonce(db, w.publicKey, "oxude.test", start);
    const { token } = await verifySignIn(db, { publicKey: w.publicKey, nonce, signature: w.sign(message) }, start);

    expect(await ownerForToken(db, token, start)).toBe(w.publicKey);
    expect(await ownerForToken(db, token, new Date(start.getTime() + SESSION_TTL_MS + 1))).toBeNull();
    expect(await ownerForToken(db, "nobody-issued-this", start)).toBeNull();
    expect(await ownerForToken(db, null)).toBeNull();

    expect(await revokeSession(db, token)).toBe(true);
    expect(await ownerForToken(db, token)).toBeNull();
    expect(await revokeSession(db, token)).toBe(false);
  });

  it("are stored only as hashes", async () => {
    const w = wallet();
    const { nonce, message } = await issueNonce(db, w.publicKey, "oxude.test");
    const { token } = await verifySignIn(db, { publicKey: w.publicKey, nonce, signature: w.sign(message) });
    const rows = (await db.execute("select token_hash from sessions")) as unknown as { rows: { token_hash: string }[] };
    expect(rows.rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });
});
