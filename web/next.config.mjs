import { existsSync, readFileSync } from "node:fs";

/**
 * Put the repository's `.env` into the build's environment.
 *
 * Next reads `.env` from ITS OWN directory. Rivo's lives at the repository root,
 * because the worker and the CLI read the same file — there is one deployment's
 * worth of configuration and it belongs in one place.
 *
 * This is the ONLY place it is loaded, and it has to be: `NEXT_PUBLIC_*` values
 * are substituted into the client bundle while this config is being evaluated,
 * so anything running later is too late for the BROWSER. Without this, the
 * failure is the nastiest shape available — the server believed Privy was
 * configured and rendered a sign-in, while the client bundle had an empty app id
 * baked in, so the page fell back to "not configured" the moment it hydrated.
 *
 * There used to be a second loader, `instrumentation.ts`, doing the same job one
 * step later. It was redundant — this runs first and covers the server process
 * as well — and it cost more than it did: Next compiles instrumentation for
 * every runtime it might register in, so `import("@rivo/core/env.js")` dragged
 * `node:fs` into a compilation that cannot resolve it. In the production build
 * that pass is dropped and nothing shows. Under `next dev --webpack` it is not,
 * and EVERY route answered 500 with a bundler error — including routes that
 * never open a file, and including the whole app, which is what README §11 tells
 * a reader to run. Deleting it fixes `npm run dev:web` and leaves one loader.
 *
 * Never overwrites. On Vercel the platform has already set these and there is no
 * `.env` in the deployment at all, so this does nothing there.
 */
function loadRepoEnv() {
  const path = new URL("../.env", import.meta.url).pathname;
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadRepoEnv();

/** @type {import('next').NextConfig} */
const config = {
  // The web app imports the engine's types and the durable layer straight from
  // `src/`, rather than through a published package. There is one definition of
  // a portfolio policy, one of a decision record, and one set of SQL — which is
  // the entire reason this is a workspace and not two repositories.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,

  // The migrations are DATA the health check reads at runtime, and nothing
  // imports them.
  //
  // `pending()` compares the .sql files on disk against the rows in
  // schema_migrations, so it calls readdirSync on src/db/migrations. Next traces
  // what a route imports, not what it opens, so those files were left out of the
  // serverless bundle and /api/health answered 503 with "the database did not
  // answer" — while the database was answering perfectly. The real error was
  // ENOENT on a directory, three layers away from the message.
  //
  // Listing them here is the narrow fix. The alternative, compiling the SQL into
  // the bundle, would give the web tier its own copy of the schema and a second
  // place for it to drift from the worker's.
  //
  // The evidence artefacts are the same shape of bug and it had already shipped:
  // /api/agents opens docs/evidence/alpha-research.json, nothing imports it, so
  // it was traced out of the bundle and the route answered `research: null` in
  // production. Locally every fold rendered; on Vercel the fold table, the edge
  // buckets and the gate's reasons were empty dashes — the working behind a
  // verdict, missing on the one deployment anybody would read it on.
  outputFileTracingIncludes: {
    "/api/health": ["../src/db/migrations/**"],
    "/api/agents": ["../docs/evidence/*.json"],
    "/api/evidence": ["../docs/evidence/*.json"],
    "/api/calibration": ["../docs/evidence/*.json"],
  },

  webpack: (cfg) => {
    // The engine is NodeNext ESM: its relative imports carry `.js` extensions
    // that resolve to `.ts` on disk. Webpack needs telling, or every shared
    // import fails to resolve with a message that names a `.js` file nobody
    // wrote.
    //
    // This is why the build passes `--webpack` explicitly (see package.json).
    // Next 16 defaults to Turbopack, which has no equivalent of `extensionAlias`
    // and cannot resolve those imports — measured, not assumed: switching to it
    // fails on every `@rivo/*` import in the app. The alternative would be to
    // rewrite seventeen thousand lines of engine imports to suit a bundler that
    // only the web tier uses, which is the wrong way round.
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return cfg;
  },
};

export default config;
