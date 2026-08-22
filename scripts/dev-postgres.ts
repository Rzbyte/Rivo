// A real PostgreSQL for local development, without Docker and without root.
//
// The database tests in this repository are integration tests on purpose: a
// fenced lease, `FOR UPDATE SKIP LOCKED`, an append-only trigger and an
// optimistic-concurrency retry are all things an in-memory emulator will happily
// agree with while the real server disagrees. So the tests skip when no
// DATABASE_URL is set, and this script is the shortest path to setting one.
//
// It downloads the self-contained PostgreSQL binaries the JVM ecosystem
// publishes for exactly this purpose, unpacks them under `.rivo/pg`, and runs a
// server on a private port with trust auth, bound to loopback. It is a
// DEVELOPMENT tool: trust auth on a public interface would be a gift to
// strangers, so it never binds one.
//
//   npx tsx scripts/dev-postgres.ts start     # prints the DATABASE_URL to use
//   npx tsx scripts/dev-postgres.ts stop
//   npx tsx scripts/dev-postgres.ts status
//
// In CI, don't use this — GitHub Actions has a postgres service, which is fewer
// moving parts and the same server.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PG_VERSION = "16.4.0";
const ARCH = process.arch === "arm64" ? "arm64v8" : "amd64";
const JAR = `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-${ARCH}/${PG_VERSION}/embedded-postgres-binaries-linux-${ARCH}-${PG_VERSION}.jar`;

const ROOT = resolve(process.cwd(), ".rivo");
const HOME = join(ROOT, "pg");
const DATA = join(ROOT, "pgdata");
const PORT = Number(process.env.RIVO_DEV_PG_PORT ?? 55432);
const USER = "rivo";
const DB = "rivo";
export const devDatabaseUrl = (): string => `postgres://${USER}@127.0.0.1:${PORT}/${DB}`;

const env = { ...process.env, LD_LIBRARY_PATH: join(HOME, "lib") };
const bin = (name: string): string => join(HOME, "bin", name);

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): void {
  const r = spawnSync(cmd, args, { env, stdio: opts.quiet ? "pipe" : "inherit" });
  if (r.status !== 0) {
    const detail = opts.quiet ? `\n${r.stderr?.toString() ?? ""}` : "";
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}${detail}`);
  }
}

function download(): void {
  if (existsSync(bin("postgres"))) return;
  if (process.platform !== "linux") {
    throw new Error(
      `dev-postgres only bundles linux binaries; on ${process.platform} install PostgreSQL yourself ` +
        `and set DATABASE_URL, or run one in Docker.`,
    );
  }
  mkdirSync(HOME, { recursive: true });
  const jar = join(ROOT, "pg.jar");
  console.log(`fetching PostgreSQL ${PG_VERSION} (${ARCH})…`);
  execFileSync("curl", ["-sSL", "-o", jar, JAR], { stdio: "inherit" });
  // The jar is a zip holding one .txz of the whole installation.
  run("unzip", ["-o", "-q", jar, "-d", HOME], { quiet: true });
  const tarball = join(HOME, `postgres-linux-${process.arch === "arm64" ? "arm_64" : "x86_64"}.txz`);
  run("tar", ["xf", tarball, "-C", HOME]);
  rmSync(jar, { force: true });
  console.log(`installed to ${HOME}`);
}

function running(): boolean {
  const r = spawnSync(bin("pg_ctl"), ["-D", DATA, "status"], { env, stdio: "pipe" });
  return r.status === 0;
}

function start(): void {
  download();
  if (!existsSync(join(DATA, "PG_VERSION"))) {
    console.log("initialising cluster…");
    run(bin("initdb"), ["-D", DATA, "-U", USER, "--auth=trust", "-E", "UTF8"], { quiet: true });
  }
  if (running()) {
    console.log(`already running on ${PORT}`);
  } else {
    // Loopback only, and no unix socket: the socket path under a sandboxed temp
    // directory routinely exceeds the 107-byte limit postgres enforces, and TCP
    // on 127.0.0.1 is what the connection string uses anyway.
    run(bin("pg_ctl"), [
      "-D", DATA,
      "-o", `-p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`,
      "-l", join(ROOT, "pg.log"),
      "-w", "start",
    ]);
  }
  // `createdb` is not in the slim binary set, so the database is created through
  // the driver the application already depends on.
  void ensureDatabase();
}

async function ensureDatabase(): Promise<void> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: `postgres://${USER}@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  const { rows } = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB]);
  if (rows.length === 0) await c.query(`CREATE DATABASE ${DB}`);
  await c.end();
  console.log("");
  console.log(`PostgreSQL ${PG_VERSION} on 127.0.0.1:${PORT}`);
  console.log("");
  console.log(`  export DATABASE_URL="${devDatabaseUrl()}"`);
  console.log(`  npm run db:migrate`);
  console.log("");
}

function stop(): void {
  if (!existsSync(bin("pg_ctl")) || !running()) return console.log("not running");
  run(bin("pg_ctl"), ["-D", DATA, "-m", "fast", "-w", "stop"]);
}

function status(): void {
  if (!existsSync(bin("pg_ctl"))) return console.log("not installed — run `start`");
  console.log(running() ? `running on ${PORT} — ${devDatabaseUrl()}` : "stopped");
}

function reset(): void {
  stop();
  rmSync(DATA, { recursive: true, force: true });
  console.log(`removed ${DATA}`);
}

const cmd = process.argv[2] ?? "start";
try {
  if (cmd === "start") start();
  else if (cmd === "stop") stop();
  else if (cmd === "status") status();
  else if (cmd === "reset") reset();
  else if (cmd === "url") console.log(devDatabaseUrl());
  else {
    console.error(`unknown command "${cmd}". Use start | stop | status | reset | url.`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  if (existsSync(join(ROOT, "pg.log"))) console.error(readFileSync(join(ROOT, "pg.log"), "utf8").split("\n").slice(-10).join("\n"));
  process.exitCode = 1;
}
