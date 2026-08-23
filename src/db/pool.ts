// The connection to durable state.
//
// One pool per process, created on first use and never before: the CLI, the
// backtester and every existing test run with no database at all, and importing
// this module must not change that. `configured()` is the only thing they touch.
//
// Nothing here logs a connection string. A DATABASE_URL carries a password, and
// a stack trace that prints one has published it to every log sink downstream —
// so the error paths below name the host and nothing else.

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { loadEnv } from "../core/env.js";

// Read `.env` here, where DATABASE_URL is read.
//
// `src/core/config.ts` already does this on import, with a comment saying no
// entry point can forget it — and then `npm run report -- --portfolio <id>`
// forgot, because it never imports config. It answered "--portfolio needs
// DATABASE_URL" against a database that was configured perfectly, which is the
// most confusing shape a missing-configuration error can take.
//
// Loading it in the module that actually needs the variable means any entry
// point reaching the pool has it, whether or not it went past config first.
// `loadEnv` is idempotent and never overwrites a variable already set, so this
// is inert on Vercel, in Docker, and anywhere the platform supplies them.
loadEnv();

let pool: Pool | null = null;

/** Whether a database is configured at all. False is a normal, supported state. */
export const configured = (): boolean => Boolean(process.env.DATABASE_URL?.trim());

/** The host a connection string points at, for error messages that must not carry the password. */
export function safeTarget(url = process.env.DATABASE_URL ?? ""): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * TLS policy.
 *
 * Every managed provider Rivo targets — Neon, Supabase, Railway, RDS — serves
 * TLS, and most present a certificate chained to a root the container may not
 * carry. `PGSSLMODE=no-verify` is the documented escape hatch for that case and
 * is what a hosted deployment normally needs; `DATABASE_SSL=off` is for a local
 * postgres with no TLS at all. Neither is the default: the default is to verify.
 */
export function sslFor(url: string, mode: string, off: boolean): { rejectUnauthorized: boolean } | false {
  const m = mode.toLowerCase();
  if (off || m === "disable") return false;
  // Loopback wins over PGSSLMODE, deliberately.
  //
  // Nothing on loopback leaves the machine, and a local server usually has no
  // TLS at all. The gate used to be "loopback AND no PGSSLMODE set", which
  // broke the most ordinary development setup there is: a managed database in
  // .env (so PGSSLMODE=no-verify) and DATABASE_URL pointed at localhost to run
  // the tests. That forced TLS against a server without it and failed with
  // "The server does not support SSL connections" — a message that names
  // neither the cause nor the fix, and which surfaced as twenty-one tests
  // silently skipping rather than as an error anybody would read.
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return false;
  return { rejectUnauthorized: m !== "no-verify" };
}

const ssl = (): { rejectUnauthorized: boolean } | false =>
  sslFor(
    process.env.DATABASE_URL ?? "",
    process.env.PGSSLMODE ?? "",
    (process.env.DATABASE_SSL ?? "").toLowerCase() === "off",
  );

export function db(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. The web app and the worker both need one; " +
        "the CLI, the backtester and the test suite do not — they use the file store.",
    );
  }
  pool = new Pool({
    connectionString: url,
    ssl: ssl(),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    // A query that hangs holds a lease open, and a lease held open blocks the
    // portfolio's next cycle. Better to fail the cycle and retry than to stall
    // the fleet behind one bad connection.
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 30_000),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000),
  });
  // An idle client erroring (a provider recycling connections, a network blip)
  // arrives as an 'error' event with no listener, which in Node is an uncaught
  // exception — and taking down a trading worker because a spare connection was
  // reaped is the wrong end of the trade-off.
  pool.on("error", (e) => console.warn(`postgres idle client error (${safeTarget()}): ${e.message}`));
  return pool;
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const res = await db().query<R>(text, params);
  return res.rows;
}

/** The single row a query must return, or an error naming what was expected. */
export async function one<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R> {
  const rows = await query<R>(text, params);
  if (rows.length !== 1) throw new Error(`expected exactly 1 row, got ${rows.length}`);
  return rows[0]!;
}

/** The first row, or null. */
export async function maybe<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R | null> {
  const rows = await query<R>(text, params);
  return rows[0] ?? null;
}

/**
 * Run inside a transaction, rolling back on any throw.
 *
 * Used wherever two tables must agree — a fill that both closes a position and
 * finalises its execution row, a lease acquired alongside the runtime read it
 * authorises. Half of either is a corrupt portfolio.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is already gone; the transaction died with it */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Close the pool. Tests and one-shot scripts need this or the process hangs. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

/**
 * Postgres `numeric` arrives as a string, because a float cannot hold every
 * value it can. Rivo's engine is float arithmetic throughout, so the conversion
 * happens once, here, at the boundary — rather than in forty call sites where
 * one of them would forget and start concatenating money.
 */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** Unix seconds from a timestamptz, which is what the engine speaks. */
export const secs = (v: unknown): number => (v instanceof Date ? Math.floor(v.getTime() / 1000) : 0);
export const secsOrNull = (v: unknown): number | null => (v instanceof Date ? Math.floor(v.getTime() / 1000) : null);
/** A timestamptz from unix seconds, for the other direction. */
export const at = (s: number | null | undefined): Date | null =>
  s === null || s === undefined || !Number.isFinite(s) ? null : new Date(s * 1000);
