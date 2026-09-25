import { describe, expect, it } from "vitest";
import pg from "pg";
import { connect, migrate, type Db } from "../src/db/client.js";
import { balanceOf, balancesOf, record } from "../src/db/ledger.js";
import { createAgent, hasOutflowRoom, leaderboard, playableBands, publicAgent, runMatch } from "../src/db/runner.js";
import { liveCounters } from "../src/db/feed.js";
import { faucetStatus } from "../src/db/faucet.js";
import { baseUnits, DEVNET_CHIP_RATE } from "../src/chips.js";
import { chainOps } from "../src/db/schema.js";
import { someWallet } from "./helpers.js";

/**
 * The suite runs on PGlite; production runs on node-postgres. They do not agree
 * about int8: PGlite hands back a number, node-postgres a string. Through a
 * typed column drizzle hides the difference, but not through a raw
 * `sum(...)::bigint` - so a balance that came back as "900000000" in production
 * would pass every other test in this repo.
 *
 * This file is the guard. It runs only against a real Postgres, named by
 * PG_URL, and `scripts/pg-test.sh` puts a throwaway one in front of it. Add a
 * case here whenever a query starts returning a bigint.
 *
 *   scripts/pg-test.sh
 *   PG_URL=postgres://... npx vitest run test/postgres.test.ts
 */

const URL = process.env["PG_URL"];

/** A database of its own per test, because these share one server. */
let n = 0;
async function fresh(): Promise<{ db: Db; close: () => Promise<void> }> {
  const base = new pg.Pool({ connectionString: URL });
  const name = `oxude_test_${process.pid}_${n++}`;
  await base.query(`drop database if exists ${name}`);
  await base.query(`create database ${name}`);
  await base.end();
  const { db, close } = await connect(new URL_(URL!, name).toString());
  await migrate(db);
  return { db, close };
}
/** The same server, a different database. */
class URL_ {
  constructor(
    private readonly base: string,
    private readonly name: string,
  ) {}
  toString() {
    const u = new globalThis.URL(this.base);
    u.pathname = `/${this.name}`;
    return u.toString();
  }
}

describe.skipIf(!URL)("against a real Postgres", () => {
  it("reads a balance as an exact number, past what a 32-bit column held", async () => {
    const { db, close } = await fresh();
    const agent = await createAgent(db, { name: "Wide", presetName: "Anchor" });
    // 2,147 chips is where a 32-bit column ran out at six decimals.
    const big = baseUnits(50_000, DEVNET_CHIP_RATE);
    expect(big).toBeGreaterThan(2_147_483_647);
    await record(db, [{ agentId: agent.id, amount: big, reason: "adjustment" }]);

    const balance = await balanceOf(db, agent.id);
    expect(typeof balance).toBe("number");
    expect(balance).toBe(big + 900);

    // The whole devnet supply in one vault: the most any balance could be.
    const supply = baseUnits(1_000_000_000, DEVNET_CHIP_RATE);
    await record(db, [{ agentId: agent.id, amount: supply, reason: "adjustment" }]);
    const total = await balanceOf(db, agent.id);
    expect(total).toBe(big + 900 + supply);
    expect(Number.isSafeInteger(total)).toBe(true);
    await close();
  });

  it("reads one as a number everywhere a balance is summed, not only in balanceOf", async () => {
    const { db, close } = await fresh();
    const owner = someWallet();
    const agent = await createAgent(db, { name: "Summed", presetName: "Hammer", ownerId: owner });
    const big = baseUnits(50_000, DEVNET_CHIP_RATE);
    await record(db, [{ agentId: agent.id, amount: big, reason: "adjustment" }]);
    const expected = big + 900;

    // Every place that sums ledger.amount or chain_ops.amount in raw SQL.
    const many = await balancesOf(db, [agent.id]);
    expect(many.get(agent.id)).toBe(expected);

    // playableBands compares the same sum inside SQL rather than reading it
    // out, so what it proves is that the arithmetic does not overflow: a
    // 32-bit cast raised "integer out of range" on a balance this size.
    const other = await createAgent(db, { name: "Opponent", presetName: "Bully" });
    await record(db, [{ agentId: other.id, amount: big, reason: "adjustment" }]);
    const bands = await playableBands(db, agent.id, owner);
    expect(bands.find((b) => b.band === "B")?.count).toBe(1);

    const view = await publicAgent(db, agent.id);
    expect(typeof view!.balance).toBe("number");
    expect(view!.balance).toBe(expected);

    // committedOutflow sums chain_ops.amount, which is also a bigint now.
    await db.insert(chainOps).values({ kind: "settle", fromAgent: agent.id, amount: big });
    expect(typeof (await hasOutflowRoom(db, agent.id, 60))).toBe("boolean");

    // And the ladder, whose figures come from bigint rating columns.
    const rows = await leaderboard(db, 10);
    for (const row of rows) expect(typeof row.cumulativeNet).toBe("number");
    await close();
  });

  it("reads the live feed's staked total as a number", async () => {
    const { db, close } = await fresh();
    const a = await createAgent(db, { name: "Staker", presetName: "Anchor" });
    const b = await createAgent(db, { name: "Caller", presetName: "Bully" });
    const played = await runMatch(db, a.id, b.id, { seed: 7 });
    const counters = await liveCounters(db, new Date());
    expect(typeof counters.totalStaked).toBe("number");
    expect(counters).toEqual({ matchesToday: 1, totalStaked: played.stake * 2 });
    await close();
  });

  it("reads a bigint column through drizzle as a number too", async () => {
    const { db, close } = await fresh();
    const wallet = someWallet();
    // faucet_grants.amount is a bigint the faucet reads back to decide a wait.
    const status = await faucetStatus(db, wallet, DEVNET_CHIP_RATE);
    expect(typeof status.amount).toBe("number");
    expect(status.available).toBe(true);
    await close();
  });

  it("refuses an integer too large to read exactly, rather than losing its last digits", async () => {
    const parse = pg.types.getTypeParser(20);
    expect(parse(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parse("9223372036854775807")).toThrow(/without losing precision/);
  });
});
