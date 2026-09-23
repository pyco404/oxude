import "./env.js";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { existsSync } from "node:fs";
import { loadKeypair } from "../src/chain/common.js";
import { ChainClient, DEVNET_CHIP_RATE, PROGRAM_ID, pdas, STAKE_DECIMALS } from "../src/chain/settlement.js";
import { bandByName } from "../src/db/schema.js";

// Initialises the deposit-funded settlement program on a cluster, idempotently,
// and tops up the settler so it can pay rent for the accounts it opens.
//
//   CHAIN_RPC_URL=https://api.devnet.solana.com npx tsx scripts/chain-setup.ts
//
// Keys: .keys/admin.json pays for initialisation and funds the settler;
// .keys/settler.json is the only key the program lets settle. The stake token
// comes from CHAIN_STAKE_MINT, or from .keys/stake-mint.json if that is unset
// (scripts/stake-mint.ts makes both).
//
// The program is told three numbers it cannot work out for itself:
//
//   chip_rate       base units to one chip. Fixed at one chip to one whole
//                   token on devnet, so nothing else moves while the deposit
//                   flow is tested. On mainnet the season boundary sets it.
//   max_settlement  band C's worst match, converted at that rate. It is what a
//                   single settlement can never exceed.
//   rent            what renting costs, burned. $2 at a chip of about a cent
//                   is 200 chips, which is the default here.
//
// For the frozen seed-funded program, see scripts/seed-chain-setup.ts.

const rpc = process.env["CHAIN_RPC_URL"] ?? "http://127.0.0.1:18899";
const connection = new Connection(rpc, "confirmed");
const admin = loadKeypair(process.env["CHAIN_ADMIN_KEYPAIR"] ?? ".keys/admin.json");
const settler = loadKeypair(process.env["CHAIN_SETTLER_KEYPAIR"] ?? ".keys/settler.json");
const SETTLER_FLOOR = Number(process.env["SETTLER_MIN_SOL"] ?? 0.5);

const CHIP_RATE = Number(process.env["CHAIN_CHIP_RATE"] ?? DEVNET_CHIP_RATE);
const RENT_CHIPS = Number(process.env["CHAIN_RENT_CHIPS"] ?? 200);
const MAX_SETTLEMENT = bandByName("C").worstMatch * CHIP_RATE;
const RENT = RENT_CHIPS * CHIP_RATE;

function stakeMint(): PublicKey {
  const named = process.env["CHAIN_STAKE_MINT"];
  if (named) return new PublicKey(named);
  const path = process.env["CHAIN_STAKE_MINT_KEYPAIR"] ?? ".keys/stake-mint.json";
  if (existsSync(path)) return loadKeypair(path).publicKey;
  console.error("No stake token. Set CHAIN_STAKE_MINT, or run scripts/stake-mint.ts to make one on devnet.");
  process.exit(1);
}

const sol = async (key: PublicKey) => (await connection.getBalance(key, "confirmed")) / LAMPORTS_PER_SOL;
const mint = stakeMint();

console.log(`cluster  ${rpc}`);
console.log(`program  ${PROGRAM_ID.toBase58()}`);
const program = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
if (!program?.executable) {
  console.error("The program is not deployed on this cluster. Run scripts/chain-deploy.sh first.");
  process.exit(1);
}

console.log(`admin    ${admin.publicKey.toBase58()}  ${(await sol(admin.publicKey)).toFixed(3)} SOL`);
console.log(`settler  ${settler.publicKey.toBase58()}  ${(await sol(settler.publicKey)).toFixed(3)} SOL`);

// The token the program will be pointed at. Both of these are refused by
// initialize, so say so here rather than letting it fail with a code.
const mintInfo = await connection.getAccountInfo(mint, "confirmed");
if (!mintInfo) {
  console.error(`No mint at ${mint.toBase58()} on this cluster. Run scripts/stake-mint.ts.`);
  process.exit(1);
}
const token = await getMint(connection, mint, "confirmed");
console.log(`mint     ${mint.toBase58()}  ${token.decimals} decimals, supply ${(Number(token.supply) / 10 ** token.decimals).toLocaleString()}`);
if (token.decimals !== STAKE_DECIMALS) {
  console.error(`The stake token must have ${STAKE_DECIMALS} decimals, not ${token.decimals}.`);
  process.exit(1);
}
if (token.mintAuthority !== null) {
  console.error("The stake token still has a mint authority, so its supply is not fixed. The program will refuse it.");
  console.error("On devnet, scripts/stake-mint.ts gives the authority up once the supply is issued.");
  process.exit(1);
}

if (await connection.getAccountInfo(pdas.config(), "confirmed")) {
  const config = await new ChainClient(connection, admin, mint).config();
  if (config.settler.toBase58() !== settler.publicKey.toBase58()) {
    console.error(`Already initialised with a different settler: ${config.settler.toBase58()}`);
    process.exit(1);
  }
  if (config.mint.toBase58() !== mint.toBase58()) {
    console.error(`Already initialised against a different stake token: ${config.mint.toBase58()}`);
    console.error("A vault is a token account for that mint, so this cannot be changed. Deploy a fresh program id instead.");
    process.exit(1);
  }
  // The admin on the config is the only key set_max_settlement accepts, and it
  // is not the same thing as the program's upgrade authority. If they have
  // drifted apart, say so now rather than at the first failed limit change.
  if (config.admin.toBase58() !== admin.publicKey.toBase58()) {
    console.warn(`WARNING  the config's admin is ${config.admin.toBase58()}, not this key.`);
    console.warn("         set-max-settlement, set-rent and set-chip-rate will refuse this key with NotAdmin.");
  }
  const rate = config.chipRate.toNumber();
  console.log(`config   ${pdas.config().toBase58()}  already initialised`);
  console.log(`         chip rate ${rate} base units, limit ${config.maxSettlement.toNumber() / rate} chips, rent ${config.rent.toNumber() / rate} chips`);
} else {
  const signature = await new ChainClient(connection, admin, mint).initialize(settler.publicKey, MAX_SETTLEMENT, RENT, CHIP_RATE);
  console.log(`config   ${pdas.config().toBase58()}  initialised (${signature})`);
  console.log(`         chip rate ${CHIP_RATE} base units, limit ${bandByName("C").worstMatch} chips, rent ${RENT_CHIPS} chips`);
}

// The settler pays rent for each vault, settlement, withdrawal and rental record it creates.
const have = await sol(settler.publicKey);
if (have < SETTLER_FLOOR) {
  const top = SETTLER_FLOOR - have;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: settler.publicKey,
      lamports: Math.ceil(top * LAMPORTS_PER_SOL),
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log(`settler  topped up by ${top.toFixed(3)} SOL`);
}
console.log("ready");
