// Migrations.
//
// Plain SQL files, applied in filename order, each inside its own transaction,
// each recorded once. No ORM and no migration framework: the schema is the part
// of this system that most needs to be readable by somebody who did not write
// it, and a directory of .sql files is the most readable form there is.
//
// Two properties worth stating because they are what make it safe to run
// migrations on worker boot rather than as a separate deploy step:
//
//   * An advisory lock serialises the whole run, so a fleet of workers starting
//     at once produces one migrator and N waiters, not N racing migrators.
//   * Every file's checksum is stored. A file that changed after it was applied
//     is refused rather than silently ignored, because "already applied" for a
//     file whose contents have moved is a lie that surfaces months later as a
//     column that does not exist.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { db, safeTarget } from "./pool.js";

/** Postgres advisory lock id. Arbitrary, constant, and Rivo's alone. */
const LOCK_ID = 0x52_49_56_4f; // "RIVO"

/**
 * Where the .sql files are, whether or not a bundler has been through the code.
 *
 * `import.meta.url` is the right answer under Node and the wrong one after
 * webpack: Next inlines it to the path the BUILD ran at, so a serverless
 * function looked for /vercel/path0/src/db/migrations and threw ENOENT. That
 * surfaced as /api/health reporting "the database did not answer" while the
 * database was answering perfectly — the failure was three layers from the
 * message, and cost a deploy cycle to find.
 *
 * So the module path is a candidate rather than the answer, and the runtime
 * working directory is tried after it. If none of them exist the error names
 * every path attempted, because the previous version's error named one path
 * that was never going to be right.
 */
export const migrationsDir = (): string => {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "migrations"),
    join(process.cwd(), "src", "db", "migrations"),
    join(process.cwd(), "..", "src", "db", "migrations"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`no migrations directory found. Tried: ${candidates.join(", ")} (cwd ${process.cwd()})`);
};

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = migrationsDir()): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16) };
    });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

async function ensureTable(c: PoolClient): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Bring the database up to date. Safe to call concurrently and safe to call on
 * every boot: an up-to-date database is a no-op and two round-trips.
 */
export async function migrate(dir = migrationsDir()): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);
  const client = await db().connect();
  const out: MigrateResult = { applied: [], alreadyApplied: [] };
  try {
    // Blocks until whoever else is migrating finishes. Released when the session
    // ends, so a migrator that dies mid-run does not wedge the fleet.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await ensureTable(client);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const m of migrations) {
      const seen = done.get(m.name);
      if (seen) {
        if (seen !== m.checksum) {
          throw new Error(
            `migration ${m.name} was applied with checksum ${seen} but the file on disk is ${m.checksum}. ` +
              `Applied migrations are immutable — add a new file instead of editing this one.`,
          );
        }
        out.alreadyApplied.push(m.name);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await client.query("COMMIT");
        out.applied.push(m.name);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(
          `migration ${m.name} failed against ${safeTarget()}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/**
 * Whether the schema is current, without changing anything.
 *
 * The web app calls this rather than `migrate`: a Vercel function racing a
 * worker to alter a schema is a class of outage worth designing out, so exactly
 * one component migrates and everything else checks.
 */
export async function pending(dir = migrationsDir()): Promise<string[]> {
  const migrations = loadMigrations(dir);
  const client = await db().connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    return migrations.filter((m) => !done.has(m.name)).map((m) => m.name);
  } finally {
    client.release();
  }
}
