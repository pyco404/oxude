import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

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

/** Applies the schema. Drizzle-kit owns the SQL; this just runs it. */
export async function migrate(db: Db, file = "drizzle/0000_init.sql"): Promise<void> {
  const ddl = readFileSync(file, "utf8");
  for (const statement of ddl.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await db.execute(sql.raw(trimmed));
  }
}
