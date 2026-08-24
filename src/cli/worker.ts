// `npm run worker` — the execution plane.
//
// This is the process that makes the product's central claim true: configure
// once, close the browser, and Rivo keeps managing the portfolio. It runs
// somewhere that stays up — a container on Railway, Render, Fly, or a VPS —
// and it is emphatically NOT a serverless function, because a trading cycle is
// not a request and a portfolio is not stateless between them.
//
//   npm run worker                    # the fleet loop
//   npm run worker -- --once          # one scheduler pass, then exit
//   npm run worker -- --interval 30   # seconds between passes over a portfolio
//
// A health endpoint comes up alongside it, because a platform that cannot ask
// "are you alive" will restart the process on a schedule of its own invention.

import { createServer } from "node:http";
import { loadEnv } from "../core/env.js";
import { configured, safeTarget } from "../db/pool.js";
import { liveWorkers } from "../db/leases.js";
import { Worker, VENUE_DOWN_AFTER } from "../worker/worker.js";

const arg = (flag: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

async function main(): Promise<void> {
  loadEnv();
  if (!configured()) {
    console.error("DATABASE_URL is not set.");
    console.error("");
    console.error("The worker is the multi-user execution plane and needs a database.");
    console.error("For one local portfolio with no database, use `npm start` instead.");
    console.error("For a database in twenty seconds with no Docker: npx tsx scripts/dev-postgres.ts start");
    process.exitCode = 1;
    return;
  }

  const worker = new Worker({
    intervalSec: Number(arg("--interval", "45")),
    concurrency: Number(arg("--concurrency", "8")),
    // Shadow, settlement resolution and calibration refresh, in the same
    // process as the scheduler. On by default in a long-lived worker, because
    // "every settled Event Contract becomes new evidence" cannot depend on
    // somebody keeping a terminal open. Off for `--once`, which is a smoke
    // test of the scheduler and has no business reading a month of fills.
    intelligence: !process.argv.includes("--once") && !process.argv.includes("--no-intelligence"),
    ...(process.argv.includes("--once") ? { maxPasses: 1 } : {}),
  });

  // --- health ------------------------------------------------------------
  //
  // Two distinct questions, deliberately separated. `/health` asks whether this
  // process is up, and is what a platform's restart policy should read.
  // `/ready` asks whether it is doing its job, which is a different thing: a
  // worker that is up and has not completed a pass in five minutes is not
  // healthy in any sense a user would recognise.
  const port = Number(arg("--health-port", process.env.PORT ?? "8080"));
  const server = createServer((req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const since = worker.health.lastPassAt === 0 ? null : now - worker.health.lastPassAt;
    const stalled = since !== null && since > 300;
    // Two different questions, and a health endpoint that conflates them is
    // worse than none: `secondsSinceLastPass` says the process is ticking,
    // `secondsSinceSuccessfulCycle` says the work is getting done. A worker can
    // tick happily for an hour while every cycle fails against a dead indexer.
    const sinceCycle =
      worker.health.lastSuccessfulCycleAt === 0 ? null : now - worker.health.lastSuccessfulCycleAt;
    const body = {
      ok: !stalled,
      workerId: worker.health.workerId,
      uptimeSec: now - worker.health.startedAt,
      passes: worker.health.passes,
      cycles: worker.health.cycles,
      failures: worker.health.failures,
      secondsSinceLastPass: since,
      secondsSinceSuccessfulCycle: sinceCycle,
      consecutiveCycleFailures: worker.health.consecutiveCycleFailures,
      venueReachable: worker.health.consecutiveCycleFailures < VENUE_DOWN_AFTER,
      lastError: worker.health.lastError,
      intelligence: worker.intelligenceHealth,
      database: safeTarget(),
    };
    if (req.url === "/ready") {
      // Include the fleet, so one worker's health endpoint answers "is Rivo
      // running" rather than only "am I running".
      void liveWorkers()
        .then((fleet) => {
          res.writeHead(stalled ? 503 : 200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...body, fleet: fleet.length }, null, 2));
        })
        .catch((e) => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...body, ok: false, error: String(e instanceof Error ? e.message : e) }));
        });
      return;
    }
    res.writeHead(stalled ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  });
  // Loopback unless told otherwise. The endpoint reports fleet state and a
  // database host, which is not sensitive but is nobody else's business either.
  server.listen(port, process.env.RIVO_HEALTH_HOST ?? "0.0.0.0", () => {
    console.log(`health     http://localhost:${port}/health  and  /ready`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    // A worker that cannot bind its health port should still trade. The port is
    // for the platform's benefit, and refusing to run without it would turn a
    // monitoring inconvenience into an outage.
    console.warn(`health endpoint unavailable (${e.code ?? e.message}) — the worker continues without it`);
  });

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig} — finishing the cycles in flight, releasing leases, then stopping.`);
    void worker.shutdown().then(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await worker.start();
  await worker.shutdown();
  server.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
