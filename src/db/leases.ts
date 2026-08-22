// One worker per portfolio, across a fleet.
//
// The file lock in src/runtime/lock.ts solves this for one machine, and it
// solves it well: a PID file, a liveness check, and a takeover when the holder
// is demonstrably gone. What it cannot do is span machines, and the failure it
// prevents is the expensive one — two runtimes on one portfolio each allocate
// against the same capital and send orders from the same wallet, which was
// measured once and drained the wallet while each process's ledger still looked
// correct to itself.
//
// So the same idea, moved to where every worker can see it:
//
//   LEASE      a row per portfolio, taken by a conditional UPDATE. Two workers
//              racing produce one winner and one empty result, because the
//              database serialises them; there is no window between check and
//              take.
//   EXPIRY     a lease is time-bounded and renewed mid-cycle. A worker that is
//              killed, OOMs or loses its network releases what it held without
//              anybody intervening, which is the property a PID file cannot have
//              across machines.
//   FENCE      a counter that only ever increases. A worker that stalls past its
//              expiry, loses the lease to someone else, and then wakes up still
//              believing it holds one presents a stale fence and is refused.
//              Without this, the timeout does not make things safer — it just
//              moves the collision later.

import { maybe, one, query, secs } from "./pool.js";

/** How long a lease is good for. A cycle is seconds; this is generous against a slow one. */
export const LEASE_TTL_SEC = 120;

export interface Lease {
  portfolioId: string;
  workerId: string;
  fence: number;
  expiresAt: number;
}

export interface WorkerIdentity {
  id: string;
  hostname: string;
  pid: number;
}

/** Announce this process to the fleet. One row per worker per start. */
export async function registerWorker(hostname: string, pid: number, version?: string): Promise<WorkerIdentity> {
  const r = await one<{ id: string }>(
    "INSERT INTO workers (hostname, pid, version) VALUES ($1, $2, $3) RETURNING id",
    [hostname, pid, version ?? null],
  );
  return { id: r.id, hostname, pid };
}

/**
 * Say the worker is alive.
 *
 * Separate from lease renewal on purpose. A worker can be alive and holding
 * nothing, and an operator needs to be able to tell "the fleet is down" from
 * "the fleet is up and every portfolio is paused" — which is the same view from
 * the outside if the only signal is lease activity.
 */
export async function heartbeat(workerId: string, note?: string): Promise<void> {
  await query(
    "UPDATE workers SET last_heartbeat_at = now(), cycles = cycles + 1, note = COALESCE($2, note) WHERE id = $1",
    [workerId, note ?? null],
  );
}

/** Workers whose heartbeat is recent enough to believe. */
export async function liveWorkers(withinSec = LEASE_TTL_SEC): Promise<
  { id: string; hostname: string; pid: number; lastHeartbeatAt: number; cycles: number }[]
> {
  const rows = await query<{
    id: string;
    hostname: string;
    pid: number;
    last_heartbeat_at: Date;
    cycles: string;
  }>(
    `SELECT id, hostname, pid, last_heartbeat_at, cycles FROM workers
      WHERE last_heartbeat_at > now() - make_interval(secs => $1) ORDER BY last_heartbeat_at DESC`,
    [withinSec],
  );
  return rows.map((r) => ({
    id: r.id,
    hostname: r.hostname,
    pid: r.pid,
    lastHeartbeatAt: secs(r.last_heartbeat_at),
    cycles: Number(r.cycles),
  }));
}

/**
 * Take leases on up to `limit` portfolios that are due.
 *
 * `FOR UPDATE ... SKIP LOCKED` on the LEASE row is what makes this a queue
 * rather than a stampede: workers running this statement at the same instant
 * each get a different set, and none of them waits on another. Ordering by
 * `next_run_at` means the portfolio that has waited longest is served first.
 *
 * A portfolio is only claimable when its lease is free — never taken, expired,
 * or explicitly released. An unexpired lease held by a worker that is genuinely
 * dead stays held until it expires, which is the correct trade: waiting a minute
 * costs a cycle, and taking it early costs a double order.
 */
export async function claimDue(workerId: string, limit = 10, ttlSec = LEASE_TTL_SEC): Promise<Lease[]> {
  const rows = await query<{ portfolio_id: string; fence: string; expires_at: Date }>(
    `WITH due AS (
       SELECT l.portfolio_id
         FROM portfolio_leases l
         JOIN portfolios p ON p.id = l.portfolio_id
        WHERE p.state = 'running'
          AND p.next_run_at <= now()
          AND (l.expires_at IS NULL OR l.expires_at <= now())
        ORDER BY p.next_run_at
        LIMIT $2
        FOR UPDATE OF l SKIP LOCKED
     )
     UPDATE portfolio_leases l
        SET worker_id = $1, fence = l.fence + 1, acquired_at = now(),
            expires_at = now() + make_interval(secs => $3), released_at = NULL
       FROM due
      WHERE l.portfolio_id = due.portfolio_id
      RETURNING l.portfolio_id, l.fence, l.expires_at`,
    [workerId, Math.max(1, limit), ttlSec],
  );
  return rows.map((r) => ({
    portfolioId: r.portfolio_id,
    workerId,
    fence: Number(r.fence),
    expiresAt: secs(r.expires_at),
  }));
}

/** Take one specific portfolio, regardless of schedule. Used by "run this now". */
export async function claim(workerId: string, portfolioId: string, ttlSec = LEASE_TTL_SEC): Promise<Lease | null> {
  const r = await maybe<{ portfolio_id: string; fence: string; expires_at: Date }>(
    `UPDATE portfolio_leases
        SET worker_id = $1, fence = fence + 1, acquired_at = now(),
            expires_at = now() + make_interval(secs => $3), released_at = NULL
      WHERE portfolio_id = $2 AND (expires_at IS NULL OR expires_at <= now())
      RETURNING portfolio_id, fence, expires_at`,
    [workerId, portfolioId, ttlSec],
  );
  return r
    ? { portfolioId: r.portfolio_id, workerId, fence: Number(r.fence), expiresAt: secs(r.expires_at) }
    : null;
}

/**
 * Extend a lease mid-cycle.
 *
 * Returns false when the lease is no longer ours, and the caller must treat that
 * as fatal to the cycle. Carrying on would mean writing state for a portfolio
 * somebody else is now running, which is exactly the collision the lease exists
 * to prevent — arriving late instead of early.
 */
export async function renew(lease: Lease, ttlSec = LEASE_TTL_SEC): Promise<boolean> {
  const r = await maybe<{ portfolio_id: string }>(
    `UPDATE portfolio_leases SET expires_at = now() + make_interval(secs => $4)
      WHERE portfolio_id = $1 AND worker_id = $2 AND fence = $3 AND released_at IS NULL
      RETURNING portfolio_id`,
    [lease.portfolioId, lease.workerId, lease.fence, ttlSec],
  );
  return r !== null;
}

/** Whether this lease is still the current one. A read, for guarding a write. */
export async function held(lease: Lease): Promise<boolean> {
  const r = await maybe<{ ok: boolean }>(
    `SELECT (worker_id = $2 AND fence = $3 AND released_at IS NULL AND expires_at > now()) AS ok
       FROM portfolio_leases WHERE portfolio_id = $1`,
    [lease.portfolioId, lease.workerId, lease.fence],
  );
  return r?.ok === true;
}

/**
 * Give a lease back.
 *
 * Fenced like every other write: a worker that lost its lease and then finished
 * its cycle must not be able to release the lease somebody else now holds.
 */
export async function release(lease: Lease): Promise<void> {
  await query(
    `UPDATE portfolio_leases SET released_at = now(), expires_at = now()
      WHERE portfolio_id = $1 AND worker_id = $2 AND fence = $3`,
    [lease.portfolioId, lease.workerId, lease.fence],
  );
}

/** Release everything this worker holds. Called on shutdown, so a redeploy does not idle the fleet. */
export async function releaseAll(workerId: string): Promise<number> {
  const rows = await query<{ portfolio_id: string }>(
    `UPDATE portfolio_leases SET released_at = now(), expires_at = now()
      WHERE worker_id = $1 AND released_at IS NULL RETURNING portfolio_id`,
    [workerId],
  );
  return rows.length;
}
