/**
 * Everything needed to leave Oxude, owing nothing to Oxude.
 *
 * No npm, no CDN, no build step. This file imports nothing, because the whole
 * point of it is to work on a day when our servers, our domain and our
 * deploys are all gone. Save it next to index.html and open it; the only
 * things it needs are a Solana RPC and a wallet extension.
 *
 * That is also why the Solana primitives below are written out rather than
 * pulled from @solana/web3.js: a dependency is a thing that can be missing.
 * Each one is checked against the real library in
 * test/standalone-exit.test.ts, so this is duplication that is held to the
 * original rather than left to drift.
 */

export const PROGRAM_ID = "HTs42VFpHS4XT9Cr8xH7cJEMgqPL9uuzZn6QHGwtvkdy";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Anchor discriminators, from the built IDL. Constants so no hashing is needed to send. */
export const DISCRIMINATORS = {
  request_exit: [121, 186, 203, 74, 138, 218, 135, 151],
  claim_exit: [109, 115, 53, 37, 198, 221, 203, 41],
  close_exit: [239, 55, 234, 254, 49, 69, 52, 60],
};

// ---------------------------------------------------------------- base58

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  const b = Array.from(bytes);
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // All-zero input is all leading "1"s and no digits: the number itself is
  // zero, and emitting a digit for it would add a thirty-third character to a
  // thirty-two byte key.
  if (digits.length === 1 && digits[0] === 0) digits.length = 0;
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function base58Decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    const value = ALPHABET.indexOf(str[i]);
    if (value < 0) throw new Error(`not base58: ${str}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // The mirror of the encode case, and the one that matters most here: the
  // System Program's id is "1" thirty-two times, so an extra byte would make
  // every transaction that touches it a byte too long.
  if (bytes.length === 1 && bytes[0] === 0) bytes.length = 0;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---------------------------------------------------------------- ed25519

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modpow(base, exp, mod) {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * Whether these 32 bytes are a point on ed25519 - which is exactly the
 * question "could this address have a private key?".
 *
 * A program-derived address is one that is *not*, which is what lets a program
 * sign for it. `findProgramAddress` walks the bump down until it finds one, so
 * this is the only non-obvious piece of arithmetic here.
 */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  // x² = (y² - 1) / (d·y² + 1)
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  if (v === 0n) return false;
  let x = (u * modpow(v, P - 2n, P)) % P;
  x = modpow(x, (P + 3n) / 8n, P);
  if ((v * x * x - u) % P !== 0n) {
    // Multiply by sqrt(-1) and try again, as decompression does.
    const i = modpow(2n, (P - 1n) / 4n, P);
    x = (x * i) % P;
    if ((v * x * x - u) % P !== 0n) return false;
  }
  if (x === 0n && sign === 1n) return false;
  return true;
}

// ---------------------------------------------------------------- addresses

async function sha256(parts) {
  let length = 0;
  for (const p of parts) length += p.length;
  const joined = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** The address a program can sign for, given these seeds. Returns [address, bump]. */
export async function findProgramAddress(seeds, programId) {
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256([...seeds, new Uint8Array([bump]), program, PDA_MARKER]);
    if (!isOnCurve(hash)) return [base58Encode(hash), bump];
  }
  throw new Error("no program address found for these seeds");
}

const utf8 = (s) => new TextEncoder().encode(s);

/** A uuid as the 16 raw bytes the program uses for an agent id. */
export function uuidBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function uuidFromBytes(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const pdas = {
  config: () => findProgramAddress([utf8("config")], PROGRAM_ID),
  exitConfig: () => findProgramAddress([utf8("exit_config")], PROGRAM_ID),
  vault: (agentId) => findProgramAddress([utf8("vault"), uuidBytes(agentId)], PROGRAM_ID),
  owner: (agentId) => findProgramAddress([utf8("owner"), uuidBytes(agentId)], PROGRAM_ID),
  exit: (agentId) => findProgramAddress([utf8("exit"), uuidBytes(agentId)], PROGRAM_ID),
};

/** The owner's token account for a mint, as the associated token program derives it. */
export async function associatedTokenAddress(owner, mint) {
  const [address] = await findProgramAddress(
    [base58Decode(owner), base58Decode(TOKEN_PROGRAM_ID), base58Decode(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// ---------------------------------------------------------------- messages

/** Solana's compact-u16: a length prefix in one to three bytes. */
export function compactU16(n) {
  const out = [];
  let rest = n;
  for (;;) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return Uint8Array.from(out);
    }
    out.push(byte | 0x80);
  }
}

function u64le(value) {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const concat = (parts) => {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A legacy transaction message, serialized.
 *
 * Accounts are ordered the way Solana requires: signers before non-signers,
 * writable before read-only within each. The wallet signs these exact bytes,
 * so getting the order wrong does not produce a wrong transaction - it
 * produces one the network rejects, which is the safer way to be wrong.
 */
export function buildMessage({ payer, instructions, recentBlockhash }) {
  const metas = new Map();
  const note = (pubkey, { signer = false, writable = false }) => {
    const existing = metas.get(pubkey) ?? { pubkey, signer: false, writable: false };
    existing.signer ||= signer;
    existing.writable ||= writable;
    metas.set(pubkey, existing);
  };
  note(payer, { signer: true, writable: true });
  for (const ix of instructions) {
    for (const a of ix.keys) note(a.pubkey, a);
    note(ix.programId, {});
  }

  // The order Solana requires, and the order @solana/web3.js produces: signers
  // first, writable first within each, and then by base58 so that two accounts
  // of the same rank always land the same way round. The last tiebreak is not
  // decoration - without it two runs can produce different messages for the
  // same instruction, and only one of them is the one the network expects.
  const all = [...metas.values()];
  const collate = { localeMatcher: "best fit", usage: "sort", sensitivity: "variant", ignorePunctuation: false, numeric: false, caseFirst: "lower" };
  all.sort((a, b) => {
    if (a.signer !== b.signer) return a.signer ? -1 : 1;
    if (a.writable !== b.writable) return a.writable ? -1 : 1;
    return a.pubkey.localeCompare(b.pubkey, "en", collate);
  });
  // The fee payer pays, so it goes first whatever it sorted to.
  const payerAt = all.findIndex((m) => m.pubkey === payer);
  if (payerAt > 0) all.unshift(...all.splice(payerAt, 1));

  const keys = all.map((m) => m.pubkey);
  const index = new Map(keys.map((k, i) => [k, i]));
  const header = new Uint8Array([
    all.filter((m) => m.signer).length,
    all.filter((m) => m.signer && !m.writable).length,
    all.filter((m) => !m.signer && !m.writable).length,
  ]);

  const body = instructions.map((ix) =>
    concat([
      Uint8Array.from([index.get(ix.programId)]),
      compactU16(ix.keys.length),
      Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey))),
      compactU16(ix.data.length),
      ix.data,
    ]),
  );

  return concat([
    header,
    compactU16(keys.length),
    ...keys.map((k) => base58Decode(k)),
    base58Decode(recentBlockhash),
    compactU16(instructions.length),
    ...body,
  ]);
}

// ---------------------------------------------------------------- instructions

const ro = (pubkey) => ({ pubkey, signer: false, writable: false });
const rw = (pubkey) => ({ pubkey, signer: false, writable: true });

/** Starts an exit. Signed by the owner and nobody else. */
export async function requestExitIx({ owner, agentId, amount }) {
  const [config] = await pdas.config();
  const [exitConfig] = await pdas.exitConfig();
  const [agentOwner] = await pdas.owner(agentId);
  const [vault] = await pdas.vault(agentId);
  const [exit] = await pdas.exit(agentId);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, signer: true, writable: true },
      ro(config),
      ro(exitConfig),
      ro(agentOwner),
      ro(vault),
      rw(exit),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat([Uint8Array.from(DISCRIMINATORS.request_exit), uuidBytes(agentId), u64le(amount)]),
  };
}

/** Claims an exit whose window has passed. Signed by the owner and nobody else. */
export async function claimExitIx({ owner, agentId, destination }) {
  const [config] = await pdas.config();
  const [agentOwner] = await pdas.owner(agentId);
  const [vault] = await pdas.vault(agentId);
  const [exit] = await pdas.exit(agentId);
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, signer: true, writable: true },
      ro(config),
      ro(agentOwner),
      rw(vault),
      rw(destination),
      rw(exit),
      ro(TOKEN_PROGRAM_ID),
    ],
    data: concat([Uint8Array.from(DISCRIMINATORS.claim_exit), uuidBytes(agentId)]),
  };
}

/** Cancels an unclaimed exit, or clears a claimed one once its record has served. */
export async function closeExitIx({ owner, agentId }) {
  const [exitConfig] = await pdas.exitConfig();
  const [exit] = await pdas.exit(agentId);
  return {
    programId: PROGRAM_ID,
    keys: [{ pubkey: owner, signer: true, writable: true }, ro(exitConfig), rw(exit)],
    data: concat([Uint8Array.from(DISCRIMINATORS.close_exit), uuidBytes(agentId)]),
  };
}

// ---------------------------------------------------------------- accounts

const le = (bytes, at, size) => {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
};

/** An Exit account as the program lays it out, after the 8-byte discriminator. */
export function decodeExit(data) {
  let at = 8;
  const agentId = uuidFromBytes(data.slice(at, at + 16));
  at += 16;
  const owner = base58Encode(data.slice(at, at + 32));
  at += 32;
  const read = () => {
    const v = le(data, at, 8);
    at += 8;
    return Number(v);
  };
  return {
    agentId,
    owner,
    amount: read(),
    requestedSlot: read(),
    unlockSlot: read(),
    vaultAtRequest: read(),
    claimedSlot: read(),
    claimedAmount: read(),
  };
}

/** An AgentOwner account: which wallet an agent belongs to. */
export function decodeAgentOwner(data) {
  return { agentId: uuidFromBytes(data.slice(8, 24)), owner: base58Encode(data.slice(24, 56)) };
}

/** A Config account, for the mint and the chip rate. */
export function decodeConfig(data) {
  return {
    admin: base58Encode(data.slice(8, 40)),
    settler: base58Encode(data.slice(40, 72)),
    mint: base58Encode(data.slice(72, 104)),
    maxSettlement: Number(le(data, 104, 8)),
    rent: Number(le(data, 112, 8)),
    chipRate: Number(le(data, 120, 8)),
  };
}

/** An SPL token account's balance, which is all this needs from one. */
export function decodeTokenAmount(data) {
  return Number(le(data, 64, 8));
}

export function decodeExitConfig(data) {
  return { slots: Number(le(data, 8, 8)) };
}
