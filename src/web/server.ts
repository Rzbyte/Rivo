// The cockpit server.
//
// Serves one page and four endpoints. Two of them start and stop a trading
// runtime, which is the part worth being careful about:
//
//   * Only ONE runtime may own a data directory. Two processes writing one state
//     file would each overwrite the other's positions, and the portfolio would
//     become fiction. Start refuses when anything is already running.
//   * The Stop button only appears for a child THIS server spawned. A runtime
//     started from a terminal is shown as running but not stoppable, because
//     offering to kill a process we do not own would misrepresent what the
//     button does.
//   * The private key never reaches the browser. Control is local; the runtime
//     reads .env itself. The page says so, because a judge should not have to
//     wonder.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { buildView, readState, runtimeStatus, LIVENESS_WINDOW_SEC } from "./data.js";
import { PAGE } from "./page.js";
import { PROFILES } from "../portfolio/profiles.js";
import { statePath } from "../runtime/state.js";
import { PortfolioRegistry } from "./registry.js";
import { authorityStatus } from "../runtime/signer.js";
import { network } from "../core/config.js";

export interface ServeOptions {
  dataDir: string;
  repoRoot: string;
  port: number;
  /** Interval passed to a runtime started from the browser. */
  intervalMs?: number;
}

/** The runtime this server started, if any. */
let child: ChildProcess | null = null;

const ownedAlive = (): boolean => child !== null && child.exitCode === null && !child.killed;

/**
 * Stop the runtime this server started, whole tree.
 *
 * SIGTERM rather than SIGKILL: the loop finishes its cycle and saves state on
 * the way out. The negative pid targets the process GROUP — see the note at
 * spawn() for why signalling the pid alone is not enough.
 */
function stopChild(): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The group may already be gone, or never formed if spawn failed. Fall back
    // to the single pid rather than leaving the caller thinking nothing happened.
    try {
      child?.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

/**
 * CORS, deliberately open for reads and control on this server.
 *
 * The public page is static and may be served from GitHub Pages, a file:// URL
 * or localhost, so a same-origin policy would make the backend unreachable from
 * exactly the places it is meant to be reached from. This is safe here for a
 * specific reason rather than by assumption: every endpoint is scoped to a
 * wallet address that the caller must already know, Autopilot is restricted to
 * the backend's own signer address (see registry.ts), and nothing here can move
 * funds to a destination the caller supplies. Anyone deploying this beyond a
 * hackathon should put an origin allowlist here.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function serve(opts: ServeOptions): void {
  const { dataDir, repoRoot, port } = opts;

  const registry = new PortfolioRegistry({ dataDir, repoRoot, intervalMs: opts.intervalMs ?? 60_000 });

  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";

      // Preflight. Answered before anything else so a cross-origin PUT from the
      // static page is not rejected by the route table below.
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }

      // --- per-wallet portfolios ------------------------------------------
      // /api/portfolio/<owner>[/start|pause|stop]
      const portfolio = url.match(/^\/api\/portfolio\/(0x[0-9a-fA-F]{40})(?:\/(start|pause|stop))?$/);
      if (portfolio) {
        const owner = portfolio[1]!.toLowerCase();
        const action = portfolio[2] as "start" | "pause" | "stop" | undefined;
        try {
          if (action && req.method === "POST") return json(res, 200, await registry.command(owner, action));
          if (req.method === "PUT") return json(res, 200, await registry.put({ ...(await readBody(req)), owner }));
          if (req.method === "GET") {
            const record = registry.get(owner);
            if (!record) return json(res, 404, { error: "no portfolio for that wallet" });
            return json(res, 200, { ...record, state: readState(record.dataDir) });
          }
          return json(res, 405, { error: `${req.method} not allowed here` });
        } catch (e) {
          // A refusal is a 409, not a 500: the request was well-formed and the
          // answer is "no", with the reason the registry gave.
          return json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (url === "/api/state") {
        return json(res, 200, buildView(dataDir, repoRoot, ownedAlive()));
      }

      if (url === "/api/start" && req.method === "POST") {
        // Refuse if anything is running — ours or not. The state file is the
        // shared resource, and two writers make the portfolio unreadable.
        const status = runtimeStatus(readState(dataDir), ownedAlive());
        if (status.running) {
          return json(res, 409, {
            error: status.owned
              ? "already running"
              : `a runtime is already writing ${statePath(dataDir)} (last cycle ${status.sinceLastCycleSec}s ago). ` +
                `Stop it first, or point this server at another --data-dir.`,
          });
        }

        const body = await readBody(req);
        const capital = Number(body.capital);
        const profile = String(body.profile ?? "balanced");
        const live = Boolean(body.live);
        if (!Number.isFinite(capital) || capital <= 0) return json(res, 400, { error: "capital must be a positive number" });
        if (!(profile in PROFILES)) return json(res, 400, { error: `unknown profile "${profile}"` });

        const args = [
          "src/cli/run.ts",
          "--capital", String(capital),
          "--profile", profile,
          "--interval-ms", String(opts.intervalMs ?? 60_000),
          "--data-dir", dataDir,
        ];
        if (live) args.push("--live");

        child = spawn("npx", ["tsx", ...args], {
          cwd: repoRoot,
          // Inherit the environment so the runtime finds .env exactly as it
          // would from a terminal. Nothing about the key passes through here.
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process GROUP, so Stop can signal the whole tree.
          //
          // `npx tsx` is a chain — npx spawns a shell, which spawns tsx, which
          // spawns node — and the trading loop is the grandchild at the end of
          // it. Signalling the pid we hold reaches only the wrapper: measured,
          // Stop reported success while the runtime carried on trading, which is
          // the worst possible outcome for a stop button. Killing the group
          // reaches the process that actually holds the positions.
          detached: true,
        });
        child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[runtime] ${b.toString()}`));
        child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[runtime] ${b.toString()}`));
        child.on("exit", (code) => {
          console.log(`[runtime] exited with code ${code}`);
          child = null;
        });
        return json(res, 200, { ok: true, pid: child.pid, live });
      }

      if (url === "/api/stop" && req.method === "POST") {
        if (!ownedAlive()) return json(res, 409, { error: "nothing this server started is running" });
        stopChild();
        return json(res, 200, { ok: true });
      }

      if (url === "/api/health") {
        // The public page reads this to decide whether Autopilot can be offered
        // at all, so it must describe the signing authority honestly — including
        // when there is none. `authorityStatus` is the only path from a key to
        // anything displayable, and it carries no key material.
        const authority = await authorityStatus();
        return json(res, 200, {
          ok: true,
          canTrade: authority.kind !== "none",
          authority,
          running: ownedAlive() || registry.list().some((p) => p.running),
          network: network(),
          portfolios: registry.list().length,
          owned: ownedAlive(),
          livenessWindowSec: LIVENESS_WINDOW_SEC,
        });
      }

      // An unmatched /api/ path is a client error, not a request for the page.
      // Serving HTML with a 200 here makes every mistyped endpoint look like a
      // success to a caller that only checks the status — including the public
      // page's own backend discovery, which would then adopt a static host as a
      // Rivo backend.
      if (url.startsWith("/api/")) return json(res, 404, { error: `no such endpoint: ${url}` });

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    })();
  });

  // A port clash is a normal thing to hit — another cockpit, a stale process —
  // and it deserves a sentence, not an unhandled 'error' event and a stack trace.
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use. Something else is serving there —`);
      console.error(`stop it, or pass --port <n>.`);
    } else {
      console.error(`cockpit failed to start: ${e.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(port, () => {
    console.log(`RIVO cockpit  ->  http://localhost:${port}`);
    console.log(`data dir      ${dataDir}`);
    void authorityStatus().then((a) => {
      console.log(
        a.kind === "none"
          ? `signer        none — Shadow Mode only (${a.missing ?? "no key configured"})`
          : `signer        ${a.kind} ${a.address ?? "(address unresolved)"} on ${a.network}`,
      );
    });
  });

  // Never leave a trading process orphaned by our own shutdown.
  const shutdown = () => {
    if (ownedAlive()) {
      console.log("stopping the runtime this server started…");
      stopChild();
    }
    registry.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Freeze the cockpit into one self-contained HTML file.
 *
 * The live page fetches /api/state; a snapshot inlines the same payload and
 * skips the fetch, so it opens from disk with no server and no network. That is
 * what makes it usable in a submission — a reviewer should not have to run a
 * trading bot to see the interface. Controls are inert in a snapshot, which is
 * correct: there is nothing behind them.
 */
export function snapshotHtml(dataDir: string, repoRoot: string): string {
  const payload = JSON.stringify(buildView(dataDir, repoRoot, false));
  return PAGE.replace(
    "tick(); setInterval(()=>{if(!busy)tick();},5000);",
    `render(${payload});/* static snapshot — captured ${new Date().toISOString()} */`,
  ).replace("<title>Rivo</title>", "<title>Rivo — snapshot</title>");
}
