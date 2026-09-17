import { connect, migrate } from "../src/db/client.js";
import { listen } from "../src/http/server.js";

// Dev server. Usage: npm run serve [-- --port 8787 --migrate]
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const { db } = await connect();
if (process.argv.includes("--migrate")) await migrate(db);
const { url } = await listen({ db, port: arg("--port", 8787) });
console.log(`Oxude on ${url}`);
console.log(`  POST ${url}/agents         X-Owner-Id required; {name, presetName} or {name, brief}`);
console.log(`  GET  ${url}/agents/:id     public, or the owner view with a matching X-Owner-Id`);
console.log(`  POST ${url}/agents/:id/play`);
console.log(`  GET  ${url}/matches/:id    includes the rendered transcript`);
console.log(`  GET  ${url}/ladder?sort=winnings|per-match`);
console.log(`  POST ${url}/preview        {brief} or {policyTable}`);
