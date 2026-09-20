import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ChainClient, loadKeypair, PROGRAM_ID, pdas } from "../src/chain/settlement.js";
import { MAX_EXPOSURE } from "../src/db/schema.js";

// Initialises the settlement program on a cluster, idempotently, and tops up
// the settler so it can pay rent for vaults and settlement records.
//
//   CHAIN_RPC_URL=https://api.devnet.solana.com npx tsx scripts/chain-setup.ts
//
// Keys: .keys/admin.json pays for initialisation and funds the settler;
// .keys/settler.json is the only key the program lets settle.
const rpc = process.env["CHAIN_RPC_URL"] ?? "http://127.0.0.1:18899";
const connection = new Connection(rpc, "confirmed");
const admin = loadKeypair(process.env["CHAIN_ADMIN_KEYPAIR"] ?? ".keys/admin.json");
const settler = loadKeypair(process.env["CHAIN_SETTLER_KEYPAIR"] ?? ".keys/settler.json");
const SETTLER_FLOOR = Number(process.env["SETTLER_MIN_SOL"] ?? 0.5);

const sol = async (key: PublicKey) => (await connection.getBalance(key, "confirmed")) / LAMPORTS_PER_SOL;

console.log(`cluster  ${rpc}`);
console.log(`program  ${PROGRAM_ID.toBase58()}`);
const program = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
if (!program?.executable) {
  console.error("The program is not deployed on this cluster. Run scripts/chain-deploy.sh first.");
  process.exit(1);
}

console.log(`admin    ${admin.publicKey.toBase58()}  ${(await sol(admin.publicKey)).toFixed(3)} SOL`);
console.log(`settler  ${settler.publicKey.toBase58()}  ${(await sol(settler.publicKey)).toFixed(3)} SOL`);

if (await connection.getAccountInfo(pdas.config(), "confirmed")) {
  const config = await new ChainClient(connection, admin).config();
  if (config.settler.toBase58() !== settler.publicKey.toBase58()) {
    console.error(`Already initialised with a different settler: ${config.settler.toBase58()}`);
    process.exit(1);
  }
  // The admin on the config is the only key set_max_settlement accepts, and it
  // is not the same thing as the program's upgrade authority. If they have
  // drifted apart, say so now rather than at the first failed limit change.
  if (config.admin.toBase58() !== admin.publicKey.toBase58()) {
    console.warn(`WARNING  the config's admin is ${config.admin.toBase58()}, not this key.`);
    console.warn("         set-max-settlement will refuse this key with NotAdmin.");
  }
  console.log(`config   ${pdas.config().toBase58()}  already initialised, limit ${config.maxSettlement.toString()}`);
} else {
  const signature = await new ChainClient(connection, admin).initialize(settler.publicKey, MAX_EXPOSURE);
  console.log(`config   ${pdas.config().toBase58()}  initialised (${signature})`);
}
console.log(`mint     ${pdas.mint().toBase58()}`);

// The settler pays rent for each vault and settlement record it creates.
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
