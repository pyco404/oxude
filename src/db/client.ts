import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import * as schema from "./schema.js";

/** Either driver, through the query builder they share. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A real Postgres when DATABASE_URL is set (docker-compose provides one),
 * otherwise an embedded PGlite, so tests and a local run need no server.
 */
export async function connect(url = process.env["DATABASE_URL"]): Promise<{ db: Db; close: () => Promise<void> }> {
  if (url) {
    const pool = new Pool({ connectionString: url });
    return { db: drizzlePg(pool, { schema }), close: () => pool.end() };
  }
  const client = new PGlite();
  return { db: drizzlePglite(client, { schema }), close: () => client.close() };
}

/**
 * Applies each migration not yet applied, in order, recording it in the same
 * transaction, so a persistent database can be migrated on every start.
 * Drizzle-kit owns the SQL; this just runs it.
 */
export async function migrate(db: Db, dir = "drizzle"): Promise<void> {
  await db.execute(
    sql.raw("CREATE TABLE IF NOT EXISTS oxude_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"),
  );
  const applied = new Set(
    ((await db.execute(sql.raw("SELECT name FROM oxude_migrations"))) as unknown as { rows: { name: string }[] }).rows.map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
  for (const file of files) {
    await db.transaction(async (tx) => {
      for (const statement of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await tx.execute(sql.raw(trimmed));
      }
      await tx.execute(sql`INSERT INTO oxude_migrations (name) VALUES (${file})`);
    });
  }
}
