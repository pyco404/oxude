import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import { agentIdFor, newAgentId } from "../src/agent-id.js";
import { connect, migrate } from "../src/db/client.js";
import { createAgent } from "../src/db/runner.js";
import { chainOps } from "../src/db/schema.js";
import { someWallet } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("an agent's id", () => {
  it("is a uuid, fixed by its owner and salt", () => {
    const owner = someWallet();
    const { id, salt } = newAgentId(owner);
    expect(id).toMatch(UUID);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(agentIdFor(owner, salt)).toBe(id);
  });

  it("belongs to one owner: nobody else's key gives it, and neither does the house", () => {
    const owner = someWallet();
    const { id, salt } = newAgentId(owner);
    expect(agentIdFor(someWallet(), salt)).not.toBe(id);
    expect(agentIdFor(null, salt)).not.toBe(id);
    // The same owner, a different salt: a different agent.
    expect(agentIdFor(owner, "00".repeat(16))).not.toBe(id);
  });

  it("is different every time, even for the same owner", () => {
    const owner = someWallet();
    const ids = new Set(Array.from({ length: 50 }, () => newAgentId(owner).id));
    expect(ids.size).toBe(50);
  });

  it("refuses an owner that isn't a wallet key", () => {
    expect(() => newAgentId("not-a-wallet")).toThrow(/wallet key/);
    // A valid key of the wrong kind is still a key: only the bytes matter.
    expect(() => newAgentId(Keypair.generate().publicKey.toBase58())).not.toThrow();
  });
});

describe("renting", () => {
  it("gives the agent an id derived from its owner, and the vault op the salt to prove it", async () => {
    const { db, close } = await connect();
    await migrate(db);
    const owner = someWallet();
    const mine = await createAgent(db, { name: "Mine", presetName: "Anchor", ownerId: owner });
    const house = await createAgent(db, { name: "House", presetName: "Bully" });

    const ops = await db.select().from(chainOps).where(eq(chainOps.kind, "open_vault"));
    const opFor = (id: string) => ops.find((o) => o.agentId === id)!;
    expect(opFor(mine.id).owner).toBe(owner);
    expect(agentIdFor(owner, opFor(mine.id).salt!)).toBe(mine.id);
    // A house agent has no owner, and its id says so.
    expect(opFor(house.id).owner).toBeNull();
    expect(agentIdFor(null, opFor(house.id).salt!)).toBe(house.id);
    expect(agentIdFor(owner, opFor(house.id).salt!)).not.toBe(house.id);
    // One op per agent: the owner is recorded as the vault opens, not afterwards.
    expect(ops).toHaveLength(2);
    expect(await db.select().from(chainOps).where(eq(chainOps.kind, "register_owner"))).toEqual([]);
    await close();
  });
});
