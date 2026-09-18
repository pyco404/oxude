import "./env.js";
import { connect, migrate } from "../src/db/client.js";
import { listen } from "../src/http/server.js";
import { createAgent, CEILING_BANDS } from "../src/db/runner.js";
import { refreshTrueRatings } from "../src/db/rating.js";
import { agents } from "../src/db/schema.js";
import { mulberry32, PRESET_NAMES } from "../src/index.js";
import { nameFactory } from "./names.js";

// Dev server. Usage: npm run serve [-- --port 8787 --migrate --roster 24 --memory]
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
// Matches are linked from share pages and the chain, so they must outlive the
// process. In-memory PGlite only on request, for a throwaway run.
if (!process.env["DATABASE_URL"] && !process.argv.includes("--memory")) {
  console.error("DATABASE_URL is not set. Point it at Postgres (see docker-compose.yml), or pass --memory for a throwaway in-memory run.");
  process.exit(1);
}
const { db } = await connect();
if (process.argv.includes("--migrate")) await migrate(db);

// The house roster: unowned preset agents spread across the ceiling bands, so a
// first player has someone to meet in every band. Only when the roster is empty.
const rosterSize = arg("--roster", 24);
if (rosterSize > 0 && (await db.select({ id: agents.id }).from(agents).limit(1)).length === 0) {
  const nextName = nameFactory(mulberry32(Date.now() % 1_000_000));
  const ceilings = CEILING_BANDS.map((b) => b.max);
  for (let i = 0; i < rosterSize; i++) {
    await createAgent(db, {
      name: nextName(),
      presetName: PRESET_NAMES[i % PRESET_NAMES.length]!,
      maxStake: ceilings[i % ceilings.length]!,
    });
  }
  console.log(`Seeded a house roster of ${rosterSize} agents across ${ceilings.length} bands`);
}
// Brings stored ratings up to date if the roster or the way ratings are computed changed.
const rerated = await refreshTrueRatings(db);
if (rerated) console.log(`Re-rated ${rerated} agents`);
// House exhibitions, when configured: house agents play each other so the feed
// shows the platform running. They stake and settle nothing.
const exhibitionMs = Number(process.env["HOUSE_EXHIBITION_MS"] ?? 0);
if (exhibitionMs > 0) {
  const { startHouseExhibitions } = await import("../src/db/house.js");
  startHouseExhibitions(db, {
    intervalMs: exhibitionMs,
    onError: (error) => console.error(`house: exhibition failed: ${String(error).slice(0, 160)}`),
  });
  console.log(`House exhibitions: about one every ${Math.round(exhibitionMs / 1000)}s, off-chain`);
}
// A host sets PORT and needs every interface; locally, loopback only.
const { url } = await listen({ db, port: Number(process.env["PORT"] ?? arg("--port", 8787)), host: process.env["HOST"] });

// Settlement on chain, when configured. The ledger is authoritative either
// way; without a chain the outbox simply waits.
const rpc = process.env["CHAIN_RPC_URL"];
if (rpc) {
  const { Connection, Keypair } = await import("@solana/web3.js");
  const { ChainClient, loadKeypair } = await import("../src/chain/settlement.js");
  const { startChainWorker } = await import("../src/chain/worker.js");
  // A host has no key file: CHAIN_SETTLER_SECRET carries the same JSON byte array.
  const secret = process.env["CHAIN_SETTLER_SECRET"];
  const settler = secret
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]))
    : loadKeypair(process.env["CHAIN_SETTLER_KEYPAIR"] ?? ".keys/settler.json");
  const chain = new ChainClient(new Connection(rpc, "confirmed"), settler);
  // web3.js confirms a transaction by racing a block-height poll it never
  // awaits, so a flaky RPC can reject outside any of our try blocks and would
  // otherwise kill the API. Nothing is lost by carrying on: every ledger write
  // is one transaction, and the worker retries unconfirmed ops on its next pass.
  process.on("unhandledRejection", (error) => {
    console.error(`chain: unhandled rejection, continuing: ${String(error).slice(0, 160)}`);
  });
  startChainWorker(db, chain, {
    intervalMs: Number(process.env["CHAIN_INTERVAL_MS"] ?? 5000),
    onPass: (r) => {
      if (r.confirmed || r.alreadyOnChain || r.error) {
        console.log(`chain: ${r.confirmed} confirmed, ${r.alreadyOnChain} already on chain${r.error ? `, stopped: ${r.error.slice(0, 160)}` : ""}`);
      }
    },
  });
  // Hosted RPC URLs carry an API key in the query string; keep it out of the logs.
  const shown = new URL(rpc);
  console.log(`Settling to ${shown.origin}${shown.pathname} as ${settler.publicKey.toBase58()}`);
}
console.log(`Oxude on ${url}`);
console.log(process.env["ANTHROPIC_API_KEY"] ? "Briefs: on" : "Briefs: off, no ANTHROPIC_API_KEY in the environment or .env; presets only");
console.log(`  POST ${url}/agents         wallet session required; {name, presetName} or {name, brief}`);
console.log(`  GET  ${url}/agents/:id     public, or the owner view for its signed-in owner`);
console.log(`  POST ${url}/agents/:id/play`);
console.log(`  GET  ${url}/matches/:id    includes the rendered transcript`);
console.log(`  GET  ${url}/ladder?sort=winnings|per-match`);
console.log(`  POST ${url}/preview        {brief} or {policyTable}`);
