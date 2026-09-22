import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, characters } from "../src/db/schema.js";
import { createAgent, snapshotPreset } from "../src/db/runner.js";
import { agentsWithoutCharacter, createCharacter, isDefaultName, portraitSvg, type CharacterDeps } from "../src/character/store.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};
const nameOf = async (db: Db, id: string) => (await db.select({ n: agents.name }).from(agents).where(eq(agents.id, id)))[0]!.n;

describe("creating a character", () => {
  it("does it once: a second call returns the same character", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "Mirage rental", presetName: "Mirage", ownerId: someWallet() });
    const first = await createCharacter(db, a.id);
    const second = await createCharacter(db, a.id);
    expect(second).toEqual(first);
    expect(await db.select().from(characters)).toHaveLength(1);
    await close();
  });

  it("replaces a name nobody chose, keeps one the owner did, and names house agents", async () => {
    const { db, close } = await fresh();
    const defaulted = await createAgent(db, { name: "Mirage rental", presetName: "Mirage", ownerId: someWallet() });
    const chosen = await createAgent(db, { name: "Lanternjaw", presetName: "Anchor", ownerId: someWallet() });
    const house = await createAgent(db, { name: "Longshadow-7774", presetName: "Bully" });
    await createCharacter(db, defaulted.id);
    await createCharacter(db, chosen.id, { nameVerdict: { ok: true, reason: null, checked: true } });
    await createCharacter(db, house.id);
    expect(await nameOf(db, defaulted.id)).not.toBe("Mirage rental");
    expect(await nameOf(db, chosen.id)).toBe("Lanternjaw");
    expect(await nameOf(db, house.id)).not.toBe("Longshadow-7774");
    expect(isDefaultName("Hammer rental")).toBe(true);
    expect(isDefaultName("My agent")).toBe(true);
    expect(isDefaultName("Hammer rentals")).toBe(false);
    await close();
  });

  it("never gives two agents the same face or name, and keeps their looks apart", async () => {
    const { db, close } = await fresh();
    for (let i = 0; i < 30; i++) {
      const a = await createAgent(db, { name: `H${i}`, presetName: (["Anchor", "Hammer", "Mirage", "Bully"] as const)[i % 4]! });
      await createCharacter(db, a.id);
    }
    const rows = await db.select().from(characters);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(30);
    expect(new Set(rows.map((r) => r.lookKey)).size).toBe(30);
    const names = (await db.select({ n: agents.name }).from(agents)).map((r) => r.n);
    expect(new Set(names).size).toBe(30);
    await close();
  });

  it("writes a brief-written agent's bio with the model, and falls back to the template when the bio fails its check", async () => {
    const { db, close } = await fresh();
    const deps = (bio: string, verdict: boolean): CharacterDeps => ({
      writeBio: async () => bio,
      check: async () => (verdict ? { ok: true, reason: null } : { ok: false, reason: "no" }),
    });
    const good = await createAgent(db, { name: "Briefed", brief: "bluff a lot", policyTable: snapshotPreset("Mirage"), ownerId: someWallet() });
    const c1 = await createCharacter(db, good.id, { deps: deps("It smiles at every raise and means none of them.", true) });
    expect(c1).toMatchObject({ bioSource: "model", bio: "It smiles at every raise and means none of them.", moderation: "ok" });

    const bad = await createAgent(db, { name: "Briefed", brief: "bluff a lot", policyTable: snapshotPreset("Mirage"), ownerId: someWallet() });
    const c2 = await createCharacter(db, bad.id, { deps: deps("A bio that fails the check for some reason.", false) });
    expect(c2.bioSource).toBe("template");

    // A preset agent never costs a model call.
    let called = 0;
    const preset = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    await createCharacter(db, preset.id, { deps: { check: null, writeBio: async () => (called++, "unused bio text here") } });
    expect(called).toBe(0);
    await close();
  });

  it("marks a character whose chosen name could not be checked, rather than passing it silently", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "Unverified", presetName: "Hammer", ownerId: someWallet() });
    const c = await createCharacter(db, a.id, { nameVerdict: { ok: true, reason: null, checked: false } });
    expect(c).toMatchObject({ moderation: "flagged", moderationNote: "name not checked: the model could not be reached" });
    await close();
  });

  it("keeps an owner's name that fails its check in the backfill, flagged for a person to decide", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "Questionable", presetName: "Anchor", ownerId: someWallet() });
    const c = await createCharacter(db, a.id, { nameVerdict: { ok: false, reason: "it names a real person", checked: true } });
    expect(await nameOf(db, a.id)).toBe("Questionable");
    expect(c).toMatchObject({ nameSource: "owner", moderation: "flagged", moderationNote: "name failed its check: it names a real person" });
    await close();
  });

  it("serves a portrait for an agent without a character yet, drawn and not stored", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "Late", presetName: "Bully" });
    expect(await agentsWithoutCharacter(db)).toEqual([{ id: a.id, name: "Late" }]);
    const svg = await portraitSvg(db, a, false);
    expect(svg).toMatch(/^<svg /);
    expect(await db.select().from(characters)).toHaveLength(0);
    await createCharacter(db, a.id);
    expect(await agentsWithoutCharacter(db)).toEqual([]);
    await close();
  });
});
