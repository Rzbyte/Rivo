// Integration-test plumbing for the database layer.
//
// These tests run against a REAL PostgreSQL, and that is a deliberate choice
// rather than an unavoidable one. Everything the durable layer is relied upon
// for — a fenced lease, `FOR UPDATE SKIP LOCKED`, an append-only trigger, an
// optimistic-concurrency retry, `ON CONFLICT` against a partial index — is
// behaviour of the server. An in-memory emulator agrees with all of it right up
// until production disagrees, and a test that can only fail in production is not
// a test.
//
// The price is that they need a database, so they SKIP when DATABASE_URL is
// absent. Nothing else in the suite does, and nothing else needs to:
//
//   npx tsx scripts/dev-postgres.ts start     # no docker, no root
//   export DATABASE_URL=postgres://rivo@127.0.0.1:55432/rivo
//   npm test
//
// Isolation is per schema, not per database. Each test file asks for its own
// namespace and gets its own copy of the whole schema inside it, so files can
// run in parallel without truncating each other's rows.

import { closeDb, db, query } from "./pool.js";
import { migrate } from "./migrate.js";

/** Whether the database-backed tests can run at all. */
export const haveDatabase = (): boolean => Boolean(process.env.DATABASE_URL?.trim());

/**
 * Point this process's pool at a private schema, migrated and empty.
 *
 * Returns a teardown. Call it, or the process keeps a pool open and vitest hangs
 * waiting for a handle that will never close.
 */
export async function withSchema(name: string): Promise<() => Promise<void>> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("withSchema needs DATABASE_URL; guard the suite with haveDatabase()");
  const schema = `test_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;

  // Create the schema on a connection that is not yet pinned to it. A
  // search_path naming a schema that does not exist is legal — queries simply
  // find nothing — so this is safe to do through the same URL.
  await closeDb();
  process.env.DATABASE_URL = base;
  await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await query(`CREATE SCHEMA ${schema}`);
  await closeDb();

  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  await migrate();
  // Prove the pinning worked before any test trusts it. Getting this wrong
  // silently means a test suite quietly migrating and truncating the real
  // schema, which is the one mistake worth a round-trip to rule out.
  const pinned = await query<{ current: string }>("SELECT current_schema()::text AS current");
  const current = pinned[0]?.current;
  if (current !== schema) throw new Error(`expected to be pinned to ${schema}, got ${current}`);

  return async () => {
    await closeDb();
    process.env.DATABASE_URL = base;
    await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await closeDb();
    process.env.DATABASE_URL = base;
  };
}

/** Empty every table without dropping the schema. TRUNCATE, so append-only triggers do not fire. */
export async function truncateAll(): Promise<void> {
  await query("TRUNCATE users, workers RESTART IDENTITY CASCADE");
}

/** A user, a portfolio wallet and a portfolio — the minimum any other row needs. */
export async function seedPortfolio(over: { capital?: number; mode?: string; state?: string } = {}): Promise<{
  userId: string;
  walletId: string;
  portfolioId: string;
}> {
  const [u] = await query<{ id: string }>(
    "INSERT INTO users (privy_did) VALUES ($1) RETURNING id",
    [`did:privy:${Math.random().toString(36).slice(2)}`],
  );
  const address = `0x${Math.floor(Math.random() * 1e16).toString(16).padStart(40, "0")}`.slice(0, 42);
  const [w] = await query<{ id: string }>(
    "INSERT INTO wallets (user_id, address, privy_wallet_id, kind, delegated) VALUES ($1, $2, $3, 'portfolio', true) RETURNING id",
    [u!.id, address.toLowerCase(), `pw_${Math.random().toString(36).slice(2)}`],
  );
  const [p] = await query<{ id: string }>(
    `INSERT INTO portfolios (user_id, wallet_id, network, capital, profile, mode, state)
     VALUES ($1, $2, 'testnet', $3, 'balanced', $4, $5) RETURNING id`,
    [u!.id, w!.id, over.capital ?? 50, over.mode ?? "autopilot", over.state ?? "running"],
  );
  await query("INSERT INTO portfolio_runtime (portfolio_id, cash, peak_equity) VALUES ($1, $2, $2)", [
    p!.id,
    over.capital ?? 50,
  ]);
  await query("INSERT INTO portfolio_leases (portfolio_id) VALUES ($1)", [p!.id]);
  return { userId: u!.id, walletId: w!.id, portfolioId: p!.id };
}

/** The pool, for tests that need to hold a client open (lock contention, say). */
export const pool = db;
