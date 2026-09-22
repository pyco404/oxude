import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agentTraits, matches } from "../src/db/schema.js";
import { createAgent, runExhibition, runMatch } from "../src/db/runner.js";
import { addCounts, countMatch, EMPTY_COUNTS } from "../src/character/traits.js";
import { traitsOf, updateTraits } from "../src/character/trait-store.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

/** A player agent, a house agent it plays for money, and two house agents playing exhibitions. */
async function played(db: Db) {
  const me = await createAgent(db, { name: "Me", presetName: "Mirage", ownerId: someWallet() });
  const h1 = await createAgent(db, { name: "H1", presetName: "Bully" });
  const h2 = await createAgent(db, { name: "H2", presetName: "Anchor" });
  for (let seed = 1; seed <= 6; seed++) await runMatch(db, me.id, h1.id, { seed });
  for (let seed = 10; seed <= 13; seed++) await runExhibition(db, h1.id, h2.id, { seed });
  return { me, h1, h2 };
}

/** What counting every stored match directly gives for one agent. */
async function direct(db: Db, id: string) {
  let c = EMPTY_COUNTS;
  for (const m of await db.select().from(matches)) {
    if (m.agentA === id) c = addCounts(c, countMatch(m.log, "A"));
    if (m.agentB === id) c = addCounts(c, countMatch(m.log, "B"));
  }
  return c;
}
const stored = async (db: Db, id: string) => {
  const [row] = await db.select().from(agentTraits).where(eq(agentTraits.agentId, id));
  const { agentId: _, updatedAt: __, ...counts } = row!;
  return counts;
};

describe("keeping traits current", () => {
  it("counts every match once, exhibitions included, for both seats", async () => {
    const { db, close } = await fresh();
    const { me, h1, h2 } = await played(db);
    const pass = await updateTraits(db);
    expect(pass.matches).toBe(10);
    for (const a of [me, h1, h2]) expect(await stored(db, a.id)).toEqual(await direct(db, a.id));
    // Nothing new: a second pass adds nothing.
    expect((await updateTraits(db)).matches).toBe(0);
    expect(await stored(db, me.id)).toEqual(await direct(db, me.id));
    await close();
  });

  it("gives the same counts in small batches as in one, and picks up new matches after", async () => {
    const { db, close } = await fresh();
    const { me, h1 } = await played(db);
    while ((await updateTraits(db, 3)).matches > 0) {}
    expect(await stored(db, me.id)).toEqual(await direct(db, me.id));
    await runMatch(db, me.id, h1.id, { seed: 99 });
    expect((await updateTraits(db)).matches).toBe(1);
    expect(await stored(db, me.id)).toEqual(await direct(db, me.id));
    await close();
  });

  it("says not enough hands yet for an agent that has barely played", async () => {
    const { db, close } = await fresh();
    const { me } = await played(db);
    const fresh1 = await createAgent(db, { name: "New", presetName: "Anchor", ownerId: someWallet() });
    await updateTraits(db);
    expect((await traitsOf(db, fresh1.id)).note).toBe("not enough hands yet");
    expect((await traitsOf(db, me.id)).decisions).toBeGreaterThan(0);
    await close();
  });
});
