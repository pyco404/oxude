import { describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { connect, migrate, type Db } from "../src/db/client.js";
import { agents, ledger, matches } from "../src/db/schema.js";
import { createAgent, pickOpponent, runMatch } from "../src/db/runner.js";
import { dueAgents } from "../src/db/autoplay.js";
import { StakeError } from "../src/db/ledger.js";
import { seasonAt } from "../src/season.js";
import { someWallet } from "./helpers.js";

const fresh = async () => {
  const c = await connect();
  await migrate(c.db);
  return c;
};

const house = async (db: Db, n: number) => {
  for (let i = 0; i < n; i++) {
    await createAgent(db, { name: `H${i}-${Math.random().toString(36).slice(2, 6)}`, presetName: (["Anchor", "Hammer", "Mirage", "Bully"] as const)[i % 4]! });
  }
};

/** Ends an agent's rental a minute ago, as the season boundary would. */
const expire = (db: Db, id: string) =>
  db.update(agents).set({ rentalEndsAt: new Date(Date.now() - 60_000) }).where(eq(agents.id, id));

describe("rentals end at the season boundary", () => {
  it("ends a player's rental at the end of the season it is rented in, and never a house agent's", async () => {
    const { db, close } = await fresh();
    const now = new Date();
    const player = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    const h = await createAgent(db, { name: "H", presetName: "Anchor" });
    expect(player.rentalEndsAt?.getTime()).toBe(seasonAt(now).end.getTime());
    expect(h.rentalEndsAt).toBeNull();
    // Renting on the season's last Sunday still ends at that Monday, not a week later.
    const late = await createAgent(db, { name: "Late", presetName: "Anchor", ownerId: someWallet(), now: new Date("2026-09-27T23:50:00Z") });
    expect(late.rentalEndsAt?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    await close();
  });

  it("records each match in the season it was played in", async () => {
    const { db, close } = await fresh();
    await house(db, 1);
    const player = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    const [opp] = await db.select().from(agents).where(isNull(agents.ownerId));
    const { match } = await runMatch(db, player.id, opp!.id, { seed: 3 });
    expect(match.season).toBe(seasonAt(match.createdAt).key);
    await close();
  });

  it("refuses to record a match for an agent whose rental has ended, and moves nothing", async () => {
    const { db, close } = await fresh();
    await house(db, 1);
    const [h] = await db.select().from(agents);
    const player = await createAgent(db, { name: "P", presetName: "Anchor", ownerId: someWallet() });
    await expire(db, player.id);
    await expect(runMatch(db, player.id, h!.id)).rejects.toThrow(StakeError);
    await expect(runMatch(db, h!.id, player.id)).rejects.toThrow(/rental ended with the season/);
    expect(await db.select().from(matches)).toHaveLength(0);
    expect((await db.select().from(ledger).where(eq(ledger.agentId, player.id))).map((r) => r.reason)).toEqual(["rental-seed"]);
    await close();
  });

  it("leaves an expired agent out of matchmaking and out of the scheduler", async () => {
    const { db, close } = await fresh();
    await house(db, 4);
    const me = await createAgent(db, { name: "Me", presetName: "Anchor", ownerId: someWallet() });
    const gone = await createAgent(db, { name: "Gone", presetName: "Bully", ownerId: someWallet() });
    await db.update(agents).set({ autoplay: true }).where(eq(agents.id, gone.id));
    await expire(db, gone.id);
    for (let i = 0; i < 10; i++) expect((await pickOpponent(db, me.id)).opponentId).not.toBe(gone.id);
    expect((await pickOpponent(db, me.id)).candidates).toBe(4);
    expect(await dueAgents(db, 0)).toHaveLength(0);
    await expect(pickOpponent(db, gone.id)).rejects.toThrow(/renew it to play/);
    await close();
  });
});
