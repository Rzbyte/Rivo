// Read `.env` into the process, once.
//
// This exists because its absence was a silent, total failure: nothing in Rivo
// loaded `.env`, so `PRIVATE_KEY` was never visible to the code that decides
// whether live trading is possible. The runtime dutifully reported
// "no funded PRIVATE_KEY — staying dry" while sitting next to a `.env`
// containing exactly that. `ec-core` has its own loader, but it runs far too
// late: the decision to construct a LiveExecutor at all is made before the SDK
// is ever imported.
//
// Deliberately dependency-free and non-destructive. A variable already present
// in the real environment always wins, so `DRY_RUN=false npm start` behaves the
// way anyone would expect regardless of what the file says.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

let loaded = false;

/** Parse a dotenv file. Handles `export`, quotes, inline comments, and blanks. */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let value = (m[2] ?? "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
    } else {
      // Strip an inline comment, but only outside quotes — a value like
      // `0x1234 # my key` should lose the note, not the key.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Find `.env`, starting at `dir` and walking up.
 *
 * A single directory was enough while everything ran from the repository root.
 * It stopped being enough the moment the web app existed: Next.js runs with its
 * own directory as the cwd, so it looked for `web/.env`, found nothing, and
 * reported "no DATABASE_URL configured" on a machine whose `.env` had one — with
 * nothing anywhere pointing at the reason.
 *
 * A monorepo has one `.env` at its root, so walking up is the behaviour that
 * matches how people actually arrange these. Bounded to six levels so a process
 * started somewhere unexpected cannot wander into a home directory and adopt a
 * stranger's file.
 *
 * An absolute `RIVO_ENV_FILE` is taken literally and never searched for.
 */
export function findEnvFile(dir = process.cwd()): string | null {
  const name = process.env.RIVO_ENV_FILE ?? ".env";
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  let at = resolve(dir);
  for (let up = 0; up < 6; up++) {
    const candidate = resolve(at, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) break; // filesystem root
    at = parent;
  }
  return null;
}

/**
 * Load `.env` if one can be found at or above `dir`. Idempotent, and never
 * overwrites a variable that is already set.
 */
export function loadEnv(dir = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  const path = findEnvFile(dir);
  if (path === null) return;
  try {
    for (const [k, v] of Object.entries(parse(readFileSync(path, "utf8")))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // A malformed .env should not take the process down; the doctor reports
    // what is actually missing far more usefully than a parse error would.
  }
}
