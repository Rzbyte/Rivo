// One runtime per data directory.
//
// This exists because the alternative was measured, on this machine, with real
// money. Two runtimes were started against `./data-agent` — a restart where the
// previous process had not actually died — and they both allocated against the
// same 25 of capital and sent orders from the same wallet. The wallet drained to
// 0.22 tUSDC while each process's state file still claimed ~18 of cash, and the
// symptom that surfaced was twenty-five "not enough collateral" errors, which
// points at everything except the cause.
//
// The hazard is documented in compose.yaml as the reason the headless autopilot
// sits behind a profile. Documenting it did not prevent it. A lock does.
//
// Deliberately a file rather than anything cleverer: the state it guards is a
// file in the same directory, so a lock that lives beside it fails in the same
// ways and survives the same copies. No daemon, no port, no registry.
//
// The subtle part is a STALE lock. A process killed with SIGKILL leaves its lock
// behind, and refusing to start after a hard kill would be its own outage — so
// the holder's liveness is checked rather than assumed, and a lock whose owner is
// gone is taken over with a line in the log rather than silently.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  startedAt: number;
  /** Which command took it, so the error message can name what to stop. */
  argv: string;
}

export const lockPath = (dataDir: string): string => join(dataDir, "runtime.lock");

/**
 * Whether a process is alive, without signalling it.
 *
 * `kill(pid, 0)` performs the permission and existence checks and delivers
 * nothing. EPERM means it exists and belongs to somebody else — still alive, so
 * still a reason to refuse.
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AcquireResult {
  ok: boolean;
  /** Set when the lock could not be taken: who holds it. */
  heldBy?: LockInfo;
  /** Set when a dead holder's lock was taken over, for the log. */
  tookOverFrom?: LockInfo;
}

/**
 * Claim the data directory, or report who has it.
 *
 * Not atomic against a simultaneous start of two processes in the same
 * millisecond, and deliberately not: `wx` would be, but it turns every stale
 * lock into a manual cleanup, which is the failure mode operators actually hit.
 * The race this guards against is a human restarting a runtime that is still
 * running, which is seconds wide, not milliseconds.
 */
export function acquire(dataDir: string, now = Date.now()): AcquireResult {
  const path = lockPath(dataDir);
  let tookOverFrom: LockInfo | undefined;

  if (existsSync(path)) {
    let held: LockInfo | null = null;
    try {
      held = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    } catch {
      held = null; // unreadable: treat as stale rather than as a wall
    }
    if (held && alive(held.pid) && held.pid !== process.pid) return { ok: false, heldBy: held };
    if (held) tookOverFrom = held;
  }

  mkdirSync(dataDir, { recursive: true });
  const mine: LockInfo = { pid: process.pid, startedAt: Math.floor(now / 1000), argv: process.argv.slice(1).join(" ") };
  writeFileSync(path, JSON.stringify(mine, null, 2) + "\n");
  return { ok: true, ...(tookOverFrom ? { tookOverFrom } : {}) };
}

/**
 * Give the directory back.
 *
 * Only removes a lock this process owns. A crashed-and-restarted runtime that
 * inherited the same pid is vanishingly unlikely, but deleting somebody else's
 * lock is the one mistake this module must never make.
 */
export function release(dataDir: string): void {
  const path = lockPath(dataDir);
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    if (held.pid === process.pid) unlinkSync(path);
  } catch {
    /* no lock, unreadable, or not ours — nothing to do in every case */
  }
}
