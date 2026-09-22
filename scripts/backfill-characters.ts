import "./env.js";
import { connect } from "../src/db/client.js";
import { agentsWithoutCharacter, createCharacter, isDefaultName, NO_MODEL, type CharacterDeps } from "../src/character/store.js";
import { moderate } from "../src/character/moderation.js";
import { agents } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Gives every agent without a character one: house agents and player agents,
 * oldest first, so the earliest agents have first pick of the looks.
 *
 *   npx tsx scripts/backfill-characters.ts
 *
 * Names nobody chose - house names, and "Mirage rental"-style defaults - are
 * replaced with generated ones. Names an owner chose are checked and kept; any
 * that fail the check are flagged and listed at the end for a person to
 * decide. Safe to run again: an agent that has a character is skipped.
 */

const { db, close } = await connect();
// The model check and bio writer, when there is a key; otherwise the local rules and templates.
const deps: CharacterDeps = process.env["ANTHROPIC_API_KEY"]
  ? await import("../src/character/model.js").then(({ textCheck, bioWriter }) => ({ check: textCheck(), writeBio: bioWriter() }))
  : NO_MODEL;
console.log(deps.check ? "Checking names with the model." : "No model key: local rules and templates only.");

const todo = await agentsWithoutCharacter(db);
let renamed = 0;
const flagged: string[] = [];
for (const { id, name } of todo) {
  const [agent] = await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, id));
  const chosen = agent?.ownerId !== null && !isDefaultName(name);
  const nameVerdict = chosen ? await moderate(name, "name", deps.check) : undefined;
  const c = await createCharacter(db, id, { deps, ...(nameVerdict ? { nameVerdict } : {}) });
  const [after] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, id));
  if (after!.name !== name) {
    renamed++;
    console.log(`${id.slice(0, 8)}  ${name} -> ${after!.name}, ${c.epithet} (${c.characterType})`);
  } else {
    console.log(`${id.slice(0, 8)}  ${name}, ${c.epithet} (${c.characterType}) - owner's name kept`);
  }
  if (c.moderation === "flagged") flagged.push(`${id}  ${after!.name}: ${c.moderationNote}`);
}
console.log(`\n${todo.length} agents given a character, ${renamed} renamed, ${flagged.length} flagged.`);
if (flagged.length) console.log(`Flagged for review:\n${flagged.join("\n")}`);
await close();
