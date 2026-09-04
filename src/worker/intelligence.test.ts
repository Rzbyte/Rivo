// The background half of the loop, and the two ways it can go wrong quietly.
//
// It can run too often — burning the venue's indexer on work nothing asked for.
// And it can run in two places at once, which does not deepen the evidence, it
// doubles it: two workers recording a decision for the same market at the same
// instant produce two rows that look like two independent observations.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { haveDatabase, truncateAll, withSchema } from "../db/testing.js";
import { query, sslFor } from "../db/pool.js";
import { Intelligence } from "./intelligence.js";

describe("cadence", () => {
  it("does nothing until something is due", async () => {
    // A pass that is not due must not even take the lock: the worker calls this
    // every scheduler pass and it has portfolios waiting.
    const intel = new Intelligence({ shadowEverySec: 1_000, calibrateEverySec: 10_000 });
    (intel.health as { lastShadowAt: number }).lastShadowAt = 1_000;
    (intel.health as { lastCalibrationAt: number }).lastCalibrationAt = 1_000;
    await intel.tick(1_100);
    expect(intel.health.shadowPasses).toBe(0);
    expect(intel.health.leading).toBe(false);
  });

  it("keeps shadow and calibration on separate clocks", () => {
    // Calibration reads a month of fills; shadow reads one snapshot. Sharing a
    // cadence would either starve one or hammer the indexer with the other.
    const intel = new Intelligence();
    expect(intel.health.lastShadowAt).toBe(0);
    expect(intel.health.lastCalibrationAt).toBe(0);
  });

  it("starts with a clean health record and no claimed leadership", () => {
    const h = new Intelligence().health;
    expect(h).toMatchObject({
      shadowPasses: 0, shadowDecisions: 0, shadowResolved: 0,
      calibrationRuns: 0, lastError: null, leading: false,
    });
  });
});

/**
 * A second connection, the way a second worker would have one.
 *
 * Built through `sslFor` rather than a bare `new Pool`, because the project has
 * already been caught by this: PGSSLMODE=no-verify in .env forces TLS against a
 * local server that has none, and the error names neither the cause nor the fix.
 */
async function secondConnection() {
  const { Pool } = await import("pg");
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: sslFor(process.env.DATABASE_URL ?? "", process.env.PGSSLMODE ?? "", (process.env.DATABASE_SSL ?? "").toLowerCase() === "off"),
  });
}

describe.skipIf(!haveDatabase())("exactly one worker at a time", () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await withSchema("intel");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it("skips the pass when another worker holds the lock", async () => {
    // Taken on a separate connection, the way a second worker would hold it.
    const other = await secondConnection();
    try {
      const held = await other.query("SELECT pg_try_advisory_lock($1) AS got", [0x52_49_4e_54]);
      // A live worker on this same database holds this exact lock, so a bare
      // `toBe(true)` here reports as a broken product when what happened is that
      // the suite was pointed at a database somebody is already working in.
      expect(
        held.rows[0].got,
        "could not take the intelligence lock: a live worker is already holding it on this database. " +
          "Stop it, or point DATABASE_URL at a database of your own.",
      ).toBe(true);

      // Due, but not this worker's turn. It must return without doing the work
      // and without blocking — a worker waiting here would stall its portfolios.
      const intel = new Intelligence({ shadowEverySec: 0, calibrateEverySec: 1e9 });
      await intel.tick(10_000);
      expect(intel.health.leading).toBe(false);
      expect(intel.health.shadowPasses).toBe(0);
    } finally {
      await other.query("SELECT pg_advisory_unlock($1)", [0x52_49_4e_54]);
      await other.end();
    }
  });

  it("releases the lock even when the pass throws", async () => {
    // With no agents and an unreachable venue the pass fails; the lock must not
    // survive it, or one bad pass silences the whole fleet forever.
    const intel = new Intelligence({ shadowEverySec: 0, calibrateEverySec: 1e9, out: () => undefined });
    await intel.tick(10_000);

    const other = await secondConnection();
    try {
      const got = await other.query("SELECT pg_try_advisory_lock($1) AS got", [0x52_49_4e_54]);
      expect(
        got.rows[0].got,
        "the lock must have been released — unless a live worker on this database is holding it, " +
          "in which case stop it or use a database of your own",
      ).toBe(true);
      await other.query("SELECT pg_advisory_unlock($1)", [0x52_49_4e_54]);
    } finally {
      await other.end();
    }
  });

  it("records a failure without throwing out of tick", async () => {
    // The worker calls this inside a trading pass. A rejection here would end
    // the pass for every portfolio the worker holds.
    const intel = new Intelligence({ shadowEverySec: 0, calibrateEverySec: 1e9, out: () => undefined });
    await expect(intel.tick(10_000)).resolves.toBeUndefined();
  });

  it("does no shadow work when no agents are registered", async () => {
    await query(`DELETE FROM agents`);
    const intel = new Intelligence({ shadowEverySec: 0, calibrateEverySec: 1e9, out: () => undefined });
    await intel.tick(10_000);
    const [c] = await query<{ n: string }>(`SELECT count(*)::text n FROM shadow_decisions`);
    expect(c!.n).toBe("0");
  });
});
