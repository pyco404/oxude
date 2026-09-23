import "./env.js";
import {
  AuthorityType,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { existsSync, writeFileSync } from "node:fs";
import { loadKeypair } from "../src/chain/common.js";
import { STAKE_DECIMALS } from "../src/chain/settlement.js";

/**
 * Makes the devnet stake token, the way a pump.fun token is made: a mint with
 * an authority, the whole supply issued once, and then the authority given up
 * for good. After the last step nobody can mint - not this script, not the
 * settlement program, not the admin key - so every balance in the game traces
 * to a deposit somebody made or to a match won from another vault.
 *
 *   CHAIN_RPC_URL=https://api.devnet.solana.com npx tsx scripts/stake-mint.ts
 *
 * Keys: .keys/admin.json pays. .keys/stake-mint.json is the mint's own keypair,
 * needed only to create the account. .keys/treasury.json holds the supply and
 * is what the faucet hands out from.
 *
 * Every step is skipped if it has already been done, so a run that died halfway
 * is finished by running it again. The order matters and is the order below:
 * the supply has to exist before the authority to make it is given up.
 *
 * This is a devnet tool. On mainnet the stake token is $OXUDE, which already
 * exists and which nobody here has ever had the authority to mint.
 */

const RPC = process.env["CHAIN_RPC_URL"] ?? "http://127.0.0.1:18899";
/** A billion tokens, as $OXUDE has. 1e15 base units: inside a u64, and inside a JavaScript safe integer. */
const SUPPLY_TOKENS = 1_000_000_000;
const SUPPLY = SUPPLY_TOKENS * 10 ** STAKE_DECIMALS;

const connection = new Connection(RPC, "confirmed");
const admin = loadKeypair(process.env["CHAIN_ADMIN_KEYPAIR"] ?? ".keys/admin.json");

/** Loads a keypair, making it first if it isn't there. Never prints the secret. */
function keypairAt(path: string): { key: Keypair; made: boolean } {
  if (existsSync(path)) return { key: loadKeypair(path), made: false };
  const key = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
  return { key, made: true };
}

const mintKey = keypairAt(process.env["CHAIN_STAKE_MINT_KEYPAIR"] ?? ".keys/stake-mint.json");
const treasuryKey = keypairAt(process.env["CHAIN_TREASURY_KEYPAIR"] ?? ".keys/treasury.json");
const mint = mintKey.key.publicKey;
const treasury = treasuryKey.key.publicKey;

console.log(`cluster   ${RPC}`);
console.log(`admin     ${admin.publicKey.toBase58()}`);
console.log(`mint      ${mint.toBase58()}${mintKey.made ? "  (new keypair)" : ""}`);
console.log(`treasury  ${treasury.toBase58()}${treasuryKey.made ? "  (new keypair)" : ""}`);

const sol = (await connection.getBalance(admin.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
if (sol < 0.1) {
  console.error(`The admin key has ${sol.toFixed(3)} SOL and needs about 0.1 to make the mint and its accounts.`);
  console.error(`Fund ${admin.publicKey.toBase58()} first. Devnet: https://faucet.solana.com`);
  process.exit(1);
}

// 1. The mint itself, with the admin holding the authority for as long as it
//    takes to issue the supply.
if (await connection.getAccountInfo(mint, "confirmed")) {
  console.log("mint      already exists");
} else {
  await createMint(connection, admin, admin.publicKey, null, STAKE_DECIMALS, mintKey.key);
  console.log(`mint      created with ${STAKE_DECIMALS} decimals`);
}

const decimals = (await getMint(connection, mint, "confirmed")).decimals;
if (decimals !== STAKE_DECIMALS) {
  console.error(`This mint has ${decimals} decimals, not ${STAKE_DECIMALS}. The program will refuse it.`);
  process.exit(1);
}

// 2 and 3. The treasury's account, and the whole supply into it, once.
const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
await createAssociatedTokenAccountIdempotent(connection, admin, mint, treasury);
const supply = Number((await getMint(connection, mint, "confirmed")).supply);
if (supply > 0) {
  console.log(`supply    already issued: ${(supply / 10 ** STAKE_DECIMALS).toLocaleString()} tokens`);
} else {
  await mintTo(connection, admin, mint, treasuryAta, admin, SUPPLY);
  console.log(`supply    ${SUPPLY_TOKENS.toLocaleString()} tokens issued to the treasury`);
}

// 4. The authority goes, and with it any possibility of inflation. Last,
//    because after this nothing above can be done again.
const authority = (await getMint(connection, mint, "confirmed")).mintAuthority;
if (authority === null) {
  console.log("authority already given up: the supply is fixed");
} else {
  await setAuthority(connection, admin, mint, admin, AuthorityType.MintTokens, null);
  console.log("authority given up: nobody can mint this token again");
}

const after = await getMint(connection, mint, "confirmed");
console.log("");
console.log(`CHAIN_STAKE_MINT=${mint.toBase58()}`);
console.log(`treasury holds ${(Number((await getAccount(connection, treasuryAta, "confirmed")).amount) / 10 ** STAKE_DECIMALS).toLocaleString()} tokens`);
if (after.mintAuthority !== null) {
  console.error("WARNING  the mint authority is still set; the program will refuse this token.");
  process.exit(1);
}
