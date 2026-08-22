// One runtime per data directory, and the two ways that goes wrong.
//
// The failure this prevents is not hypothetical: two runtimes were started
// against one directory on this machine, both allocated against the same 25 of
// capital, and the shared wallet drained to 0.22 tUSDC while each process's
// ledger still balanced to itself. What surfaced was twenty-five "not enough
// collateral" errors — a symptom that points at everything except the cause.
//
// The opposite failure matters just as much and is easier to ship: a lock that
// refuses to yield after a hard kill turns every SIGKILL into a manual cleanup
// and an outage. So liveness is checked, not assumed.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, release, alive, lockPath, type LockInfo } from "./lock.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rivo-lock-"));
});
afterEach(() => {
  release(dir);
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that cannot be running: beyond any plausible pid_max. */
const DEAD_PID = 4_194_303;

const writeLock = (info: Partial<LockInfo>): void =>
  writeFileSync(lockPath(dir), JSON.stringify({ pid: DEAD_PID, startedAt: 1, argv: "old", ...info }));

describe("claiming a data directory", () => {
  it("takes a free directory and records who holds it", () => {
    expect(acquire(dir).ok).toBe(true);
    const held = JSON.parse(readFileSync(lockPath(dir), "utf8")) as LockInfo;
    expect(held.pid).toBe(process.pid);
    expect(held.argv.length).toBeGreaterThan(0);
  });

  it("creates the directory if it does not exist yet", () => {
    const fresh = join(dir, "nested");
    expect(acquire(fresh).ok).toBe(true);
    expect(existsSync(lockPath(fresh))).toBe(true);
  });

  it("treats its own pid as its own lock, so a restart in-process is not a deadlock", () => {
    writeLock({ pid: process.pid, argv: "cli/run.ts --data-dir ./data" });
    expect(acquire(dir).ok).toBe(true);
  });

  it("refuses when another live process holds it", () => {
    // pid 1 exists on every POSIX system and is not us. `kill(1, 0)` returns
    // EPERM rather than ESRCH, which the guard must read as alive.
    writeLock({ pid: 1, argv: "cli/run.ts --capital 25 --live" });
    const r = acquire(dir);
    expect(r.ok).toBe(false);
    expect(r.heldBy?.pid).toBe(1);
    expect(r.heldBy?.argv).toContain("--live");
  });
});

describe("a lock whose owner is gone", () => {
  it("is taken over rather than becoming an outage", () => {
    writeLock({ pid: DEAD_PID });
    const r = acquire(dir);
    expect(r.ok).toBe(true);
    // Reported, not silent: an operator should know a previous run died badly.
    expect(r.tookOverFrom?.pid).toBe(DEAD_PID);
  });

  it("is taken over when the file is corrupt", () => {
    writeFileSync(lockPath(dir), "{ not json");
    expect(acquire(dir).ok).toBe(true);
  });
});

describe("releasing", () => {
  it("removes a lock this process owns", () => {
    acquire(dir);
    release(dir);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("leaves somebody else's lock alone", () => {
    // Deleting another runtime's lock is the one mistake this module must never
    // make — it would re-open the exact door the module exists to close.
    writeLock({ pid: 1 });
    release(dir);
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it("does nothing when there is no lock", () => {
    expect(() => release(dir)).not.toThrow();
  });
});

describe("liveness", () => {
  it("knows this process is alive", () => {
    expect(alive(process.pid)).toBe(true);
  });

  it("reads EPERM as alive, because a process we may not signal still exists", () => {
    expect(alive(1)).toBe(true);
  });

  it("knows an impossible pid is not", () => {
    expect(alive(DEAD_PID)).toBe(false);
    expect(alive(0)).toBe(false);
    expect(alive(-1)).toBe(false);
  });
});
