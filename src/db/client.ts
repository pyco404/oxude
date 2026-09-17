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

/** Applies every migration in order. Drizzle-kit owns the SQL; this just runs it. */
export async function migrate(db: Db, dir = "drizzle"): Promise<void> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    for (const statement of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await db.execute(sql.raw(trimmed));
    }
  }
}
