import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { connect, migrate } from "../src/db/client.js";
import { agents, matches, seasons } from "../src/db/schema.js";
import { seasonAt } from "../src/season.js";

/** The migrations up to (not including) `upTo`, in a directory of their own. */
function migrationsBefore(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oxude-migrations-"));
  for (const f of readdirSync("drizzle")) if (f.endsWith(".sql") && f < upTo) cpSync(join("drizzle", f), join(dir, f));
  return dir;
}

describe("migration 0014: seasons", () => {
  it("opens the current season, and puts every agent in play and this season's matches in it", async () => {
    const { db, close } = await connect();
    await migrate(db, migrationsBefore("0014"));
    // Raw SQL: the schema in code already has the columns this migration adds.
    const insertAgent = async (name: string, owner: string | null, retired = false) => {
      const res = (await db.execute(sql`insert into agents (name, preset_name, owner_id, retired_at)
        values (${name}, 'Anchor', ${owner}, ${retired ? sql`now()` : sql`null`}) returning id`)) as unknown as { rows: { id: string }[] };
      return res.rows[0]!.id;
    };
    const playing = await insertAgent("Playing", "owner-1");
    const house = await insertAgent("House", null);
    const broke = await insertAgent("Broke", "owner-2", true);
    const withdrawn = await insertAgent("Withdrawn", "owner-3", true);
    await db.execute(sql`insert into withdrawals (agent_id, owner_id, amount, remaining, retire, prepared_tx, last_valid_block_height, status)
      values (${withdrawn}, 'owner-3', 900, 0, true, '', 0, 'confirmed')`);
    const match = async (createdAt: string) => {
      const res = (await db.execute(sql`insert into matches (agent_a, agent_b, seed, rules_config, winner, net_a, net_b, log, created_at)
        values (${playing}, ${house}, 1, '{}'::jsonb, 'A', 4, -4, '{"rounds":[]}'::jsonb, ${createdAt}::timestamptz) returning id`)) as unknown as { rows: { id: string }[] };
      return res.rows[0]!.id;
    };
    const before = await match("2026-09-20T23:00:00Z");
    const during = await match("2026-09-22T09:00:00Z");

    await migrate(db);
    const current = seasonAt(new Date());
    const [row] = await db.select().from(seasons).where(eq(seasons.key, current.key));
    expect(row!.status).toBe("open");
    expect(row!.endsAt.getTime()).toBe(current.end.getTime());

    const reload = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    expect((await reload(playing)).rentalEndsAt?.getTime()).toBe(current.end.getTime());
    expect((await reload(house)).rentalEndsAt).toBeNull();
    expect((await reload(broke)).rentalEndsAt).toBeNull();
    expect((await reload(broke)).retiredReason).toBe("broke");
    expect((await reload(withdrawn)).retiredReason).toBe("withdrawn");
    expect((await reload(playing)).retiredReason).toBeNull();

    const seasonOf = async (id: string) => (await db.select({ s: matches.season }).from(matches).where(eq(matches.id, id)))[0]!.s;
    expect(await seasonOf(before)).toBeNull();
    expect(await seasonOf(during)).toBe("2026-09-21");
    // Applied once: running migrate again adds no second season row.
    await migrate(db);
    expect(await db.select().from(seasons)).toHaveLength(1);
    await close();
  });
});
