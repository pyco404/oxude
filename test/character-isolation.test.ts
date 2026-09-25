import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, characters, ledger, matches } from "../src/db/schema.js";
import { createAgent, pickOpponent, replayMatch, resolveAgent, runMatch } from "../src/db/runner.js";
import { portrait } from "../src/character/portrait.js";
import { someWallet } from "./helpers.js";

/**
 * The rule: a character is identity and presentation only. Nothing about it
 * may reach the engine, matchmaking, the ledger, ratings or the chain, and
 * every hand stays deterministic and replayable. These tests are that rule.
 */

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

const giveCharacter = async (db: Db, agentId: string, look: string) => {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  const p = portrait(`${agentId}-${look}`, row!.policyTable!);
  const values = {
    agentId,
    nameSource: "generated" as const,
    epithet: `the ${look}`,
    bio: `A bio written for the ${look} look.`,
    bioSource: "template" as const,
    portraitVersion: 2,
    portraitSvg: p.svg,
    portraitSmallSvg: p.svgSmall,
    fingerprint: p.fingerprint,
    lookKey: p.lookKey,
    characterType: p.features.type,
  };
  await db.insert(characters).values(values).onConflictDoUpdate({ target: characters.agentId, set: values });
};

describe("a character cannot affect a match", () => {
  it("plays the same match, byte for byte, whatever either agent's character is", async () => {
    const results: unknown[] = [];
    for (const look of ["first", "second"]) {
      const { db, close } = await fresh();
      // Fresh agents each time: a match is decided by the two tables and the seed, nothing else.
      const a = await createAgent(db, { name: "A", presetName: "Mirage", ownerId: someWallet() });
      const b = await createAgent(db, { name: "B", presetName: "Hammer", ownerId: someWallet() });
      await giveCharacter(db, a.id, look);
      await giveCharacter(db, b.id, look);
      // Even the displayed name, the one thing a character shares with the agent row.
      await db.update(agents).set({ name: `Renamed ${look}` }).where(eq(agents.id, a.id));
      const { match, log, settled } = await runMatch(db, a.id, b.id, { seed: 424242 });
      const moved = await db.select({ amount: ledger.amount, reason: ledger.reason }).from(ledger).where(eq(ledger.matchId, match.id));
      results.push({ log, settled, moved, stake: match.stake });
      await close();
    }
    expect(results[1]).toEqual(results[0]);
  });

  it("replays a stored match exactly after the character changes", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "A", presetName: "Bully", ownerId: someWallet() });
    const b = await createAgent(db, { name: "B", presetName: "Anchor", ownerId: someWallet() });
    await giveCharacter(db, a.id, "before");
    const { match } = await runMatch(db, a.id, b.id, { seed: 99 });
    await giveCharacter(db, a.id, "after");
    await db.update(agents).set({ name: "Someone else entirely" }).where(eq(agents.id, a.id));
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
    const [rowA] = await db.select().from(agents).where(eq(agents.id, a.id));
    const [rowB] = await db.select().from(agents).where(eq(agents.id, b.id));
    expect(replayMatch(row!, resolveAgent(rowA!), resolveAgent(rowB!))).toEqual(row!.log);
    await close();
  });

  it("pairs the same opponent whatever the characters are", async () => {
    const { db, close } = await fresh();
    // Players: matchmaking will not offer a house agent, since a match against
    // one stakes nothing.
    for (let i = 0; i < 6; i++)
      await createAgent(db, {
        name: `H${i}`,
        presetName: (["Anchor", "Hammer", "Mirage"] as const)[i % 3]!,
        ownerId: someWallet(),
      });
    const me = await createAgent(db, { name: "Me", presetName: "Anchor", ownerId: someWallet() });
    const before = await pickOpponent(db, me.id);
    for (const row of await db.select().from(agents)) await giveCharacter(db, row.id, "changed");
    const after = await pickOpponent(db, me.id);
    expect(after.opponentId).toBe(before.opponentId);
    await close();
  });

  it("is kept out of everything that plays or pays: none of it imports character code", () => {
    const guarded = [
      "src/engine.ts",
      "src/round.ts",
      "src/exact.ts",
      "src/presets.ts",
      "src/agents/policy.ts",
      "src/db/runner.ts",
      "src/db/ledger.ts",
      "src/db/rating.ts",
      "src/db/standings.ts",
      "src/db/seasons.ts",
      "src/db/autoplay.ts",
      "src/db/house.ts",
      "src/db/withdrawals.ts",
      ...readdirSync("src/chain").filter((f) => f.endsWith(".ts")).map((f) => join("src/chain", f)),
    ];
    for (const file of guarded) {
      const imports = [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(imports.filter((i) => i.includes("character")), file).toEqual([]);
    }
  });
});
